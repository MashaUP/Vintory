/**
 * Service worker di Vintory.
 * Coordina: account (dal cookie), lettura di Vinted tramite la scheda, salvataggio
 * nell'archivio, badge dell'icona, aggiornamenti, promemoria di backup.
 * Non invia mai a Vinted richieste che modificano qualcosa.
 */
import { VERSION, VINTED_DOMAINS, UPDATE_EVERY_MIN, isVintedOrigin, APP } from "../shared/constants.js";
import * as archive from "../shared/archive.js";
import * as db from "../shared/db.js";
import { normalizeBundle, ownerOf, parseVintedUrl, backupDue, userIdFromToken } from "../shared/model.js";
import { getSettings, saveSettings, getState, setState, logError } from "../shared/store.js";
import { checkUpdate, shouldNotify, downloadUpdate, getLinks } from "../shared/updates.js";

const CONTENT_FILES = ["src/content/guard.js", "src/content/vinted.js", "src/content/content.js"];
const API_PATTERNS = VINTED_DOMAINS.map((d) => `https://www.${d}/api/*`);
const STOP_KINDS = ["captcha", "blocked", "rate", "auth"];

const broadcast = (type, data = {}) => chrome.runtime.sendMessage({ type, ...data }).catch(() => {});

// ---------------------------------------------------------------- account e token

/** Id dell'utente Vinted: solo dal cookie (v_uid, o il «sub» del token), mai dalla pagina. */
async function accountFor(origin) {
  if (!origin || !isVintedOrigin(origin)) return null;
  let userId = null;
  try {
    const c = await chrome.cookies.get({ url: `${origin}/`, name: "v_uid" });
    if (c?.value && /^\d+$/.test(c.value)) userId = c.value;
    if (!userId) {
      const t = await chrome.cookies.get({ url: `${origin}/`, name: "access_token_web" });
      if (t?.value) userId = userIdFromToken(t.value);
    }
  } catch { /* cookie non leggibili: nessun account */ }
  const prev = await getState("account", null);
  if (userId && (prev?.userId !== userId || prev?.origin !== origin)) await setState("account", { userId, origin, at: Date.now() });
  return userId;
}

// CSRF e anon id dalle richieste che Vinted fa da sé: restano in memoria di sessione, mai su disco.
if (chrome.webRequest?.onSendHeaders) {
  chrome.webRequest.onSendHeaders.addListener((details) => {
    let csrf = null;
    let anonId = null;
    for (const h of details.requestHeaders || []) {
      const n = h.name.toLowerCase();
      if (n === "x-csrf-token") csrf = h.value;
      else if (n === "x-anon-id") anonId = h.value;
    }
    if (!csrf && !anonId) return;
    const origin = new URL(details.url).origin;
    chrome.storage.session.get("tokens").then(({ tokens = {} }) => {
      const prev = tokens[origin] || {};
      if (prev.csrf === (csrf || prev.csrf) && prev.anonId === (anonId || prev.anonId)) return;
      chrome.storage.session.set({ tokens: { ...tokens, [origin]: { csrf: csrf || prev.csrf || null, anonId: anonId || prev.anonId || null } } });
    });
  }, { urls: API_PATTERNS }, ["requestHeaders", "extraHeaders"]);
}

// ---------------------------------------------------------------- schede di Vinted

/** Un'operazione sulle schede con un limite di tempo: il browser a volte non risponde, e Vintory non deve restare appeso. */
function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]).finally(() => clearTimeout(timer));
}

/** Apre una scheda vuota in secondo piano e la porta all'indirizzo; un secondo tentativo se il browser non risponde. */
async function openBackgroundTab(url) {
  for (let attempt = 1; ; attempt++) {
    let tab = null;
    try {
      tab = await withTimeout(chrome.tabs.create({ url: "about:blank", active: false }), 15_000, "Il browser non ha aperto la scheda in 15 secondi.");
      await withTimeout(chrome.tabs.update(tab.id, { url }), 15_000, "Il browser non ha caricato la scheda in 15 secondi.");
      await new Promise((r) => setTimeout(r, 300));
      await waitComplete(tab.id);
      return tab;
    } catch (e) {
      if (tab) chrome.tabs.remove(tab.id).catch(() => {});
      if (attempt >= 2) throw e;
    }
  }
}

