/**
 * Importazione da un armadio (F7–F10): elenco letto dalla scheda di Vinted, anteprima,
 * scelta, salvataggio uno alla volta con una pausa tra un annuncio e l'altro.
 * Ogni passo viene scritto nel database: se chiudi il browser, riprendi da dove eri.
 * CAPTCHA, 403 e 429 fermano l'importazione: non si aggirano.
 */
import { h, t, clear, icon, toast, confirmDialog, rpc } from "../lib.js";
import { S, changed, parseRoute } from "../state.js";
import * as db from "../../shared/db.js";
import { normalizeBundle, parseVintedUrl } from "../../shared/model.js";
import { isVintedOrigin } from "../../shared/constants.js";
import { fmtPrice, fmtDate, uid, sleep } from "../../shared/util.js";

let preview = null;                                   // { origin, userId, tabId, items, selected:Set, ... }
const runner = { jobId: null, running: false, stop: false };
const openJobs = new Set();
let redraw = () => {};

const STATUS = { pending: "In attesa", done: "Salvato", skipped: "Saltato", failed: "Non riuscito" };
const JOB_STATUS = { running: "In corso", paused: "In pausa", done: "Completata", interrupted: "Interrotta", blocked: "Fermata da Vinted" };
const counts = (job) => job.items.reduce((a, i) => { a[i.status] = (a[i.status] || 0) + 1; return a; }, { pending: 0, done: 0, skipped: 0, failed: 0 });

/** All'avvio: un'importazione rimasta «in corso» è stata interrotta dalla chiusura del browser. */
export async function recoverJobs() {
  for (const j of await db.getAll("jobs")) if (j.status === "running" && !(runner.running && runner.jobId === j.id)) await db.put("jobs", { ...j, status: "interrupted" });
}

export async function runJob(jobId) {
  if (runner.running) { toast(t("C'è già un'importazione in corso.")); return; }
  Object.assign(runner, { jobId, running: true, stop: false });
  let job = await db.get("jobs", jobId);
  job.status = "running";
  job.message = null;
  await db.put("jobs", job);
  redraw();
  try {
    for (const it of job.items) {
      if (runner.stop) break;
      if (it.status !== "pending") continue;
      const r = await rpc("save.byId", { origin: job.origin, vintedId: it.vintedId, tabId: job.tabId, wardrobe: it.wardrobe, jobId });
      if (r.status === "failed") {
        if (r.stop) { job.status = "blocked"; job.message = r.message; break; }
        it.status = "failed"; it.error = r.message;
      } else {
        it.status = r.status === "saved" ? "done" : "skipped";
        it.listingId = r.listingId;
        it.note = r.status === "duplicate" ? "già in archivio" : r.status === "restored" ? "ripristinato dal cestino" : r.photoMissing ? `${r.photoMissing} foto non scaricate` : null;
        delete it.wardrobe;
      }
      job.updatedAt = Date.now();
      await db.put("jobs", job);
      redraw();
      const { min, max } = S.settings.importDelay;
      if (!runner.stop && job.items.some((x) => x.status === "pending")) await sleep(min + Math.random() * Math.max(0, max - min));
    }
  } catch (e) {
    job.status = "interrupted";
    job.message = e.message;
  }
  if (job.status === "running") job.status = runner.stop ? "paused" : "done";
  job.updatedAt = Date.now();
  if (job.status === "done") job.finishedAt = Date.now();
  await db.put("jobs", job);
  runner.running = false;
  await changed({ silent: true });
  redraw();
  const c = counts(job);
  if (job.status === "done") toast(t("Importazione completata: {a} salvati, {b} saltati, {c} non riusciti.", { a: c.done, b: c.skipped, c: c.failed }), c.failed ? "" : "good", 7000);
  else if (job.status === "blocked") toast(job.message, "bad");
}

