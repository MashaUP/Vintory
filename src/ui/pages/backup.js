/** Backup, ripristino, backup automatico, esportazione dell'elenco, spazio occupato (F11, F35–F40). */
import { h, t, clear, icon, toast, modal, confirmDialog, saveBlob, progressDialog, copyText } from "../lib.js";
import { S, live, mine, others, changed, setSettings, rerender } from "../state.js";
import * as archive from "../../shared/archive.js";
import * as db from "../../shared/db.js";
import { exportArchive, importArchive, readBackup } from "../../shared/backup.js";
import { backupDue } from "../../shared/model.js";
import { fmtDate, fmtBytes, dayStamp } from "../../shared/util.js";
import { VERSION } from "../../shared/constants.js";
import * as drive from "../../shared/drive.js";
import { encryptBlob, decryptBlob } from "../../shared/crypto.js";
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

// ---------------------------------------------------------------- Google Drive

const PASS_KEY = "vy:drivePass";       // solo in questo browser, solo se l'utente lo chiede; mai nei backup
const rememberedPassword = async () => (await chrome.storage.local.get(PASS_KEY))[PASS_KEY] || null;
const deviceName = () => S.settings.drive.device || `${navigator.userAgentData?.platform || navigator.platform || "Computer"} · ${navigator.userAgentData?.brands?.find((b) => !/not.?a.?brand|chromium/i.test(b.brand))?.brand || "Chrome"}`;

/** Chiede la password dei backup su Drive (due volte se è nuova). Restituisce { password, remember } o null. */
function askPassword({ create = false, title = t("Password dei backup su Drive") } = {}) {
  return new Promise((resolve) => {
    let answer = null;
    const p1 = h("input", { class: "input", type: "password", id: "drive-pass", autocomplete: create ? "new-password" : "current-password", autofocus: true });
    const p2 = create ? h("input", { class: "input", type: "password", id: "drive-pass2", autocomplete: "new-password" }) : null;
    const rem = h("input", { type: "checkbox", id: "drive-remember", checked: true });
    const err = h("div", { class: "small", style: { color: "var(--bad)" } });
    const ok = (c) => {
      if (p1.value.length < 8) { err.textContent = t("Almeno 8 caratteri."); return; }
      if (create && p1.value !== p2.value) { err.textContent = t("Le due password non coincidono."); return; }
      answer = { password: p1.value, remember: rem.checked };
      c();
    };
    const m = modal({
      title,
      body: h("div", { class: "stack" },
        h("p", { class: "muted" }, create ? t("Con questa password Vintory cifra i backup prima di mandarli a Google. Senza di lei non si possono ripristinare: Vintory non la conosce e non può recuperarla. Scrivila in un posto sicuro.") : t("La password con cui hai creato i backup su Drive.")),
        h("label", { class: "field" }, t("Password"), p1),
        create ? h("label", { class: "field" }, t("Ripeti la password"), p2) : null,
        h("label", { class: "check" }, rem, t("Ricordala su questo computer (serve al backup automatico)")), err),
      onClose: () => resolve(answer),
      actions: [{ label: t("Annulla"), onClick: (c) => c() }, { id: "ok", label: t("Continua"), kind: "primary", onClick: ok }],
    });
    for (const el of [p1, p2]) el?.addEventListener("keydown", (e) => { if (e.key === "Enter") ok(m.close); });
  });
}

async function setPassword(create) {
  const a = await askPassword({ create });
  if (!a) return null;
  if (a.remember) await chrome.storage.local.set({ [PASS_KEY]: a.password }); else await chrome.storage.local.remove(PASS_KEY);
  await setSettings({ drive: { hasPassword: true } });
  return a.password;
}