async function waitComplete(tabId, timeoutMs = 30_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const t = await withTimeout(chrome.tabs.get(tabId), 5_000, "timeout").catch(() => null);
    if (!t) throw new Error("La scheda di Vinted è stata chiusa o non risponde.");
    if (t.status === "complete") return t;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("La pagina di Vinted non ha finito di caricarsi in 30 secondi.");
}

/** Una scheda di Vinted su quell'origine: quella indicata, una già aperta, oppure una nuova in secondo piano. */
async function vintedTab({ origin, tabId = null, url = null }) {
  if (!isVintedOrigin(origin)) throw new Error("Indirizzo di Vinted non riconosciuto.");
  if (tabId != null) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (t?.url?.startsWith(`${origin}/`)) return { tab: t, created: false };
  }
  const tabs = await chrome.tabs.query({ url: `${origin}/*` });
  const ready = tabs.find((t) => t.status === "complete") || tabs[0];
  if (ready) return { tab: ready, created: false };
  const t = await openBackgroundTab(url && url.startsWith(`${origin}/`) ? url : `${origin}/`);
  return { tab: t, created: true };
}

/** Messaggio alla scheda; se lo script non c'è (scheda aperta prima dell'installazione) lo inietta e riprova una volta. */
/** Risposta della scheda entro il limite: una scheda bloccata non deve fermare Vintory per sempre. */
function send(tabId, msg, timeoutMs) {
  let timer;
  return Promise.race([
    chrome.tabs.sendMessage(tabId, msg),
    new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(`La scheda di Vinted non ha risposto in ${Math.round(timeoutMs / 1000)} secondi: ricaricala (F5) e riprova.`), { timeout: true })), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
}

async function askTab(tabId, msg, timeoutMs = 90_000) {
  let r;
  try {
    r = await send(tabId, msg, timeoutMs);
  } catch (e) {
    if (e.timeout) throw e;
    await chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_FILES });
    r = await send(tabId, msg, timeoutMs);
  }
  if (r && r.version && r.version !== VERSION) throw new Error("La scheda di Vinted usa una versione precedente di Vintory: ricaricala (F5) e riprova.");
  if (!r) throw new Error("La scheda di Vinted non ha risposto: ricaricala (F5) e riprova.");
  return r;
}

async function withTab(opts, fn) {
  const { tab, created } = await vintedTab(opts);
  try { return await fn(tab); } finally { if (created) chrome.tabs.remove(tab.id).catch(() => {}); }
}

// ---------------------------------------------------------------- badge (F4)

async function refreshBadge(tabId, url) {
  try {
    const p = parseVintedUrl(url || "");
    if (p.kind !== "item" || !isVintedOrigin(p.origin)) { await chrome.action.setBadgeText({ tabId, text: "" }); await chrome.action.setTitle({ tabId, title: APP }); return; }
    const l = await archive.findByVintedId(p.id);
    const state = !l || l.deletedAt ? ["+", "#6a47e8", "Annuncio non salvato"] : l.remoteChanged ? ["!", "#c2660a", "Modificato su Vinted dopo il salvataggio"] : ["✓", "#1f7a4c", "Annuncio salvato"];
    await chrome.action.setBadgeText({ tabId, text: state[0] });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: state[1] });
    if (chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({ tabId, color: "#ffffff" });
    await chrome.action.setTitle({ tabId, title: `${APP} — ${state[2]}` });
  } catch { /* scheda chiusa nel frattempo */ }
}

chrome.tabs.onUpdated.addListener((tabId, change, tab) => { if (change.url || change.status === "complete") refreshBadge(tabId, tab.url); });
chrome.tabs.onActivated.addListener(async ({ tabId }) => { const t = await chrome.tabs.get(tabId).catch(() => null); if (t) refreshBadge(tabId, t.url); });

async function refreshItemTabs(vintedId) {
  for (const t of await chrome.tabs.query({ url: VINTED_DOMAINS.map((d) => `https://www.${d}/items/${vintedId}*`) })) {
    refreshBadge(t.id, t.url);
    chrome.tabs.sendMessage(t.id, { type: "vy:refresh" }).catch(() => {});
  }
}

