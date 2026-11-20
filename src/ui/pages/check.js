/**
 * «Controlla il mio armadio»: legge l'elenco del tuo armadio da Vinted (sola lettura, solo quando lo chiedi),
 * lo confronta con l'archivio e dice cosa è cambiato: annunci nuovi da salvare, spariti (venduti o eliminati),
 * modificati su Vinted. Gli spariti vengono verificati uno per uno e segnati nell'archivio.
 */
import { h, t, clear, icon, toast, rpc, thumbImg } from "../lib.js";
import { S, changed, go, live, setSettings } from "../state.js";
import * as archive from "../../shared/archive.js";
import { wardrobeDiff } from "../../shared/model.js";
import { getState, setState } from "../../shared/store.js";
import { fmtPrice, fmtDate, sleep } from "../../shared/util.js";
import { queueImport } from "./import.js";

const STOP = ["captcha", "blocked", "rate", "auth"];
const pl = (n, one, many) => `${n} ${n === 1 ? one : many}`;
let running = null;            // { step, done, total, stop }
let redraw = () => {};

/** Esegue il controllo completo. Restituisce il riepilogo salvato (anche nello stato, per ritrovarlo dopo). */
export async function runCheck() {
  if (running) return null;
  running = { step: t("Cerco il tuo account Vinted…"), done: 0, total: 0, stop: false };
  redraw();
  try {
    const acc = await rpc("account.get").catch(() => ({}));
    if (!acc?.userId) throw new Error(t("Non trovo il tuo account Vinted: accedi a Vinted in questo browser e riprova."));
    S.account = acc;
    // 1. elenco dell'armadio, tutte le pagine
    const rows = [];
    let tabId = null;
    let note = null;
    for (let page = 1; page <= 60; page++) {
      running.step = t("Leggo il tuo armadio: pagina {p}, {n} annunci", { p: page, n: rows.length });
      redraw();
      const r = await rpc("vinted.wardrobe", { origin: acc.origin, userId: acc.userId, page, tabId });
      if (!r.ok) throw new Error(r.message);
      tabId = r.tabId;
      note = r.note || note;
      rows.push(...r.items);
      if (!r.items.length || r.method === "dom" || (r.totalPages && page >= r.totalPages)) break;
      await sleep(900 + Math.random() * 600);
    }
    if (note && rows.length) throw new Error(t("Vinted non ha dato l'elenco completo dell'armadio (letti solo gli annunci visibili nella pagina): il confronto direbbe cose sbagliate sugli spariti. Riprova più tardi."));
    // L'archivio aggiornato, non la copia in memoria della pagina: annunci salvati altrove nel frattempo devono contare.
    const diff = wardrobeDiff(await archive.listAll(), rows, acc.origin);
    // 2. gli spariti: venduti o eliminati? Uno alla volta, con calma.
    const result = { at: Date.now(), origin: acc.origin, userId: acc.userId, rows: diff.rows, fresh: diff.fresh.map(({ wardrobe, ...x }) => ({ ...x, wardrobe })), sold: [...diff.sold], offline: [], unknown: [], back: diff.back, changed: diff.changed, unchanged: diff.unchanged, stopped: null };
    running.total = diff.gone.length;
    for (const [i, id] of diff.gone.entries()) {
      if (running.stop) { result.unknown.push(...diff.gone.slice(i)); break; }
      running.done = i;
      running.step = t("Verifico gli annunci spariti: {a} di {b}", { a: i + 1, b: diff.gone.length });
      redraw();
      const r = await rpc("vinted.check", { listingId: id }).catch((e) => ({ ok: false, message: e.message }));
      if (!r.ok) {
        result.unknown.push(id);
        if (r.stop) { result.stopped = r.message; result.unknown.push(...diff.gone.slice(i + 1)); break; }
      } else if (r.online === "sold") result.sold.push(id);
      else if (r.online === "offline") result.offline.push(id);
      else if (r.online === "online") result.back.push(id);       // c'è ancora: era solo fuori dall'elenco
      else result.unknown.push(id);
      if (i < diff.gone.length - 1) await sleep(S.settings.importDelay.min + Math.random() * (S.settings.importDelay.max - S.settings.importDelay.min));
    }
    // 3. l'archivio si aggiorna: stato online e segnale «modificato su Vinted»
    const now = Date.now();
    await archive.patchMany(diff.sold, (l) => { l.online = "sold"; l.onlineCheckedAt = now; });
    await archive.patchMany(diff.back, (l) => { l.online = "online"; l.onlineCheckedAt = now; });
    await archive.patchMany(result.changed.map((c) => c.id), (l) => { l.remoteChanged = true; });
    await setState("wardrobeCheck", result);
    await setSettings({ wardrobe: { lastCheckAt: now } });
    await changed({ silent: true });
    return result;
  } finally {
    running = null;
    redraw();
  }
}