async function loadWardrobe({ origin, userId, tabId = null }) {
  preview = { origin, userId: String(userId), tabId, items: [], selected: new Set(), loading: true, error: null, note: null, sellerLogin: null, page: 0, totalPages: null, onlyNew: true, onlyActive: S.settings.onlyActive };
  redraw();
  try {
    for (let page = 1; page <= 60; page++) {
      const r = await rpc("vinted.wardrobe", { origin, userId: preview.userId, page, tabId: preview.tabId });
      if (!preview || preview.userId !== String(userId)) return;
      if (!r.ok) { preview.error = r.message; break; }
      preview.tabId = r.tabId;
      preview.note = r.note || null;
      preview.sellerLogin ||= r.sellerLogin;
      preview.page = page;
      preview.totalPages = r.totalPages;
      const have = new Set(preview.items.map((x) => x.vintedId));
      for (const raw of r.items) {
        const n = normalizeBundle({ wardrobe: raw }, origin);
        if (!n || have.has(n.vintedId)) continue;
        have.add(n.vintedId);
        preview.items.push({ vintedId: n.vintedId, title: n.title, price: n.price, currency: n.currency, state: n.state, brand: n.brand, size: n.size, thumb: /^https:\/\/[^/]*vinted\.net\//.test(n.photos[0]?.url || "") ? n.photos[0].url : null, wardrobe: raw });
      }
      redraw();
      if (!r.items.length || r.method === "dom" || (r.totalPages && page >= r.totalPages)) break;
      await sleep(900 + Math.random() * 600);
    }
  } catch (e) {
    if (preview) preview.error = e.message;
  }
  if (!preview) return;
  preview.loading = false;
  selectDefault();
  redraw();
}

const savedIds = () => new Set(S.listings.filter((l) => !l.deletedAt).map((l) => l.vintedId));
function visibleItems() {
  const saved = savedIds();
  return preview.items.filter((i) => (!preview.onlyNew || !saved.has(i.vintedId)) && (!preview.onlyActive || i.state === "active"));
}
function selectDefault() { preview.selected = new Set(visibleItems().map((i) => i.vintedId)); }

/** Crea un'importazione (riprendibile) per questi annunci e la avvia. Usata anche da «Controlla il mio armadio». */
export async function queueImport({ origin, userId, sellerLogin = null, tabId = null, owner = "mine", items }) {
  const job = {
    id: uid("j_"), createdAt: Date.now(), updatedAt: Date.now(), origin, userId: String(userId), sellerLogin, tabId,
    owner, status: "paused", message: null,
    items: items.map((i) => ({ vintedId: i.vintedId, title: i.title, price: i.price, currency: i.currency, status: "pending", wardrobe: i.wardrobe })),
  };
  await db.put("jobs", job);
  runJob(job.id);
  return job;
}

async function startImport() {
  const items = visibleItems().filter((i) => preview.selected.has(i.vintedId));
  if (!items.length) { toast(t("Seleziona almeno un annuncio.")); return; }
  const isMine = S.account.userId && preview.userId === String(S.account.userId);
  if (!isMine && !(await confirmDialog(t("Annunci non tuoi"), t("Questo armadio non è il tuo: i {n} annunci verranno salvati nella sezione «Annunci non miei».", { n: items.length }), { okLabel: t("Importa comunque") }))) return;
  const ctx = { origin: preview.origin, userId: preview.userId, sellerLogin: preview.sellerLogin, tabId: preview.tabId, owner: isMine ? "mine" : "other", items };
  preview = null;
  await queueImport(ctx);
}

function jobCard(job, open) {
  const c = counts(job);
  const total = job.items.length;
  const doneN = total - c.pending;
  const live = runner.running && runner.jobId === job.id;
  const chipClass = { done: "good", blocked: "bad", interrupted: "warn", paused: "warn", running: "primary" }[job.status] || "";
  const actions = [];
  if (live) actions.push(h("button", { class: "btn sm", type: "button", onClick: () => { runner.stop = true; toast(t("Mi fermo dopo l'annuncio in corso.")); } }, t("Pausa")));
  else if (c.pending) actions.push(h("button", { class: "btn sm primary", type: "button", dataset: { act: "resume" }, onClick: () => runJob(job.id) }, t("Riprendi")));
  if (!live && c.failed) actions.push(h("button", { class: "btn sm", type: "button", onClick: async () => { for (const it of job.items) if (it.status === "failed") { it.status = "pending"; it.error = null; it.wardrobe ||= { id: Number(it.vintedId), title: it.title, user_id: Number(job.userId) }; } await db.put("jobs", job); runJob(job.id); } }, t("Riprova i non riusciti")));
  if (!live) actions.push(h("button", { class: "btn sm ghost", type: "button", onClick: async () => { if (await confirmDialog(t("Togliere dalla cronologia?"), t("Gli annunci già salvati restano nell'archivio."), { okLabel: t("Togli") })) { await db.del("jobs", job.id); redraw(); } } }, t("Togli")));
  return h("details", { class: "card job", open: open || openJobs.has(job.id), dataset: { job: job.id, status: job.status }, onToggle: (e) => { if (e.target.open) openJobs.add(job.id); else openJobs.delete(job.id); } },
    h("summary", null, h("div", { class: "row between" },
      h("div", null, h("strong", null, job.sellerLogin ? t("Armadio di {u}", { u: job.sellerLogin }) : t("Armadio {id}", { id: job.userId })), " ", h("span", { class: `chip ${chipClass}` }, t(JOB_STATUS[job.status] || job.status)), job.owner !== "mine" ? h("span", { class: "chip" }, t("Non miei")) : null,
        h("div", { class: "muted small" }, `${fmtDate(job.createdAt, true)} · ${t("{a} di {b}", { a: doneN, b: total })} · ${t("salvati")} ${c.done} · ${t("saltati")} ${c.skipped} · ${t("non riusciti")} ${c.failed}`)),
      h("div", { class: "row" }, actions)),
    h("div", { class: "progress", role: "progressbar", "aria-valuenow": doneN, "aria-valuemax": total }, h("i", { style: { width: `${total ? Math.round((doneN / total) * 100) : 0}%` } }))),
    job.message ? h("div", { class: `note ${job.status === "blocked" ? "bad" : "warn"}` }, job.message) : null,
    job.status === "interrupted" && !job.message ? h("div", { class: "note warn" }, t("Interrotta dalla chiusura del browser: gli annunci già salvati sono al sicuro. Premi «Riprendi» per continuare.")) : null,
    h("div", { class: "table-wrap" }, h("table", { class: "table" }, h("tbody", null, job.items.map((it) => h("tr", { dataset: { status: it.status } },
      h("td", null, it.listingId ? h("a", { href: `#archive?item=${it.listingId}` }, it.title || it.vintedId) : (it.title || it.vintedId)),
      h("td", { class: "num" }, fmtPrice(it.price, it.currency)),
      h("td", null, h("span", { class: `chip ${{ done: "good", failed: "bad", skipped: "" }[it.status] || ""}` }, t(STATUS[it.status]))),
      h("td", { class: "small muted" }, it.error || it.note || "")))))));
}

export async function renderImport(main) {
  const params = parseRoute().params;
  let cache = null;
  redraw = () => { if (parseRoute().name === "import") draw(); };
  if (params.user && params.origin && isVintedOrigin(params.origin) && (!preview || preview.userId !== params.user)) {
    history.replaceState(null, "", "#import");
    loadWardrobe({ origin: params.origin, userId: params.user, tabId: params.tab ? Number(params.tab) : null });
  }

  /** light: solo ridisegno, senza rileggere cronologia e schede (le spunte devono rispondere subito). */
  async function draw(light = false) {
    if (!light || !cache) cache = { jobs: (await db.getAll("jobs")).sort((a, b) => b.createdAt - a.createdAt), tabs: (await rpc("vinted.tabs").catch(() => [])).filter((x) => x.kind === "wardrobe") };
    const { jobs, tabs } = cache;
    const me = S.account.userId;
    const urlInput = h("input", { class: "input", placeholder: "https://www.vinted.it/member/123456", "aria-label": t("Indirizzo di un armadio") });
    const source = h("section", { class: "card stack" },
      h("h2", null, t("Da quale armadio?")),
      h("div", { class: "row" },
        h("button", { class: "btn primary", type: "button", id: "import-mine", disabled: !me, onClick: () => loadWardrobe({ origin: S.account.origin, userId: me }) }, icon("archive"), t("Il mio armadio")),
        tabs.map((x) => h("button", { class: "btn", type: "button", onClick: () => loadWardrobe({ origin: x.origin, userId: x.id, tabId: x.tabId }) }, t("Scheda aperta: {t}", { t: (x.title || x.id).slice(0, 40) })))),
      !me ? h("div", { class: "note warn" }, t("Non risulti collegato a Vinted in questo browser: apri Vinted, accedi e ricarica questa pagina.")) : null,
      h("div", { class: "row" }, h("div", { class: "grow" }, urlInput), h("button", { class: "btn", type: "button", onClick: () => {
        const p = parseVintedUrl(urlInput.value.trim());
        if (p.kind !== "wardrobe" || !isVintedOrigin(p.origin)) { toast(t("Incolla l'indirizzo di un armadio Vinted (…/member/numero)."), "bad"); return; }
        loadWardrobe({ origin: p.origin, userId: p.id });
      } }, t("Leggi questo armadio"))),
      h("div", { class: "small muted" }, t("Vintory legge l'elenco dalla scheda di Vinted, in sola lettura e senza fretta. Se Vinted chiede una verifica o limita le richieste, l'importazione si ferma.")));

    const blocks = [h("div", { class: "page-head" }, h("div", null, h("h1", null, t("Importa da un armadio")), h("span", { class: "muted" }, t("Scegli gli annunci dall'anteprima: ognuno viene salvato con tutte le foto."))), preview ? h("button", { class: "btn", type: "button", onClick: () => { preview = null; draw(true); } }, t("Annulla anteprima")) : null), source];

    if (preview) {
      const saved = savedIds();
      const vis = visibleItems();
      const isMine = me && preview.userId === String(me);
      const sel = vis.filter((i) => preview.selected.has(i.vintedId)).length;
      const hiddenSaved = preview.items.filter((i) => saved.has(i.vintedId)).length;
      const hiddenInactive = preview.items.filter((i) => i.state !== "active").length;
      blocks.push(h("section", { class: "card stack", id: "preview" },
        h("div", { class: "row between" }, h("h2", null, preview.sellerLogin ? t("Armadio di {u}", { u: preview.sellerLogin }) : t("Armadio {id}", { id: preview.userId }), " ", h("span", { class: `chip ${isMine ? "primary" : ""}` }, isMine ? t("Il tuo armadio") : t("Non tuo: andranno in «Annunci non miei»"))),
          h("span", { class: "muted" }, preview.loading ? t("Leggo… pagina {a}{b} · {n} annunci", { a: preview.page + 1, b: preview.totalPages ? `/${preview.totalPages}` : "", n: preview.items.length }) : t("{n} annunci letti", { n: preview.items.length }))),
        preview.error ? h("div", { class: "note bad" }, preview.error) : null,
        preview.note ? h("div", { class: "note warn" }, preview.note) : null,
        h("div", { class: "row" },
          h("label", { class: "check" }, h("input", { type: "checkbox", id: "only-new", checked: preview.onlyNew, onChange: (e) => { preview.onlyNew = e.target.checked; selectDefault(); draw(true); } }), t("Solo i nuovi ({n} già in archivio)", { n: hiddenSaved })),
          h("label", { class: "check" }, h("input", { type: "checkbox", id: "only-active", checked: preview.onlyActive, onChange: (e) => { preview.onlyActive = e.target.checked; selectDefault(); draw(true); } }), t("Solo attivi ({n} venduti, riservati o nascosti)", { n: hiddenInactive })),
          h("span", { class: "grow" }),
          h("button", { class: "btn sm", type: "button", onClick: () => { selectDefault(); draw(true); } }, t("Seleziona tutti")),
          h("button", { class: "btn sm", type: "button", onClick: () => { preview.selected.clear(); draw(true); } }, t("Nessuno")),
          h("button", { class: "btn primary", type: "button", id: "import-start", disabled: preview.loading || !sel, onClick: startImport }, t("Importa {n} annunci", { n: sel }))),
        vis.length ? h("div", { class: "grid preview-grid" }, vis.map((i) => h("label", { class: `item pv${preview.selected.has(i.vintedId) ? " sel" : ""}` },
          h("span", { class: "pick" }, h("input", { type: "checkbox", checked: preview.selected.has(i.vintedId), "aria-label": t("Seleziona {t}", { t: i.title }), onChange: (e) => { if (e.target.checked) preview.selected.add(i.vintedId); else preview.selected.delete(i.vintedId); draw(true); } })),
          h("span", { class: "thumb" }, i.thumb ? h("img", { src: i.thumb, alt: "", loading: "lazy", referrerpolicy: "no-referrer" }) : null),
          h("span", { class: "meta" }, h("span", { class: "t" }, i.title), h("span", { class: "row between" }, h("strong", null, fmtPrice(i.price, i.currency)), h("span", { class: "muted small ell" }, [i.brand, i.size].filter(Boolean).join(" · "))),
            h("span", { class: "row badges" }, saved.has(i.vintedId) ? h("span", { class: "chip good" }, t("Già in archivio")) : null, i.state !== "active" ? h("span", { class: "chip warn" }, t({ sold: "Venduto", reserved: "Riservato", hidden: "Nascosto" }[i.state] || i.state)) : null))))) : h("div", { class: "empty" }, preview.loading ? t("Leggo l'armadio…") : t("Niente da importare con queste opzioni."))));
    }

    blocks.push(h("h2", { class: "section-title" }, t("Cronologia delle importazioni")));
    blocks.push(jobs.length ? h("div", { class: "stack" }, jobs.map((j) => jobCard(j, runner.running && runner.jobId === j.id))) : h("div", { class: "empty" }, h("p", null, t("Ancora nessuna importazione."))));
    const y = main.scrollTop;
    clear(main).append(...blocks.filter(Boolean));
    main.scrollTop = y;
  }
  await draw();
}