// ---------------------------------------------------------------- salvataggio

const summary = (r) => ({
  status: r.status, listingId: r.listing.id, vintedId: r.listing.vintedId, title: r.listing.title, owner: r.listing.owner,
  photoCount: r.listing.photoCount, photoMissing: r.listing.photoMissing || 0, similar: (r.similar || []).length, diffs: (r.diffs || []).length,
});

const recent = new Map();      // lettura appena fatta, per non ripeterla dopo la conferma «non è tuo»

async function readItem({ tabId, origin, id, accountId, wardrobe = null }) {
  const key = `${tabId}:${id}`;
  const hit = recent.get(key);
  if (hit && Date.now() - hit.at < 120_000) return hit.r;
  const r = await askTab(tabId, { type: "vy:read", id, accountId, wardrobe });
  if (r.ok) { recent.set(key, { at: Date.now(), r }); if (recent.size > 20) recent.delete(recent.keys().next().value); }
  return r;
}

/**
 * Se Vinted ha dato solo il numero della categoria e il suo nome non è ancora noto, legge la pagina
 * dell'annuncio (una volta per categoria) e aggiunge al bundle il percorso trovato.
 * Restituisce un errore solo se Vinted chiede di fermarsi (CAPTCHA, 429): il nome della categoria è facoltativo.
 */
async function addCategory(tabId, origin, id, bundle) {
  const catalogId = await archive.missingCatalog(bundle, origin);
  if (!catalogId) return null;
  const r = await askTab(tabId, { type: "vy:page", id: String(id), catalogId });
  if (r.ok && r.page?.catalog) bundle.page = bundle.page ? { ...bundle.page, catalog: r.page.catalog } : r.page;
  return !r.ok && ["captcha", "rate"].includes(r.kind) ? r : null;
}

async function saveFromTab(tabId, { confirmOther = false } = {}) {
  const tab = await chrome.tabs.get(tabId);
  const p = parseVintedUrl(tab.url || "");
  if (p.kind !== "item" || !isVintedOrigin(p.origin)) throw new Error("Apri la pagina di un annuncio Vinted per salvarlo.");
  const accountId = await accountFor(p.origin);
  const r = await readItem({ tabId, origin: p.origin, id: p.id, accountId });
  if (!r.ok) throw new Error(r.message || "Lettura dell'annuncio non riuscita.");
  const n = normalizeBundle(r.bundle, p.origin);
  if (!n) throw new Error("Vinted non ha fornito i dati dell'annuncio.");
  const existing = await archive.findByVintedId(n.vintedId);
  if (!existing && !confirmOther && ownerOf(n, accountId, { uploadOk: Boolean(r.bundle.upload) }) === "other") {
    return { status: "needsConfirm", seller: n.sellerLogin, title: n.title };
  }
  if (!existing) {
    const stop = await addCategory(tabId, p.origin, p.id, r.bundle);
    if (stop) throw new Error(stop.message);
  }
  const res = await archive.saveBundle({ bundle: r.bundle, origin: p.origin, accountId, source: "manual" });
  recent.delete(`${tabId}:${p.id}`);
  refreshBadge(tabId, tab.url);
  refreshItemTabs(n.vintedId);
  broadcast("vy:changed", { reason: "save" });
  return summary(res);
}

/** Salvataggio di un annuncio dell'elenco di importazione: non lancia, restituisce l'esito. */
async function saveById({ origin, vintedId, tabId = null, wardrobe = null, jobId = null }) {
  try {
    const accountId = await accountFor(origin);
    return await withTab({ origin, tabId }, async (tab) => {
      const r = await askTab(tab.id, { type: "vy:read", id: String(vintedId), accountId, wardrobe });
      if (!r.ok) return { status: "failed", kind: r.kind, stop: STOP_KINDS.includes(r.kind), message: r.message };
      const stop = (await archive.findByVintedId(String(vintedId))) ? null : await addCategory(tab.id, origin, vintedId, r.bundle);
      if (stop) return { status: "failed", kind: stop.kind, stop: true, message: stop.message };
      const res = await archive.saveBundle({ bundle: r.bundle, origin, accountId, source: "import", jobId });
      refreshItemTabs(String(vintedId));
      return summary(res);
    });
  } catch (e) {
    await logError("import", e);
    return { status: "failed", kind: "error", stop: false, message: e.message };
  }
}

