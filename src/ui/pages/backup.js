/** Backup, ripristino, backup automatico, esportazione dell'elenco, spazio occupato (F11, F35–F40). */
import { h, t, clear, icon, toast, modal, confirmDialog, saveBlob, progressDialog } from "../lib.js";
import { S, live, mine, others, changed, setSettings, rerender } from "../state.js";
import * as archive from "../../shared/archive.js";
import * as db from "../../shared/db.js";
import { exportArchive, importArchive, readBackup } from "../../shared/backup.js";
import { backupDue } from "../../shared/model.js";
import { fmtDate, fmtBytes } from "../../shared/util.js";
import { exportTable } from "./list.js";

const hasFolderApi = () => typeof window.showDirectoryPicker === "function";

async function writeToFolder(blob, name, keep) {
  const dir = await db.getMeta("backupDir", null);
  if (!dir) throw new Error("Nessuna cartella scelta per il backup automatico.");
  if ((await dir.queryPermission({ mode: "readwrite" })) !== "granted") throw Object.assign(new Error("Il browser chiede di nuovo il permesso per la cartella dei backup."), { needsPermission: true });
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(blob);
  await w.close();
  const old = [];
  for await (const [n, entry] of dir.entries()) if (entry.kind === "file" && /^Vintory-backup-.*\.zip$/.test(n)) old.push(n);
  for (const n of old.sort().slice(0, Math.max(0, old.length - keep))) await dir.removeEntry(n).catch(() => {});
}

async function writeToDownloads(blob, name, keep) {
  const url = URL.createObjectURL(blob);
  try {
    const id = await chrome.downloads.download({ url, filename: `Vintory/backup/${name}`, saveAs: false, conflictAction: "uniquify" });
    const ids = [...(S.settings.backup.downloadIds || []), id];
    for (const oldId of ids.slice(0, Math.max(0, ids.length - keep))) { await chrome.downloads.removeFile(oldId).catch(() => {}); await chrome.downloads.erase({ id: oldId }).catch(() => {}); }
    await setSettings({ backup: { downloadIds: ids.slice(-keep) } });
  } finally { setTimeout(() => URL.revokeObjectURL(url), 120_000); }
}

/** Crea il backup completo e lo consegna: download manuale, cartella Download o cartella scelta. */
export async function runBackup({ target = "manual", quiet = false } = {}) {
  const p = quiet ? null : progressDialog(t("Creo il backup"), t("Raccolgo annunci e foto…"));
  try {
    const r = await exportArchive({ settings: S.settings, onProgress: ({ done, total }) => p?.set(done, total, t("{a} di {b} annunci", { a: done, b: total })) });
    const keep = Math.max(1, S.settings.backup.keep || 5);
    if (target === "folder") await writeToFolder(r.blob, r.name, keep);
    else if (target === "downloads") await writeToDownloads(r.blob, r.name, keep);
    else saveBlob(r.blob, r.name);
    const now = Date.now();
    await setSettings({ backup: { lastAt: now, lastName: r.name, ...(target !== "manual" ? { lastAutoAt: now } : {}) } });
    return r;
  } finally { p?.close(); }
}

/** All'apertura della dashboard: se il backup automatico è scaduto, lo esegue. */
export async function maybeAutoBackup() {
  const b = S.settings.backup;
  if (b.auto === "off" || !live().length || !backupDue(b.lastAutoAt, b.autoDays)) return;
  try {
    const r = await runBackup({ target: b.auto, quiet: true });
    toast(t("Backup automatico creato: {n}", { n: r.name }), "good");
  } catch (e) {
    toast(e.needsPermission ? t("Backup automatico: il browser chiede di nuovo il permesso per la cartella. Apri Backup e premi «Esegui ora».") : t("Backup automatico non riuscito: {e}", { e: e.message }), "bad");
  }
}

