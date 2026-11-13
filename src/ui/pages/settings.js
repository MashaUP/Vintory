/** Impostazioni (F50) e Salute: aggiornamenti, collegamenti, integrità delle foto (F21), diagnostica. */
import { h, t, clear, icon, toast, confirmDialog, copyText, applyTheme, safeUrl, rpc, progressDialog, LANGS, setLang } from "../lib.js";
import { S, changed, setSettings, rerender } from "../state.js";
import * as archive from "../../shared/archive.js";
import { getState, setState } from "../../shared/store.js";
import { VERSION, REPO } from "../../shared/constants.js";
import { fmtDate, fmtBytes } from "../../shared/util.js";
import { showUpdate, installNow } from "../update-ui.js";
import { fillMissing, missingCategory } from "../fill.js";

export async function renderSettings(main) {
  const s = S.settings;
  const update = await getState("update", null);
  const toggle = (label, hint, checked, onChange) => h("label", { class: "check setting" }, h("input", { type: "checkbox", checked, onChange: (e) => onChange(e.target.checked) }), h("span", null, h("strong", null, label), hint ? h("div", { class: "small muted" }, hint) : null));
  const fieldName = h("input", { class: "input", placeholder: t("Nome del nuovo campo"), maxlength: "40", "aria-label": t("Nuovo campo personalizzato") });
  const addField = async () => {
    const n = fieldName.value.trim();
    if (!n || s.customFields.includes(n)) return;
    await setSettings({ customFields: [...s.customFields, n].slice(0, 30) });
    rerender();
  };
  fieldName.addEventListener("keydown", (e) => { if (e.key === "Enter") addField(); });
  const repo = h("input", { class: "input", value: s.updates.repo || REPO, "aria-label": t("Repository degli aggiornamenti"), style: { maxWidth: "280px" } });
  const links = S.links || {};

  clear(main).append(
    h("div", { class: "page-head" }, h("div", null, h("h1", null, t("Impostazioni")), h("span", { class: "muted" }, t("Vintory {v}", { v: VERSION })))),
    h("section", { class: "card stack" }, h("h2", null, t("Aspetto e lingua")),
      h("div", { class: "row" }, t("Tema"), h("select", { class: "input", id: "theme", style: { width: "auto" }, "aria-label": t("Tema"), onChange: async (e) => { await setSettings({ theme: e.target.value }); applyTheme(e.target.value); } },
        [["auto", t("Come il sistema")], ["light", t("Chiaro")], ["dark", t("Scuro")]].map(([v, lab]) => h("option", { value: v, selected: s.theme === v }, lab))),
      t("Lingua"), h("select", { class: "input", style: { width: "auto" }, "aria-label": t("Lingua"), onChange: async (e) => { await setSettings({ lang: e.target.value }); setLang(e.target.value); rerender(); } }, LANGS.map((l) => h("option", { value: l.id, selected: s.lang === l.id }, l.label)))),
      h("div", { class: "small muted" }, t("L'interfaccia è predisposta per altre lingue: per ora c'è l'italiano."))),
    h("section", { class: "card stack" }, h("h2", null, t("Salvataggio")),
      toggle(t("Pulsante «Salva in Vintory» nelle pagine di Vinted"), t("In basso a sinistra, sugli annunci e sugli armadi."), s.pageButton, (v) => setSettings({ pageButton: v })),
      toggle(t("Confronta con l'archivio quando apro un annuncio salvato"), t("Una lettura in più su Vinted, al massimo ogni 10 minuti per annuncio: serve al segnale «Modificato su Vinted»."), s.checkChanges, (v) => setSettings({ checkChanges: v })),
      toggle(t("Importa solo gli annunci attivi"), t("Nell'anteprima di importazione nasconde venduti, riservati e nascosti."), s.onlyActive, (v) => setSettings({ onlyActive: v })),
      h("div", { class: "row" }, t("Pausa tra un annuncio e l'altro nell'importazione"), h("select", { class: "input", style: { width: "auto" }, "aria-label": t("Pausa nell'importazione"), onChange: (e) => { const [min, max] = e.target.value.split("-").map(Number); setSettings({ importDelay: { min, max } }); } },
        [["1200-2500", t("Normale (1–2,5 s)")], ["2500-5000", t("Tranquilla (2,5–5 s)")], ["5000-9000", t("Lenta (5–9 s)")]].map(([v, lab]) => h("option", { value: v, selected: `${s.importDelay.min}-${s.importDelay.max}` === v }, lab))))),
    h("section", { class: "card stack" }, h("h2", null, t("Campi personalizzati")),
      h("p", { class: "muted" }, t("Compaiono in «Note e campi» di ogni annuncio e nelle esportazioni CSV/Excel.")),
      h("div", { class: "row" }, s.customFields.map((n) => h("span", { class: "chip big" }, n, h("button", { class: "x", type: "button", "aria-label": t("Togli il campo {n}", { n }), onClick: async () => { await setSettings({ customFields: s.customFields.filter((x) => x !== n) }); rerender(); } }, icon("close", 12))))),
      h("div", { class: "row" }, h("div", { style: { maxWidth: "280px" }, class: "grow" }, fieldName), h("button", { class: "btn", type: "button", onClick: addField }, icon("plus", 15), t("Aggiungi campo"))),
      h("div", { class: "small muted" }, t("Togliere un campo non cancella i valori già scritti negli annunci."))),
    h("section", { class: "card stack", id: "updates" }, h("h2", null, t("Aggiornamenti")),
      h("div", { class: "row" }, h("button", { class: "btn primary", type: "button", id: "check-update", onClick: async (e) => { e.currentTarget.disabled = true; try { const st = await rpc("update.check"); S.links = await rpc("links.get"); rerender(); showUpdate(st); } catch (err) { toast(err.message, "bad"); } } }, icon("refresh"), t("Cerca aggiornamento")),
        h("span", { class: "muted" }, update?.checkedAt ? (update.ok ? (update.available ? t("Disponibile la {v} · controllato il {d}", { v: update.latest, d: fmtDate(update.checkedAt, true) }) : t("Aggiornato · controllato il {d}", { d: fmtDate(update.checkedAt, true) })) : update.error) : t("Mai controllato"))),
      update?.available ? h("div", { class: "note good" }, t("È disponibile Vintory {v}.", { v: update.latest }), " ", h("a", { href: "#", onClick: (e) => { e.preventDefault(); showUpdate(update); } }, t("Scarica e installa"))) : null,
      h("div", { class: "row" }, h("button", { class: "btn", type: "button", id: "reload-ext", onClick: () => installNow() }, icon("refresh", 15), t("Installa l'aggiornamento (ricarica Vintory)")),
        h("span", { class: "small muted" }, t("Dopo aver estratto lo zip sopra la cartella di Vintory. Di solito il pulsante compare da solo nella barra laterale e nel popup."))),
      toggle(t("Controlla da solo ogni 12 ore"), t("Una notifica, una volta sola, quando esce una versione nuova."), s.updates.auto, (v) => setSettings({ updates: { auto: v } })),
      h("details", null, h("summary", null, t("Avanzate")), h("div", { class: "row", style: { marginTop: "8px" } }, repo, h("button", { class: "btn sm", type: "button", onClick: async () => {
        if (!/^[\w.-]+\/[\w.-]+$/.test(repo.value.trim())) { toast(t("Formato: utente/repository"), "bad"); return; }
        await setSettings({ updates: { repo: repo.value.trim() } }); await setState("update", null); toast(t("Repository salvato."), "good");
      } }, t("Salva")), h("span", { class: "small muted" }, t("Da cambiare solo se il repository cambia nome."))))),
    h("section", { class: "card stack" }, h("h2", null, t("Sostieni e partecipa")),
      h("div", { class: "row" }, ["kofi", "discord", "github", "documentation", "changelog", "bugReport"].map((k) => { const u = safeUrl(links[k]?.url); return u ? h("a", { class: `btn${k === "kofi" ? " primary" : ""}`, href: u, target: "_blank", rel: "noopener", dataset: { link: k } }, links[k].label) : null; })),
      h("div", { class: "small muted" }, t("I collegamenti si aggiornano da soli dal repository: se l'invito Discord cambia, non serve una nuova versione."))),
    h("section", { class: "card stack" }, h("h2", null, t("Salute e diagnostica")),
      h("p", { class: "muted" }, t("Controllo delle foto, spazio, registro degli errori.")),
      h("div", { class: "row" }, h("a", { class: "btn", href: "#health" }, icon("shield"), t("Apri Salute")))));
}