/** Backup completo, cifrato, nella cartella nascosta di Vintory sul Drive. */
export async function backupToDrive({ quiet = false, auto = false } = {}) {
  let password = await rememberedPassword();
  if (!password && !quiet) password = await setPassword(!S.settings.drive.hasPassword);
  if (!password) throw Object.assign(new Error(t("Serve la password dei backup su Drive.")), { needsPassword: true });
  const token = await drive.getToken({ interactive: !quiet });
  if (!token) throw Object.assign(new Error(t("Accedi di nuovo a Google in Backup › Google Drive.")), { needsLogin: true });
  const p = quiet ? null : progressDialog(t("Backup su Google Drive"), t("Raccolgo annunci e foto…"));
  try {
    const r = await exportArchive({ settings: S.settings, onProgress: ({ done, total }) => p?.set(done * 0.6, total, t("{a} di {b} annunci", { a: done, b: total })) });
    p?.set(60, 100, t("Cifro il backup…"));
    const blob = await encryptBlob(r.blob, password, { onProgress: ({ done, total }) => p?.set(60 + (done / total) * 10, 100, t("Cifro il backup…")) });
    const name = drive.backupName(dayStamp());
    await drive.uploadBackup(token, blob, name, { device: deviceName(), listings: r.counts.listings, photos: r.counts.photos, app: VERSION }, { onProgress: ({ done, total }) => p?.set(70 + (done / total) * 30, 100, t("Carico su Google Drive: {a} di {b}", { a: fmtBytes(done), b: fmtBytes(total) })) });
    await drive.prune(token, Math.max(1, S.settings.backup.keep || 5));
    const now = Date.now();
    await setSettings({ drive: { lastAt: now, lastName: name, lastSize: blob.size }, backup: { lastAt: now, lastName: name, ...(auto ? { lastAutoAt: now } : {}) } });
    return { name, size: blob.size, counts: r.counts };
  } finally { p?.close(); }
}

/** Ripristino da un backup su Drive: scarica, decifra con la password, poi la solita scelta Unisci / Sostituisci. */
export async function restoreFromDrive(f) {
  const token = await drive.getToken({ interactive: true });
  const p = progressDialog(t("Scarico da Google Drive"), "");
  let blob;
  try {
    blob = await drive.downloadBackup(token, f.id, { onProgress: ({ done, total }) => p.set(done, total || f.size || done, t("{a} di {b}", { a: fmtBytes(done), b: fmtBytes(total || f.size) })) });
  } finally { p.close(); }
  let zip = null;
  for (let tries = 0; !zip && tries < 3; tries++) {
    let password = tries === 0 ? await rememberedPassword() : null;
    if (!password) password = (await askPassword({ title: t("Password del backup") }))?.password;
    if (!password) return;
    const d = progressDialog(t("Decifro il backup"), "");
    try { zip = await decryptBlob(blob, password, { onProgress: ({ done, total }) => d.set(done, total) }); } catch (e) { toast(e.message, "bad"); } finally { d.close(); }
    if (zip && !(await rememberedPassword())) { await chrome.storage.local.set({ [PASS_KEY]: password }); await setSettings({ drive: { hasPassword: true } }); }
  }
  if (zip) await restoreFlow(new File([zip], f.name.replace(/\.vyenc$/, ".zip"), { type: "application/zip" }));
}

async function driveList(box) {
  box.replaceChildren(h("p", { class: "muted small" }, t("Leggo i backup su Drive…")));
  try {
    const token = await drive.getToken({ interactive: false });
    if (!token) { box.replaceChildren(h("p", { class: "muted small" }, t("Accedi con Google per vedere i backup."))); return; }
    const files = await drive.listBackups(token);
    if (!files.length) { box.replaceChildren(h("p", { class: "muted small", id: "drive-empty" }, t("Nessun backup di Vintory su questo Drive."))); return; }
    box.replaceChildren(h("table", { class: "table", id: "drive-files" },
      h("thead", null, h("tr", null, h("th", null, t("Data")), h("th", null, t("Da")), h("th", { class: "num" }, t("Annunci")), h("th", { class: "num" }, t("Dimensione")), h("th", null, ""))),
      h("tbody", null, files.map((f) => h("tr", null,
        h("td", null, fmtDate(f.createdAt, true)), h("td", { class: "small" }, f.props.device || "—"),
        h("td", { class: "num" }, f.props.listings || "—"), h("td", { class: "num" }, fmtBytes(f.size)),
        h("td", { class: "row", style: { justifyContent: "flex-end" } },
          h("button", { class: "btn sm", type: "button", dataset: { restore: f.id }, onClick: () => restoreFromDrive(f).catch((e) => toast(e.message, "bad")) }, t("Ripristina")),
          h("button", { class: "btn sm ghost", type: "button", "aria-label": t("Elimina"), onClick: async () => {
            if (!(await confirmDialog(t("Eliminare il backup?"), t("Il backup del {d} verrà tolto dal tuo Google Drive.", { d: fmtDate(f.createdAt, true) }), { okLabel: t("Elimina"), danger: true }))) return;
            try { await drive.deleteFile(await drive.getToken(), f.id); driveList(box); } catch (e) { toast(e.message, "bad"); }
          } }, icon("trash", 15))))))));
  } catch (e) {
    box.replaceChildren(h("p", { class: "small", style: { color: "var(--bad)" } }, e.message));
  }
}