// ---------------------------------------------------------------- lettura per la dashboard

async function readListing({ listingId }) {
  const l = await archive.getListing(listingId);
  if (!l) throw new Error("Annuncio non trovato nell'archivio.");
  const accountId = await accountFor(l.origin);
  return withTab({ origin: l.origin, url: l.url }, async (tab) => {
    const r = await askTab(tab.id, { type: "vy:read", id: l.vintedId, accountId });
    if (!r.ok) {
      if (r.kind === "notFound") { await archive.patchMany([l.id], (x) => { x.online = "offline"; x.onlineCheckedAt = Date.now(); }); broadcast("vy:changed"); }
      return { ok: false, kind: r.kind, message: r.message };
    }
    const c = await archive.compareBundle({ bundle: r.bundle, origin: l.origin });
    refreshItemTabs(l.vintedId);
    return { ok: true, bundle: r.bundle, diffs: c?.diffs || [], changed: Boolean(c?.changed) };
  });
}

async function checkOnline({ listingId }) {
  const l = await archive.getListing(listingId);
  if (!l) throw new Error("Annuncio non trovato nell'archivio.");
  return withTab({ origin: l.origin, url: `${l.origin}/` }, async (tab) => {
    const r = await askTab(tab.id, { type: "vy:status", id: l.vintedId, mine: l.owner === "mine" });
    if (!r.ok) return { ok: false, kind: r.kind, stop: STOP_KINDS.includes(r.kind), message: r.message };
    if (r.online !== "unknown") await archive.patchMany([l.id], (x) => { x.online = r.online; x.onlineCheckedAt = Date.now(); });
    return { ok: true, online: r.online };
  });
}

/**
 * Completa gli annunci già archiviati: prima con i dati già salvati, poi una categoria alla volta.
 * Per ogni categoria senza nome: la pagina dell'annuncio come testo; se lì il percorso non c'è
 * (Vinted lo disegna con JavaScript), la pagina vera in una scheda in secondo piano, riusata per tutte.
 * Avanzamento con «vy:fill-progress». Si ferma davanti a CAPTCHA, 429 o sessione scaduta.
 */