const listingRow = (l, extra = null) => h("li", { class: "check-row" },
  thumbImg(l?.coverImageId, ""), h("a", { href: `#archive?item=${l?.id}` }, l?.title || t("(annuncio non più in archivio)")),
  h("span", { class: "muted small" }, l ? fmtPrice(l.price, l.currency) : ""), extra);

function section(id, title, items, render, { tone = "", empty = null, actions = null } = {}) {
  if (!items.length && !empty) return null;
  return h("section", { class: "card stack", id }, h("div", { class: "row between" }, h("h2", null, title, " ", h("span", { class: `chip ${tone}` }, String(items.length))), actions),
    items.length ? h("ul", { class: "check-list" }, items.map(render)) : h("p", { class: "muted small" }, empty));
}

export async function renderCheck(main) {
  redraw = () => { if (location.hash.startsWith("#check")) renderCheck(main); };
  const result = await getState("wardrobeCheck", null);
  // Dall'archivio, non dalla memoria della pagina: un'importazione appena finita deve già contare.
  const all = await archive.listAll();
  const byId = (id) => all.find((l) => l.id === id) || S.byId.get(id);
  const archivedIds = new Set(all.filter((l) => !l.deletedAt).map((l) => l.vintedId));
  const freshLeft = (result?.fresh || []).filter((f) => !archivedIds.has(f.vintedId));
  const picked = new Set(freshLeft.map((f) => f.vintedId));
  const params = new URLSearchParams(location.hash.split("?")[1] || "");

  const head = h("div", { class: "page-head" }, h("div", null, h("h1", null, t("Controlla il mio armadio")),
    h("span", { class: "muted" }, t("Confronta il tuo armadio su Vinted con l'archivio: annunci nuovi da salvare, spariti, modificati. Solo lettura, solo quando lo chiedi tu."))));
  const start = h("button", { class: "btn primary", type: "button", id: "check-run", disabled: Boolean(running), onClick: async () => {
    try {
      const r = await runCheck();
      if (r) toast(`${t("Controllo finito")}: ${[pl(r.fresh.length, t("nuovo"), t("nuovi")), pl(r.sold.length, t("venduto"), t("venduti")), pl(r.offline.length, t("eliminato"), t("eliminati")), pl(r.changed.length, t("modificato"), t("modificati"))].join(", ")}.`, r.stopped ? "" : "good", 8000);
    } catch (e) { toast(e.message, "bad", 10000); }
  } }, icon("refresh"), running ? t("Controllo in corso…") : t("Controlla ora"));
  const status = running
    ? h("div", { class: "stack", id: "check-progress" }, h("p", null, running.step), running.total ? h("div", { class: "progress", role: "progressbar" }, h("i", { style: { width: `${Math.round((running.done / running.total) * 100)}%` } })) : h("div", { class: "progress" }, h("i", { style: { width: "15%" } })),
      h("button", { class: "btn sm", type: "button", onClick: () => { running.stop = true; } }, t("Ferma la verifica degli spariti")))
    : h("p", { class: "muted small" }, result ? t("Ultimo controllo: {d} · {n} annunci nel tuo armadio.", { d: fmtDate(result.at, true), n: result.rows }) : t("Non hai ancora fatto un controllo."));

  const out = [head, h("section", { class: "card stack" }, h("div", { class: "row" }, start), status)];
  if (result && !running) {
    if (result.stopped) out.push(h("div", { class: "note bad" }, result.stopped));
    const total = freshLeft.length + result.sold.length + result.offline.length + result.changed.length + result.unknown.length;
    if (!total) out.push(h("div", { class: "note good", id: "check-allgood" }, t("Tutto in ordine: l'archivio corrisponde al tuo armadio.")));
    else {
      const jump = (id, n, one, many, tone) => (n ? h("a", { class: `chip ${tone}`, href: "#", onClick: (e) => { e.preventDefault(); document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" }); } }, pl(n, one, many)) : null);
      out.push(h("div", { class: "row", id: "check-summary" },
        jump("check-fresh", freshLeft.length, t("nuovo da salvare"), t("nuovi da salvare"), "primary"), jump("check-sold", result.sold.length, t("venduto"), t("venduti"), "good"),
        jump("check-offline", result.offline.length, t("eliminato"), t("eliminati"), "warn"), jump("check-changed", result.changed.length, t("modificato"), t("modificati"), "warn"),
        jump("check-unknown", result.unknown.length, t("da ricontrollare"), t("da ricontrollare"), "")));
    }
    const saveBtn = freshLeft.length ? h("button", { class: "btn primary sm", type: "button", id: "check-save", onClick: async () => {
      const items = freshLeft.filter((f) => picked.has(f.vintedId));
      if (!items.length) { toast(t("Seleziona almeno un annuncio.")); return; }
      await queueImport({ origin: result.origin, userId: result.userId, owner: "mine", items });
      go("import");
    } }, icon("download", 15), t("Salva i selezionati")) : null;
    const pickAll = (on) => { for (const f of freshLeft) { if (on) picked.add(f.vintedId); else picked.delete(f.vintedId); } for (const cb of main.querySelectorAll("#check-fresh li input[type=checkbox]")) cb.checked = on; };
    const freshActions = saveBtn ? h("span", { class: "row" }, h("button", { class: "btn sm ghost", type: "button", onClick: () => pickAll(true) }, t("Tutti")), h("button", { class: "btn sm ghost", type: "button", onClick: () => pickAll(false) }, t("Nessuno")), saveBtn) : null;
    out.push(
      section("check-sold", t("Venduti"), result.sold, (id) => listingRow(byId(id), h("span", { class: "chip good" }, t("Venduto"))), { tone: "good" }),
      section("check-offline", t("Eliminati da Vinted"), result.offline, (id) => listingRow(byId(id), h("span", { class: "chip warn" }, t("Non più online"))), { tone: "warn" }),
      section("check-changed", t("Modificati su Vinted"), result.changed, (c) => listingRow(byId(c.id), h("span", { class: "row" }, h("span", { class: "small muted" }, c.fields.map((f) => ({ title: t("titolo"), price: t("prezzo"), photos: t("foto") }[f])).join(", ")),
        h("a", { class: "btn sm", href: `#archive?item=${c.id}&update=1` }, t("Rivedi")))), { tone: "warn" }),
      section("check-unknown", t("Non verificati"), result.unknown, (id) => listingRow(byId(id), h("span", { class: "chip" }, t("da ricontrollare"))), {}),
      section("check-fresh", t("Nuovi da salvare"), freshLeft, (f) => h("li", { class: "check-row" },
        h("input", { type: "checkbox", checked: true, "aria-label": f.title, onChange: (e) => { if (e.target.checked) picked.add(f.vintedId); else picked.delete(f.vintedId); } }),
        f.thumb ? h("img", { src: f.thumb, alt: "", loading: "lazy", referrerpolicy: "no-referrer" }) : h("img", { alt: "", class: "empty" }),
        h("span", null, f.title), h("span", { class: "muted small" }, fmtPrice(f.price, f.currency)), f.state === "reserved" ? h("span", { class: "chip" }, t("Riservato")) : null), { tone: "primary", actions: freshActions }),
      result.back.length ? h("p", { class: "small muted" }, t("{n} annunci segnati come spariti sono di nuovo nel tuo armadio: ora risultano online.", { n: result.back.length })) : null,
      result.unchanged ? h("p", { class: "small muted" }, t("{n} annunci invariati.", { n: result.unchanged })) : null);
  }
  clear(main).append(...out.filter(Boolean));
  if (params.get("run") === "1" && !running && !main.dataset.autorun) {
    main.dataset.autorun = "1";
    history.replaceState(null, "", "#check");
    start.click();
  } else if (!params.get("run")) delete main.dataset.autorun;
}