function driveCard() {
  const d = S.settings.drive;
  const hasId = drive.validClientId(d.clientId);
  const list = h("div", { id: "drive-list" });
  const idInput = h("input", { class: "input", id: "drive-client", value: d.clientId || "", placeholder: "xxxx.apps.googleusercontent.com", autocomplete: "off", spellcheck: "false" });
  const card = h("section", { class: "card stack", id: "drive-card" }, h("h2", null, t("Google Drive")),
    h("p", { class: "muted" }, t("Backup cifrati con una tua password nella cartella nascosta di Vintory sul tuo Google Drive. Vintory vede solo i propri file e Google non può leggerne il contenuto. Così l'archivio non si perde se rimuovi l'estensione o cambi computer, e lo ripristini da qui su un'altra installazione.")),
    h("label", { class: "field" }, t("Client ID Google (tipo «Applicazione web»)"), h("div", { class: "row" }, h("div", { class: "grow" }, idInput),
      h("button", { class: "btn", type: "button", id: "drive-client-save", onClick: async () => {
        const v = idInput.value.trim();
        if (v && !drive.validClientId(v)) { toast(t("Il Client ID finisce con «.apps.googleusercontent.com»."), "bad"); return; }
        await drive.signOut();
        await setSettings({ drive: { clientId: v } });
        rerender();
      } }, t("Salva")))),
    h("details", { open: !hasId }, h("summary", null, t("Come ottenere il Client ID (una volta sola)")),
      h("ol", { class: "small", style: { paddingLeft: "18px" } },
        h("li", null, t("Se l'hai già creato per BingeMap puoi riusarlo: salta al punto 4.")),
        h("li", null, t("Apri Google Cloud › API e servizi e attiva «Google Drive API»: "), h("a", { href: "https://console.cloud.google.com/apis/library/drive.googleapis.com", target: "_blank", rel: "noopener" }, "console.cloud.google.com")),
        h("li", null, t("Credenziali › Crea credenziali › ID client OAuth › tipo «Applicazione web»: "), h("a", { href: "https://console.cloud.google.com/apis/credentials", target: "_blank", rel: "noopener" }, t("credenziali"))),
        h("li", null, t("In «URI di reindirizzamento autorizzati» aggiungi questo indirizzo, poi salva e copia il Client ID qui sopra:")),
        h("div", { class: "row" }, h("code", { class: "mono", id: "drive-redirect" }, drive.redirectUrl()), h("button", { class: "btn sm", type: "button", onClick: () => copyText(drive.redirectUrl()) }, icon("copy", 14), t("Copia"))),
        h("li", null, t("Su un altro computer l'indirizzo cambia: aggiungi anche quello allo stesso Client ID prima di ripristinare.")))),
    hasId ? h("div", { class: "row", id: "drive-account" }) : null,
    hasId ? list : null);
  if (hasId) {
    const acc = card.querySelector("#drive-account");
    drive.isConnected().then(async (on) => {
      const remembered = Boolean(await rememberedPassword());
      acc.append(
        on ? h("span", { class: "chip good" }, t("Collegato a Google")) : h("button", { class: "btn", type: "button", id: "drive-login", onClick: async () => { try { await drive.getToken({ interactive: true }); toast(t("Collegato a Google Drive."), "good"); rerender(); } catch (e) { toast(e.message, "bad"); } } }, t("Accedi con Google")),
        h("button", { class: "btn primary", type: "button", id: "drive-backup", disabled: !S.listings.length, onClick: async () => { try { const r = await backupToDrive(); toast(t("Backup su Drive: {n} annunci, {s}.", { n: r.counts.listings, s: fmtBytes(r.size) }), "good"); rerender(); } catch (e) { if (!e.needsPassword) toast(e.message, "bad"); } } }, icon("upload"), t("Backup su Drive ora")),
        h("button", { class: "btn", type: "button", id: "drive-pass-set", onClick: async () => { if (await setPassword(true)) { toast(t("Password salvata. Vale per i prossimi backup: quelli già su Drive si aprono con la password di allora."), "good", 8000); rerender(); } } }, d.hasPassword ? t("Cambia password") : t("Imposta la password")),
        h("span", { class: "small muted" }, [remembered ? t("Password ricordata su questo computer.") : d.hasPassword ? t("La password viene chiesta a ogni backup.") : t("Password non ancora impostata."), d.lastAt ? ` ${t("Ultimo backup su Drive: {d}", { d: fmtDate(d.lastAt, true) })}.` : ""].join("")),
        on ? h("button", { class: "btn sm ghost", type: "button", onClick: async () => { await drive.signOut(); rerender(); } }, t("Esci")) : null);
      driveList(list);
    });
  }
  return card;
}