let filling = false;
async function fillMissing() {
  if (filling) throw new Error("Il completamento è già in corso.");
  filling = true;
  let liveTab = null;
  try {
    const filledLocal = await archive.refill();
    const todo = new Map();
    for (const l of await archive.listAll()) {
      const cid = l.ids?.catalogId;
      if (l.deletedAt || l.category || !cid || todo.has(cid) || l.online === "offline" || (await archive.labelFor("catalog", cid))) continue;
      todo.set(cid, l);
    }
    const report = { filledLocal, categories: todo.size, learned: 0, approx: 0, failed: 0, stopped: null, filled: 0, byText: 0, byLive: 0 };
    const diag = { at: Date.now(), tried: todo.size, found: 0, text: { tried: 0, found: 0, links: 0, mentions: 0, status: null }, live: { tried: 0, found: 0, links: 0, mentions: 0 } };
    const progress = (done, msg) => broadcast("vy:fill-progress", { done, total: todo.size, msg });
    const step = (name) => { diag.step = name; diag.stepAt = Date.now(); return setState("fillDiag", diag).catch(() => {}); };
    if (todo.size) {
      const s = await getSettings();
      const first = [...todo.values()][0];
      let textFails = 0;
      let liveWorks = false;
      // Una scheda tutta sua, in secondo piano: non dipende dalle schede di Vinted aperte dall'utente.
      await step("apro la scheda");
      liveTab = await openBackgroundTab(`${first.origin}/`);
      await (async (tab) => {
        let i = 0;
        for (const [cid, l] of todo) {
          progress(i, l.title);
          if (i++) await new Promise((r) => setTimeout(r, s.importDelay.min + Math.random() * (s.importDelay.max - s.importDelay.min)));
          let found = null;
          // 1. testo (saltato se finora non ha mai funzionato e la pagina vera sì)
          if (!(textFails >= 2 && liveWorks)) {
            await step(`testo ${i}`);
            const r = await askTab(tab.id, { type: "vy:page", id: l.vintedId, catalogId: cid }, 45_000).catch((e) => ({ ok: false, kind: "error", message: e.message }));
            diag.text.tried++;
            if (!r.ok) diag.text.error = String(r.message || r.kind || "").slice(0, 160);
            if (r.info) { diag.text.links += r.info.links || 0; diag.text.mentions += r.info.mentions || 0; diag.text.status = r.info.status ?? diag.text.status; }
            if (!r.ok && ["captcha", "rate", "auth"].includes(r.kind)) { report.stopped = r.message; break; }
            if (r.ok && r.page?.catalog?.names?.length && String(r.page.catalog.id) === String(cid)) { found = r.page.catalog; diag.text.found++; report.byText++; } else textFails++;
          }
          // 2. pagina vera, in una scheda in secondo piano
          if (!found) {
            const url = `${l.origin}/items/${l.vintedId}`;
            await step(`pagina aperta ${i}: carico`);
            const r = await (async () => {
              await withTimeout(chrome.tabs.update(liveTab.id, { url }), 15_000, "Il browser non ha caricato la scheda in 15 secondi.");
              await new Promise((res) => setTimeout(res, 300));
              await waitComplete(liveTab.id);
              await step(`pagina aperta ${i}: leggo`);
              return askTab(liveTab.id, { type: "vy:page", id: l.vintedId, catalogId: cid, live: true }, 45_000);
            })().catch((e) => ({ ok: false, kind: "error", message: e.message }));
            diag.live.tried++;
            if (!r.ok) diag.live.error = String(r.message || r.kind || "").slice(0, 160);
            if (r.info) { diag.live.links += r.info.links || 0; diag.live.mentions += r.info.mentions || 0; }
            if (r.ok && r.page?.catalog?.names?.length && String(r.page.catalog.id) === String(cid)) { found = r.page.catalog; diag.live.found++; report.byLive++; liveWorks = true; }
          }
          if (found) {
            await archive.learnLabel("catalog", cid, found.names.join(" › "));
            report.learned++;
            if (found.approx) report.approx++;
          } else report.failed++;
        }
        progress(todo.size, null);
      })(liveTab);
    }
    diag.found = report.learned;
    await setState("fillDiag", diag);
    report.filled = (await archive.refill()) + filledLocal;
    broadcast("vy:changed", { reason: "fill" });
    return report;
  } finally {
    filling = false;
    if (liveTab) chrome.tabs.remove(liveTab.id).catch(() => {});
  }
}

async function listVintedTabs() {
  const tabs = await chrome.tabs.query({ url: VINTED_DOMAINS.map((d) => `https://www.${d}/*`) });
  return tabs.map((t) => ({ tabId: t.id, title: t.title, url: t.url, active: t.active, ...parseVintedUrl(t.url || "") }));
}

async function openDashboard(hash = "archive") {
  const base = chrome.runtime.getURL("src/ui/dashboard.html");
  const url = `${base}#${String(hash).replace(/^#/, "")}`;
  const [existing] = await chrome.tabs.query({ url: `${base}*` });
  if (existing) {
    await chrome.tabs.update(existing.id, { url, active: true });
    await chrome.windows.update(existing.windowId, { focused: true }).catch(() => {});
    return existing.id;
  }
  return (await chrome.tabs.create({ url })).id;
}

// ---------------------------------------------------------------- RPC