async function restoreFlow(file) {
  let info;
  try { info = await readBackup(file); } catch (e) { toast(e.message, "bad"); return; }
  let mode = "merge";
  const radio = (value, label, hint) => h("label", { class: "check radio" }, h("input", { type: "radio", name: "mode", value, checked: mode === value, onChange: () => { mode = value; } }), h("span", null, h("strong", null, label), h("div", { class: "small muted" }, hint)));
  modal({
    title: t("Importa backup"),
    body: h("div", { class: "stack" },
      h("div", { class: "note" }, t("Backup del {d} · Vintory {v} · {n} annunci · {p} foto", { d: fmtDate(Date.parse(info.summary.createdAt), true), v: info.summary.app || "?", n: info.summary.listings, p: info.summary.photos })),
      info.summary.photosIncluded ? null : h("div", { class: "note warn" }, t("È un file solo dati (JSON): gli annunci tornano senza foto.")),
      radio("merge", t("Unisci all'archivio"), t("Aggiunge gli annunci che mancano. Quelli già presenti (stesso ID Vinted) restano come sono: nessun doppione.")),
      radio("replace", t("Sostituisci l'archivio"), t("Svuota l'archivio attuale e lo ricrea dal backup. Da usare su una nuova installazione."))),
    actions: [{ label: t("Annulla"), onClick: (c) => c() }, { id: "ok", label: t("Importa"), kind: "primary", onClick: async (c) => {
      if (mode === "replace" && live().length && !(await confirmDialog(t("Sostituire l'archivio?"), t("I {n} annunci presenti ora verranno eliminati e sostituiti dal backup. Non si può annullare.", { n: S.listings.length }), { okLabel: t("Sostituisci"), danger: true }))) return;
      c();
      const p = progressDialog(t("Importo il backup"), "");
      try {
        const r = await importArchive(file, { mode, onProgress: ({ done, total }) => p.set(done, total, t("{a} di {b} annunci", { a: done, b: total })) });
        if (r.settings?.customFields) await setSettings({ customFields: [...new Set([...(mode === "replace" ? [] : S.settings.customFields), ...r.settings.customFields.map(String)])].slice(0, 30) });
        await changed();
        toast(t("Importati {a} annunci con {p} foto · {s} già presenti{m}", { a: r.added, p: r.photos, s: r.skipped, m: r.photosMissing ? ` · ${t("{n} foto non incluse", { n: r.photosMissing })}` : "" }), "good", 9000);
      } catch (e) { toast(e.message, "bad"); } finally { p.close(); }
    } }],
  });
}