/** All'apertura della dashboard: se il backup automatico è scaduto, lo esegue. */
export async function maybeAutoBackup() {
  const b = S.settings.backup;
  if (b.auto === "off" || !live().length || !backupDue(b.lastAutoAt, b.autoDays)) return;
  try {
    if (b.auto === "drive") {
      const r = await backupToDrive({ quiet: true, auto: true });
      toast(t("Backup automatico su Google Drive: {n} annunci.", { n: r.counts.listings }), "good");
      return;
    }
    const r = await runBackup({ target: b.auto, quiet: true });
    toast(t("Backup automatico creato: {n}", { n: r.name }), "good");
  } catch (e) {
    toast(e.needsPermission ? t("Backup automatico: il browser chiede di nuovo il permesso per la cartella. Apri Backup e premi «Esegui ora».") : e.needsLogin || e.needsPassword ? t("Backup automatico su Drive non fatto: {e}", { e: e.message }) : t("Backup automatico non riuscito: {e}", { e: e.message }), "bad", 10000);
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
    driveCard(),
    h("section", { class: "card stack" }, h("h2", null, t("Ripristina o importa un backup")),
      h("p", { class: "muted" }, t("Da un'altra installazione o da un backup precedente: ZIP completo o file JSON.")),
      h("div", { class: "row" }, file, h("button", { class: "btn", type: "button", onClick: () => file.click() }, icon("upload"), t("Scegli il file di backup…")))),
    h("section", { class: "card stack" }, h("h2", null, t("Promemoria")),
      h("div", { class: "row" }, t("Ricordami il backup"), sel(b.remindDays, [[0, t("mai")], [3, t("ogni 3 giorni")], [7, t("ogni settimana")], [14, t("ogni 2 settimane")], [30, t("ogni mese")]], (v) => save({ remindDays: Number(v) }), t("Frequenza del promemoria")))),
    h("section", { class: "card stack" }, h("h2", null, t("Backup automatico")),
      h("p", { class: "muted" }, t("Quando apri Vintory e il backup è scaduto, ne crea uno da solo. Tiene solo gli ultimi, per non riempire il disco.")),
      h("div", { class: "row" },
        sel(b.auto, [["off", t("Disattivato")], ["downloads", t("Nella cartella Download › Vintory › backup")], ...(hasFolderApi() ? [["folder", t("In una cartella scelta da me")]] : []), ...(drive.validClientId(S.settings.drive.clientId) ? [["drive", t("Su Google Drive (cifrato)")]] : [])], (v) => save({ auto: v }), t("Backup automatico")),
        sel(b.autoDays, [[1, t("ogni giorno")], [3, t("ogni 3 giorni")], [7, t("ogni settimana")], [30, t("ogni mese")]], (v) => save({ autoDays: Number(v) }), t("Frequenza")),
        sel(b.keep, [[3, t("tieni gli ultimi 3")], [5, t("tieni gli ultimi 5")], [10, t("tieni gli ultimi 10")]], (v) => save({ keep: Number(v) }), t("Quanti tenerne"))),
      b.auto === "folder" ? h("div", { class: "row" }, h("button", { class: "btn", type: "button", onClick: async () => {
        try { const d = await window.showDirectoryPicker({ mode: "readwrite", id: "vintory-backup" }); await db.setMeta("backupDir", d); toast(t("Cartella scelta: {n}", { n: d.name }), "good"); rerender(); } catch (e) { if (e.name !== "AbortError") toast(e.message, "bad"); }
      } }, icon("folder"), dir ? t("Cambia cartella ({n})", { n: dir.name }) : t("Scegli la cartella…"))) : null,
      b.auto === "drive" ? h("div", { class: "small muted" }, t("Per farlo da solo serve la password ricordata su questo computer e l'accesso a Google ancora valido nel browser: altrimenti Vintory ti avvisa.")) : null,
      hasFolderApi() ? null : h("div", { class: "small muted" }, t("Questo browser non permette di scegliere una cartella (su Brave va attivata in brave://flags, «File System Access API»): il backup automatico usa la cartella Download.")),
      b.auto !== "off" ? h("div", { class: "row" }, h("button", { class: "btn", type: "button", disabled: !S.listings.length || (b.auto === "folder" && !dir), onClick: async () => {
        try {
          if (b.auto === "folder" && dir && (await dir.queryPermission({ mode: "readwrite" })) !== "granted" && (await dir.requestPermission({ mode: "readwrite" })) !== "granted") { toast(t("Permesso per la cartella non concesso."), "bad"); return; }
          const r = b.auto === "drive" ? await backupToDrive({ auto: true }) : await runBackup({ target: b.auto });
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