async function handle(method, p, sender) {
  switch (method) {
    case "page.visit": {
      const s = await getSettings();
      const accountId = await accountFor(p.origin);
      if (p.kind === "wardrobe") return { pageButton: s.pageButton, mine: Boolean(accountId) && accountId === String(p.id), accountId };
      const l = await archive.findByVintedId(p.id);
      const saved = Boolean(l && !l.deletedAt);
      if (sender.tab) refreshBadge(sender.tab.id, sender.tab.url);
      const recentCheck = l?.onlineCheckedAt && Date.now() - l.onlineCheckedAt < 10 * 60_000;
      return { pageButton: s.pageButton, publishPrompt: s.publishPrompt || "ask", saved, listingId: saved ? l.id : null, remoteChanged: saved && Boolean(l.remoteChanged), check: saved && s.checkChanges && !recentCheck, accountId };
    }
    case "page.compare": {
      const c = await archive.compareBundle({ bundle: p.bundle, origin: p.origin });
      if (sender.tab) refreshBadge(sender.tab.id, sender.tab.url);
      if (c?.changed) broadcast("vy:changed", { reason: "compare" });
      return c ? { changed: c.changed, diffs: c.diffs.length } : null;
    }
    case "save.tab": return saveFromTab(p.tabId ?? sender.tab?.id, { confirmOther: Boolean(p.confirmOther) });
    case "save.byId": return saveById(p);
    case "tab.context": {
      const tab = await chrome.tabs.get(p.tabId).catch(() => null);
      const u = parseVintedUrl(tab?.url || "");
      if (!tab || !isVintedOrigin(u.origin || "")) return { kind: "none" };
      const accountId = await accountFor(u.origin);
      if (u.kind !== "item") return { ...u, accountId, mine: u.kind === "wardrobe" && accountId === u.id };
      const l = await archive.findByVintedId(u.id);
      const saved = Boolean(l && !l.deletedAt);
      return { ...u, accountId, saved, listingId: saved ? l.id : null, title: saved ? l.title : null, remoteChanged: saved && Boolean(l.remoteChanged), owner: saved ? l.owner : null };
    }
    case "vinted.read": return readListing(p);
    case "vinted.check": return checkOnline(p);
    case "vinted.wardrobe": {
      return withTab({ origin: p.origin, tabId: p.tabId, url: `${p.origin}/member/${p.userId}` }, async (tab) => {
        const r = await askTab(tab.id, { type: "vy:wardrobe", userId: String(p.userId), page: p.page || 1 });
        return { ...r, tabId: tab.id };
      });
    }
    case "vinted.tabs": return listVintedTabs();
    case "fill.missing": return fillMissing();
    case "account.get": {
      if (p.origin) return { userId: await accountFor(p.origin), origin: p.origin };
      const tabs = await listVintedTabs();
      const origin = tabs[0]?.origin || (await getState("account", null))?.origin || "https://www.vinted.it";
      return { userId: await accountFor(origin), origin };
    }
    case "open.dashboard": {
      let hash = p.hash || "archive";
      if (sender.tab && /fromTab=1/.test(hash)) hash = hash.replace("fromTab=1", `tab=${sender.tab.id}`);
      return openDashboard(hash);
    }
    case "update.check": {
      const st = await checkUpdate({ manual: true });
      await getLinks({ force: true });
      return st;
    }
    case "update.status": return getState("update", null);
    case "update.download": return downloadUpdate();
    case "update.reload":
      // Dopo il riavvio onInstalled riapre la dashboard e dice da che versione si arriva.
      await setState("reloadFrom", { version: VERSION, at: Date.now(), reopen: p.reopen !== false });
      setTimeout(() => chrome.runtime.reload(), 150);
      return true;
    case "links.get": return getLinks({ force: Boolean(p.force) });
    case "diag.save": {
      // Solo esiti tecnici (codice HTTP, tipo di errore, da dove arriva il token): niente id, titoli o token.
      const calls = {};
      for (const [k, v] of Object.entries(p.calls || {})) if (/^[a-z_ ]{2,20}$/i.test(k)) calls[k] = { status: Number(v?.status) || 0, kind: String(v?.kind || "").slice(0, 20), retried: Boolean(v?.retried), at: Number(v?.at) || Date.now() };
      const prev = await getState("probe", { calls: {} });
      await setState("probe", { csrf: p.csrf ? String(p.csrf).slice(0, 20) : prev.csrf || null, calls: { ...prev.calls, ...calls }, version: String(p.version || "").slice(0, 12), at: Date.now() });
      return true;
    }
    case "changed": broadcast("vy:changed", { reason: p.reason || "ui" }); return true;
    case "popup.summary": {
      const all = (await archive.listAll()).filter((l) => !l.deletedAt);
      const s = await getSettings();
      return {
        version: VERSION,
        mine: all.filter((l) => l.owner === "mine").length,
        others: all.filter((l) => l.owner !== "mine").length,
        recent: all.sort((a, b) => b.savedAt - a.savedAt).slice(0, 5).map((l) => ({ id: l.id, title: l.title, price: l.price, currency: l.currency, coverImageId: l.coverImageId })),
        backupDue: all.length > 0 && backupDue(s.backup.lastAt, s.backup.remindDays),
        lastBackupAt: s.backup.lastAt,
        lastCheckAt: s.wardrobe?.lastCheckAt || null,
        update: await getState("update", null),
      };
    }
    default: throw new Error(`Operazione sconosciuta: ${method}`);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, send) => {
  if (!msg || sender.id !== chrome.runtime.id) return false;
  if (msg.type === "vy:tokens") {
    chrome.storage.session.get("tokens").then(({ tokens = {} }) => send(tokens[msg.origin] || {}), () => send({}));
    return true;
  }
  if (msg.type !== "vy:rpc") return false;
  handle(msg.method, msg.params || {}, sender).then(
    (r) => send(r === undefined ? null : r),
    async (e) => { await logError(msg.method, e); send({ __error: true, error: e?.message || String(e) }); },
  );
  return true;
});