export async function renderBackup(main) {
  const b = S.settings.backup;
  const info = await archive.storageInfo();
  const due = live().length > 0 && backupDue(b.lastAt, b.remindDays);
  const dir = await db.getMeta("backupDir", null);
  const file = h("input", { type: "file", accept: ".zip,.json,application/zip,application/json", id: "restore-file", class: "hidden", onChange: (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) restoreFlow(f); } });
  const sel = (value, options, onChange, label) => h("select", { class: "input", style: { width: "auto" }, "aria-label": label, onChange: (e) => onChange(e.target.value) }, options.map(([v, lab]) => h("option", { value: v, selected: String(value) === String(v) }, lab)));
  const save = async (patch) => { await setSettings({ backup: patch }); rerender(); };

  clear(main).append(
    h("div", { class: "page-head" }, h("div", null, h("h1", null, t("Backup e ripristino")), h("span", { class: "muted" }, t("L'archivio vive dentro il browser: se rimuovi l'estensione viene cancellato. Il backup è la tua copia di sicurezza.")))),
    due ? h("div", { class: "note warn" }, b.lastAt ? t("L'ultimo backup è del {d}: è ora di rifarlo.", { d: fmtDate(b.lastAt) }) : t("Non hai ancora fatto un backup.")) : null,
    h("section", { class: "card stack" }, h("h2", null, t("Backup completo")),
      h("p", { class: "muted" }, t("Uno ZIP con tutti gli annunci, le foto, le versioni, le collezioni e i modelli. Si ripristina su qualsiasi installazione di Vintory.")),
      h("div", { class: "row" },
        h("button", { class: "btn primary", type: "button", id: "backup-zip", disabled: !S.listings.length, onClick: async () => { try { const r = await runBackup(); toast(t("Backup creato: {n} annunci, {p} foto.", { n: r.counts.listings, p: r.counts.photos }), "good"); rerender(); } catch (e) { toast(e.message, "bad"); } } }, icon("download"), t("Crea backup (ZIP)")),
        h("button", { class: "btn", type: "button", id: "backup-json", disabled: !S.listings.length, onClick: async () => { try { const r = await exportArchive({ photos: false, settings: S.settings }); saveBlob(r.blob, r.name); } catch (e) { toast(e.message, "bad"); } } }, t("Solo dati, senza foto (JSON)"))),
      h("div", { class: "small muted" }, b.lastAt ? t("Ultimo backup: {d} ({n})", { d: fmtDate(b.lastAt, true), n: b.lastName || "" }) : t("Ultimo backup: mai"))),
    h("section", { class: "card stack" }, h("h2", null, t("Ripristina o importa un backup")),
      h("p", { class: "muted" }, t("Da un'altra installazione o da un backup precedente: ZIP completo o file JSON.")),
      h("div", { class: "row" }, file, h("button", { class: "btn", type: "button", onClick: () => file.click() }, icon("upload"), t("Scegli il file di backup…")))),
    h("section", { class: "card stack" }, h("h2", null, t("Promemoria")),
      h("div", { class: "row" }, t("Ricordami il backup"), sel(b.remindDays, [[0, t("mai")], [3, t("ogni 3 giorni")], [7, t("ogni settimana")], [14, t("ogni 2 settimane")], [30, t("ogni mese")]], (v) => save({ remindDays: Number(v) }), t("Frequenza del promemoria")))),
    h("section", { class: "card stack" }, h("h2", null, t("Backup automatico")),
      h("p", { class: "muted" }, t("Quando apri Vintory e il backup è scaduto, ne crea uno da solo. Tiene solo gli ultimi, per non riempire il disco.")),
      h("div", { class: "row" },
        sel(b.auto, [["off", t("Disattivato")], ["downloads", t("Nella cartella Download › Vintory › backup")], ...(hasFolderApi() ? [["folder", t("In una cartella scelta da me")]] : [])], (v) => save({ auto: v }), t("Backup automatico")),
        sel(b.autoDays, [[1, t("ogni giorno")], [3, t("ogni 3 giorni")], [7, t("ogni settimana")], [30, t("ogni mese")]], (v) => save({ autoDays: Number(v) }), t("Frequenza")),
        sel(b.keep, [[3, t("tieni gli ultimi 3")], [5, t("tieni gli ultimi 5")], [10, t("tieni gli ultimi 10")]], (v) => save({ keep: Number(v) }), t("Quanti tenerne"))),
      b.auto === "folder" ? h("div", { class: "row" }, h("button", { class: "btn", type: "button", onClick: async () => {
        try { const d = await window.showDirectoryPicker({ mode: "readwrite", id: "vintory-backup" }); await db.setMeta("backupDir", d); toast(t("Cartella scelta: {n}", { n: d.name }), "good"); rerender(); } catch (e) { if (e.name !== "AbortError") toast(e.message, "bad"); }
      } }, icon("folder"), dir ? t("Cambia cartella ({n})", { n: dir.name }) : t("Scegli la cartella…"))) : null,
      hasFolderApi() ? null : h("div", { class: "small muted" }, t("Questo browser non permette di scegliere una cartella (su Brave va attivata in brave://flags, «File System Access API»): il backup automatico usa la cartella Download.")),
      b.auto !== "off" ? h("div", { class: "row" }, h("button", { class: "btn", type: "button", disabled: !S.listings.length || (b.auto === "folder" && !dir), onClick: async () => {
        try {
          if (b.auto === "folder" && dir && (await dir.queryPermission({ mode: "readwrite" })) !== "granted" && (await dir.requestPermission({ mode: "readwrite" })) !== "granted") { toast(t("Permesso per la cartella non concesso."), "bad"); return; }
          const r = await runBackup({ target: b.auto });
          toast(t("Backup creato: {n}", { n: r.name }), "good"); rerender();
        } catch (e) { toast(e.message, "bad"); }
      } }, t("Esegui ora")), h("span", { class: "small muted" }, b.lastAutoAt ? t("Ultimo automatico: {d}", { d: fmtDate(b.lastAutoAt, true) }) : t("Ultimo automatico: mai"))) : null),
    h("section", { class: "card stack" }, h("h2", null, t("Esporta l'elenco")),
      h("p", { class: "muted" }, t("Una tabella degli annunci (senza foto) per Excel o altri programmi.")),
      h("div", { class: "row" },
        h("button", { class: "btn", type: "button", id: "csv-mine", onClick: () => exportTable(mine(), "csv") }, t("I miei · CSV")), h("button", { class: "btn", type: "button", id: "xlsx-mine", onClick: () => exportTable(mine(), "xlsx") }, t("I miei · Excel")),
        h("button", { class: "btn", type: "button", onClick: () => exportTable(others(), "csv") }, t("Non miei · CSV")), h("button", { class: "btn", type: "button", onClick: () => exportTable(live(), "xlsx") }, t("Tutti · Excel")))),
    h("section", { class: "card stack" }, h("h2", null, t("Spazio")),
      h("div", { class: "row" }, h("strong", { id: "usage" }, info.usage != null ? t("{a} occupati", { a: fmtBytes(info.usage) }) : t("Spazio non misurabile")), info.quota ? h("span", { class: "muted" }, t("su {q} disponibili", { q: fmtBytes(info.quota) })) : null),
      info.quota ? h("div", { class: "progress", role: "progressbar", "aria-label": t("Spazio occupato") }, h("i", { style: { width: `${Math.min(100, Math.round((info.usage / info.quota) * 100))}%` } })) : null,
      h("div", { class: "row" }, h("span", { class: `chip ${info.persisted ? "good" : "warn"}` }, info.persisted ? t("Archiviazione permanente attiva") : t("Archiviazione non permanente")),
        info.persisted ? null : h("button", { class: "btn sm", type: "button", onClick: async () => { const ok = await archive.requestPersistence(); toast(ok ? t("Archiviazione permanente attivata: il browser non libererà questo spazio da solo.") : t("Il browser non ha concesso l'archiviazione permanente. L'archivio resta comunque salvato: tieni un backup."), ok ? "good" : ""); rerender(); } }, t("Rendi permanente"))),
      h("div", { class: "small muted" }, t("«Permanente» significa che il browser non può cancellare l'archivio per fare spazio. Rimuovere l'estensione lo cancella comunque."))));
}