export async function renderHealth(main) {
  const [counts, info, errors, update, account, probe] = await Promise.all([archive.counts(), archive.storageInfo(), getState("errors", []), getState("update", null), rpc("account.get").catch(() => ({})), getState("probe", null)]);
  const perms = await chrome.permissions.getAll();
  const reportBox = h("div", { id: "integrity" });
  const lines = () => [
    `Vintory ${VERSION}`, `Browser: ${navigator.userAgent}`,
    `Archivio: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(", ")}`,
    `Spazio: ${fmtBytes(info.usage)} su ${fmtBytes(info.quota)} · permanente: ${info.persisted}`,
    `Account Vinted rilevato: ${account?.userId ? "sì" : "no"}`,
    `Permessi: ${perms.permissions.join(", ")}`, `Domini: ${perms.origins.length}`,
    `Token CSRF: ${probe?.csrf || "mai cercato"}`,
    `Ultime letture da Vinted: ${probe ? Object.entries(probe.calls).map(([k, v]) => `${k} ${v.status || "-"} ${v.kind}${v.retried ? " (2° tentativo)" : ""}`).join(" · ") : "nessuna"}`,
    `Aggiornamenti: ${update ? (update.ok ? `ok, ultima ${update.latest}` : update.error) : "mai controllato"}`,
    `Errori recenti: ${errors.length}`, ...errors.slice(0, 20).map((e) => `- ${new Date(e.at).toISOString()} [${e.where}] ${e.message}`),
  ].join("\n");

  async function integrity(redownload) {
    const p = progressDialog(t("Controllo le foto"), "");
    try {
      const r = await archive.verifyIntegrity({ redownload, onProgress: ({ done, total }) => p.set(done, total, t("{a} di {b} annunci", { a: done, b: total })) });
      await changed({ silent: true });
      clear(reportBox).append(h("div", { class: `note ${r.missing + r.corrupt ? "warn" : "good"}`, id: "integrity-result" },
        t("{p} foto in {l} annunci · integre: {ok} · mancanti: {m} · rovinate: {c}{r}", { p: r.photos, l: r.listings, ok: r.ok, m: r.missing, c: r.corrupt, r: r.repaired ? ` · ${t("riscaricate")}: ${r.repaired}` : "" })),
      r.problems.length ? h("div", { class: "stack", style: { marginTop: "10px" } },
        h("div", { class: "row" }, h("button", { class: "btn sm", type: "button", onClick: () => integrity(true) }, icon("refresh", 15), t("Prova a riscaricare da Vinted le foto mancanti")), h("span", { class: "small muted" }, t("Funziona finché l'annuncio è ancora online."))),
        h("ul", { class: "plain" }, r.problems.slice(0, 100).map((x) => h("li", null, h("a", { href: `#archive?item=${x.id}` }, x.title || x.id), ` — ${x.photos.length} ${t("foto")}: ${[...new Set(x.photos.map((ph) => ph.error))].join("; ")}`)))) : null);
    } catch (e) { toast(e.message, "bad"); } finally { p.close(); }
  }

  clear(main).append(
    h("div", { class: "page-head" }, h("div", null, h("h1", null, t("Salute")), h("span", { class: "muted" }, t("Lo stato dell'archivio e dell'estensione."))), h("a", { class: "btn", href: "#settings" }, icon("left"), t("Impostazioni"))),
    h("div", { class: "tiles" },
      h("div", { class: "card tile" }, h("b", null, counts.listings), h("span", { class: "muted" }, t("Annunci"))),
      h("div", { class: "card tile" }, h("b", null, counts.images), h("span", { class: "muted" }, t("Foto"))),
      h("div", { class: "card tile" }, h("b", null, fmtBytes(info.usage)), h("span", { class: "muted" }, t("Spazio occupato"))),
      h("div", { class: "card tile" }, h("b", null, account?.userId ? t("Sì") : t("No")), h("span", { class: "muted" }, t("Account Vinted rilevato")))),
    h("section", { class: "card stack" }, h("h2", null, t("Integrità delle foto")),
      h("p", { class: "muted" }, t("Verifica che ogni foto sia presente, non vuota, identica a quando è stata salvata e apribile.")),
      h("div", { class: "row" }, h("button", { class: "btn primary", type: "button", id: "integrity-run", disabled: !counts.listings, onClick: () => integrity(false) }, icon("shield"), t("Controlla tutte le foto"))),
      reportBox),
    h("section", { class: "card stack" }, h("h2", null, t("Dati mancanti")),
      h("p", { class: "muted" }, t("Completa marca, taglia, condizioni, categoria e dati dei libri degli annunci già archiviati: prima con i dati salvati, poi leggendo da Vinted una pagina per ogni categoria di cui manca il nome.")),
      h("div", { class: "row" }, h("button", { class: "btn", type: "button", id: "fill-health", onClick: async () => { await fillMissing(); rerender(); } }, icon("refresh", 15), t("Completa i dati mancanti")),
        h("span", { class: "small muted" }, t("Senza nome della categoria: {n}", { n: missingCategory().length })))),
    h("section", { class: "card stack" }, h("h2", null, t("Registro degli errori")),
      errors.length ? h("div", { class: "table-wrap" }, h("table", { class: "table" }, h("tbody", null, errors.slice(0, 50).map((e) => h("tr", null, h("td", { class: "small" }, fmtDate(e.at, true)), h("td", { class: "mono" }, e.where), h("td", null, e.message)))))) : h("p", { class: "muted" }, t("Nessun errore registrato.")),
      h("div", { class: "row" },
        h("button", { class: "btn", type: "button", id: "copy-report", onClick: () => copyText(lines(), t("Report copiato: non contiene titoli, testi, cookie o identificativi.")) }, icon("copy", 15), t("Copia il report diagnostico")),
        errors.length ? h("button", { class: "btn ghost", type: "button", onClick: async () => { if (await confirmDialog(t("Svuotare il registro?"), t("Gli errori registrati vengono cancellati."))) { await setState("errors", []); rerender(); } } }, t("Svuota registro")) : null)));
}