// ---------------------------------------------------------------- pianificazione

async function ensureAlarms() {
  if (!(await chrome.alarms.get("update"))) chrome.alarms.create("update", { delayInMinutes: 2, periodInMinutes: UPDATE_EVERY_MIN });
  if (!(await chrome.alarms.get("daily"))) chrome.alarms.create("daily", { delayInMinutes: 5, periodInMinutes: 24 * 60 });
}

async function notify(id, title, message) {
  try { await chrome.notifications.create(id, { type: "basic", iconUrl: chrome.runtime.getURL("icons/icon128.png"), title, message }); } catch { /* notifiche disattivate */ }
}

async function onAlarm(name) {
  const s = await getSettings();
  if (name === "update") {
    await getLinks();
    if (!s.updates.auto) return;
    const st = await checkUpdate();
    if (await shouldNotify(st)) await notify("update", `${APP} ${st.latest} disponibile`, "Apri Vintory › Impostazioni › Aggiornamenti per le novità e il download.");
  }
  if (name === "daily") {
    const purged = await archive.purgeExpired();
    if (purged) broadcast("vy:changed", { reason: "purge" });
    const total = await db.count("listings");
    const remindedToday = s.backup.lastRemindedAt && Date.now() - s.backup.lastRemindedAt < 23 * 3600e3;
    if (total && !remindedToday && backupDue(s.backup.lastAt, s.backup.remindDays)) {
      await saveSettings({ backup: { lastRemindedAt: Date.now() } });
      await notify("backup", "È ora di un backup", s.backup.lastAt ? `L'ultimo backup di Vintory ha più di ${s.backup.remindDays} giorni.` : "Non hai ancora fatto un backup dell'archivio di Vintory. Se rimuovi l'estensione, l'archivio va perso.");
    }
  }
}

chrome.alarms.onAlarm.addListener((a) => { onAlarm(a.name).catch((e) => logError(`alarm:${a.name}`, e)); });
chrome.notifications.onClicked.addListener((id) => { openDashboard(id === "update" ? "settings" : "backup"); chrome.notifications.clear(id); });
chrome.runtime.onInstalled.addListener(async (d) => {
  await ensureAlarms();
  if (d.reason === "install") { await setState("installedAt", Date.now()); openDashboard("welcome"); }
  if (d.reason === "update") {
    const from = await getState("reloadFrom", null);
    await setState("reloadFrom", null);
    if (from && Date.now() - from.at < 5 * 60_000) {
      await setState("justUpdated", { from: from.version, to: VERSION, at: Date.now() });
      if (from.reopen) openDashboard("archive");
    }
  }
  // Dopo un aggiornamento: completa gli annunci con i dati già salvati (nessuna richiesta a Vinted).
  if (d.reason === "update") archive.refill().then((n) => { if (n) broadcast("vy:changed", { reason: "refill" }); }).catch((e) => logError("refill", e));
});
chrome.runtime.onStartup.addListener(ensureAlarms);
ensureAlarms().catch(() => {});
