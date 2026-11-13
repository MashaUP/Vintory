/**
 * Lettura di Vinted dentro la pagina: le stesse API interne che usa il sito,
 * solo GET e solo i percorsi ammessi da VYGuard. Intestazioni come in Vinted_Relist.
 * Non è un'API ufficiale: se Vinted cambia formato, le funzioni lo dicono
 * invece di restituire dati incompleti. CAPTCHA e 429 fermano tutto; un 403 rinnova il token
 * una volta sola, poi si passa a un'altra fonte. Nessun controllo viene mai aggirato.
 */
(() => {
  "use strict";
  const VY = (globalThis.VY = globalThis.VY || {});
  const ORIGIN = location.origin;
  const BASE = `${ORIGIN}/api/v2`;
  const STOP = ["captcha", "blocked", "rate", "auth"];   // fermano la pagina di stato e l'armadio

  const cookie = (name) => document.cookie.split("; ").find((c) => c.startsWith(`${name}=`))?.split("=").slice(1).join("=") || null;
  const text = (el) => (el?.textContent || "").replace(/\s+/g, " ").trim();

  // ---------------------------------------------------------------- token CSRF
  // Come Vinted_Relist: token intercettato dalle richieste del sito, poi quello negli
  // script della pagina (anche con le virgolette protette da «\\», come nel payload di
  // Next.js), poi la pagina «Vendi». Un 403 rinnova il token e riprova una volta sola.
  const CSRF_PATTERNS = [/"csrfToken"\s*:\s*"([^"]{16,})"/i, /"CSRF_TOKEN"\s*:\s*"([^"]{16,})"/i, /csrf[-_]?token["'\s:=]+([A-Za-z0-9_\-+/=]{16,})/i];
  function csrfIn(text) {
    if (!text) return null;
    const plain = text.replace(/\\+"/g, '"');
    const meta = plain.match(/<meta[^>]+name=["']csrf-token["'][^>]+content=["']([^"']{16,})["']/i);
    if (meta) return meta[1];
    for (const re of CSRF_PATTERNS) { const m = plain.match(re); if (m) return m[1]; }
    return null;
  }
  function csrfFromDom() {
    const meta = document.querySelector('meta[name="csrf-token"]')?.content;
    if (meta && meta.length >= 16) return meta;
    return csrfIn(document.getElementById("__NEXT_DATA__")?.textContent) || csrfIn([...document.querySelectorAll("script:not([src])")].map((x) => x.textContent || "").join("\n"));
  }
  async function csrfFromSellPage() {
    const r = await request("page", "/items/new", 20_000, { html: true });
    return r.ok ? csrfIn(r.html) : null;
  }
  async function sniffed() {
    try { return (await chrome.runtime.sendMessage({ type: "vy:tokens", origin: ORIGIN })) || {}; } catch { return {}; }
  }

  let csrf = null;
  async function token(force = false) {
    if (csrf && !force) return csrf;
    const old = csrf;
    const s = await sniffed();
    const sources = force
      ? [["pagina", csrfFromDom], ["pagina Vendi", csrfFromSellPage], ["intercettato", async () => s.csrf]]
      : [["intercettato", async () => s.csrf], ["pagina", csrfFromDom], ["pagina Vendi", csrfFromSellPage]];
    let found = null;
    for (const [name, fn] of sources) {
      const v = await fn();
      if (!v) continue;
      if (!found) found = [name, v];
      if (!force || v !== old) { found = [name, v]; break; }
    }
    csrf = found ? found[1] : null;
    VY.diag.csrf = found ? found[0] : "non trovato";
    return csrf;
  }

  async function headers() {
    const h = { Accept: "application/json, text/plain, */*", locale: cookie("user-iso-locale") || cookie("anonymous-iso-locale") || "it-IT" };
    const t = await token();
    if (t) h["X-CSRF-Token"] = t;
    const anon = (await sniffed()).anonId || cookie("anon_id");
    if (anon) h["X-Anon-Id"] = anon;
    return h;
  }

  // ---------------------------------------------------------------- diagnostica (senza dati personali)
  VY.diag = { csrf: null, calls: {} };
  const endpointOf = (kind, path) => (kind === "page" ? (path === "/items/new" ? "pagina Vendi" : "pagina annuncio") : path.startsWith("/item_upload") ? "item_upload" : path.startsWith("/wardrobe") ? "wardrobe" : "items");
  function note(kind, path, r, retried) {
    VY.diag.calls[endpointOf(kind, path)] = { status: r.status, kind: r.ok ? "ok" : r.kind, retried, at: Date.now() };
    try { chrome.runtime.sendMessage({ type: "vy:rpc", method: "diag.save", params: { csrf: VY.diag.csrf, calls: VY.diag.calls, version: VY.version } }).catch(() => {}); } catch { /* estensione ricaricata */ }
  }

  /**
   * L'unica funzione che parla con Vinted: GET classificata, non lancia per errori HTTP.
   * kind "api" → /api/v2 + percorso (risposta JSON); kind "page" → pagina del sito (stato, e il testo con html: true).
   */
  async function request(kind, path, timeoutMs = 20_000, { html = false, retried = false } = {}) {
    globalThis.VYGuard.assertAllowed("GET", path, kind);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await fetch((kind === "page" ? ORIGIN : BASE) + path, { method: "GET", credentials: "include", cache: "no-store", redirect: "follow", headers: kind === "page" ? { Accept: "text/html" } : await headers(), signal: ctrl.signal });
    } catch (e) {
      const r = { ok: false, kind: "network", status: 0, message: e?.name === "AbortError" ? `Vinted non ha risposto entro ${timeoutMs / 1000} secondi` : "Connessione a Vinted non riuscita" };
      note(kind, path, r, retried);
      return r;
    } finally {
      clearTimeout(timer);
    }
    const body = await res.text().catch(() => "");
    let data = null;
    if (kind === "api") try { data = body ? JSON.parse(body) : null; } catch { data = null; }
    let r;
    if (res.ok && kind === "page") r = { ok: true, status: res.status, finalPath: new URL(res.url || ORIGIN + path).pathname, html: html ? body : undefined };
    else if (res.ok) r = data ? { ok: true, status: res.status, data } : { ok: false, kind: "format", status: res.status, message: "Risposta di Vinted non leggibile" };
    else {
      // Una verifica arriva con 403, 429 o 503: una normale pagina 404 può citare «challenge» nei suoi script senza esserlo.
      const challenge = [403, 429, 503].includes(res.status) && /captcha-delivery|datadome|hcaptcha|recaptcha|challenge/i.test(body.slice(0, 3000));
      let cls = "http";
      if (challenge) cls = "captcha";
      else if (res.status === 403) cls = "blocked";
      else if (res.status === 429) cls = "rate";
      else if (res.status === 401) cls = "auth";
      else if (res.status === 404 || res.status === 410) cls = "notFound";
      else if (res.status >= 500) cls = "server";
      r = { ok: false, kind: cls, status: res.status, message: data?.message || data?.error || `HTTP ${res.status}` };
    }
    note(kind, path, r, retried);
    // 403 senza verifica: di solito è il token scaduto o mancante. Uno e un solo nuovo tentativo, con un token rinnovato.
    if (kind === "api" && r.kind === "blocked" && !retried) {
      await token(true);
      return request(kind, path, timeoutMs, { html, retried: true });
    }
    return r;
  }

  const get = (path, timeoutMs) => request("api", path, timeoutMs);

  /**
   * La pagina pubblica dell'annuncio esiste ancora? online · offline · unknown, oppure l'errore che ferma tutto.
   * Un 404 delle API da solo non basta: se Vinted cambiasse le API, ogni annuncio sembrerebbe eliminato.
   */
  async function pageStatus(id) {
    const r = await request("page", `/items/${id}`);
    if (r.ok) return new RegExp(`^/items/${id}(?:$|[-/])`).test(r.finalPath) ? "online" : "unknown";
    if (STOP.includes(r.kind)) return r;
    return r.kind === "notFound" ? "offline" : "unknown";
  }

  const MESSAGES = {
    captcha: "Vinted chiede una verifica (CAPTCHA): completala nella pagina e riprova. Vintory si ferma.",
    blocked: "Vinted ha rifiutato la richiesta (403) anche con un token nuovo. Vintory si ferma: ricarica la pagina di Vinted e riprova più tardi.",
    rate: "Vinted sta limitando le richieste (429). Vintory si ferma: riprova tra qualche minuto.",
    auth: "Sessione Vinted non valida: accedi a Vinted e riprova.",
  };
  const fail = (r) => ({ ok: false, kind: r.kind, status: r.status, message: MESSAGES[r.kind] || r.message, version: VY.version });

  const onItemPage = (id) => new RegExp(`^/items/${id}(?:$|[-/])`).test(location.pathname);

  /**
   * Percorso della categoria dai link /catalog/<id>-… della pagina dell'annuncio.
   * Si cerca il contenitore delle «briciole»; se non è riconoscibile, la lista (ol/ul/nav) che
   * contiene il link alla categoria dell'annuncio. Il menu del sito non conta: non finisce con quella categoria.
   */
  function catalogTrail(doc, wantId = null) {
    const links = [...doc.querySelectorAll('a[href*="/catalog/"]')].map((a) => ({ a, id: (a.getAttribute("href") || "").match(/\/catalog\/(\d+)/)?.[1] || null, name: text(a) })).filter((x) => x.id && x.name && x.name.length <= 60);
    const CRUMBS = '[data-testid*="breadcrumb" i], nav[aria-label*="breadcrumb" i], [itemtype*="BreadcrumbList"], [class*="breadcrumb" i]';
    let box = links.find((x) => x.a.closest(CRUMBS))?.a.closest(CRUMBS) || null;
    if (!box && wantId) box = [...links].reverse().find((x) => x.id === String(wantId))?.a.closest("ol, ul, nav") || null;
    // Senza il numero della categoria: la prima lista di link /catalog/ fuori da intestazione e piè di pagina.
    if (!box && !wantId) box = links.filter((x) => !x.a.closest("header, footer")).map((x) => x.a.closest("ol, ul")).find(Boolean) || null;
    let chain = [];
    if (box) {
      const seen = new Set();
      for (const x of links) {
        if (!box.contains(x.a) || seen.has(x.id)) continue;
        seen.add(x.id);
        chain.push({ id: x.id, name: x.name });
        if (wantId && x.id === String(wantId)) break;
      }
    }
    if (!chain.length) {
      // Ripiego: dati strutturati BreadcrumbList.
      for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) {
        try {
          const bl = [].concat(JSON.parse(s.textContent)).find((x) => x && x["@type"] === "BreadcrumbList");
          const items = (bl?.itemListElement || []).map((e) => ({ id: String(e?.item?.["@id"] || e?.item || "").match(/\/catalog\/(\d+)/)?.[1] || null, name: String(e?.name || e?.item?.name || "").trim() })).filter((x) => x.id && x.name);
          if (items.length) { chain = items; break; }
        } catch { /* JSON-LD non valido */ }
      }
    }
    if (wantId) { const i = chain.findIndex((c) => c.id === String(wantId)); chain = i >= 0 ? chain.slice(0, i + 1) : []; }
    if (!chain.length || chain.length > 8) return null;
    return { id: chain[chain.length - 1].id, names: chain.map((c) => c.name) };
  }

  /** Dati letti dalla pagina dell'annuncio: etichette, percorso della categoria, JSON-LD. */
  function readPage(id, doc = document, pathname = location.pathname, catalogId = null) {
    const out = { id: String(id), url: ORIGIN + pathname, attrs: {}, breadcrumbs: [], photos: [] };
    for (const el of doc.querySelectorAll('[data-testid^="item-attributes-"]')) {
      const key = el.getAttribute("data-testid").slice("item-attributes-".length);
      if (!/^[a-z_]{2,30}$/.test(key)) continue;
      const valueEl = el.querySelector('[itemprop], [data-testid$="-value"]') || (el.children.length > 1 ? el.lastElementChild : el);
      const v = text(valueEl);
      if (v && v.length <= 120) out.attrs[key] = v;
    }
    const seen = new Set();
    for (const el of doc.querySelectorAll('[data-testid*="breadcrumb" i] a, nav[aria-label*="breadcrumb" i] a, [itemtype*="BreadcrumbList"] [itemprop="name"]')) {
      const c = text(el);
      if (!c || c.length > 60 || seen.has(c) || /^(home|vinted)$/i.test(c)) continue;
      seen.add(c);
      out.breadcrumbs.push(c);
    }
    out.breadcrumbs = out.breadcrumbs.slice(0, 6);
    out.catalog = catalogTrail(doc, catalogId);
    for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const p = [].concat(JSON.parse(s.textContent)).find((x) => x && x["@type"] === "Product");
        if (!p) continue;
        out.title = typeof p.name === "string" ? p.name : out.title;
        out.description = typeof p.description === "string" ? p.description : out.description;
        const offer = [].concat(p.offers || [])[0];
        if (offer?.price != null) { out.price = offer.price; out.currency = offer.priceCurrency || null; }
        const brand = typeof p.brand === "string" ? p.brand : p.brand?.name;
        if (brand && !out.attrs.brand) out.attrs.brand = String(brand);
        out.photos = [].concat(p.image || []).filter((u) => typeof u === "string" && /^https:\/\//.test(u));
      } catch { /* JSON-LD non valido: si ignora */ }
    }
    if (!out.title) out.title = doc.querySelector('meta[property="og:title"]')?.content || null;
    if (!out.photos.length) {
      const og = doc.querySelector('meta[property="og:image"]')?.content;
      if (og && /^https:\/\//.test(og)) out.photos = [og];
    }
    // Venditore: dall'intorno dell'id nei dati incorporati (i link /member/ della pagina possono essere i tuoi).
    const scripts = [...doc.querySelectorAll("script:not([src])")].map((s) => s.textContent || "").join("\n");
    const i = scripts.search(new RegExp(`"id"\\s*:\\s*${id}\\b`));
    if (i >= 0) {
      const around = scripts.slice(Math.max(0, i - 4000), i + 8000).replace(/\\"/g, '"');
      const seller = around.match(/"user_id"\s*:\s*(\d+)/) || around.match(/"user"\s*:\s*\{\s*"id"\s*:\s*(\d+)/);
      if (seller) out.sellerId = seller[1];
    }
    return out;
  }

  const HARD = ["captcha", "rate", "auth"];
  let itemApiRefused = false;   // /items/:id rifiutato anche con un token nuovo: per i tuoi annunci non si richiede più

  /** Dati dalla pagina pubblica dell'annuncio, scaricata come testo (non viene aperta né eseguita). */
  async function fetchPage(id, catalogId = null) {
    const r = await request("page", `/items/${id}`, 20_000, { html: true });
    if (!r.ok) return r;
    if (!new RegExp(`^/items/${id}(?:$|[-/])`).test(r.finalPath)) return { ok: false, kind: "notFound", status: 404 };
    const doc = new DOMParser().parseFromString(r.html || "", "text/html");
    return { ok: true, page: readPage(id, doc, r.finalPath, catalogId) };
  }
  const usable = (p) => Boolean(p && (p.title || Object.keys(p.attrs).length || p.breadcrumbs.length || p.catalog));

  /**
   * Legge un annuncio, dalla fonte più affidabile alla meno:
   *  1. se può essere tuo: dati del modulo di vendita (/item_upload/items/:id), come Vinted_Relist;
   *  2. scheda dell'annuncio (/items/:id);
   *  3. la pagina dell'annuncio: quella aperta, oppure scaricata come testo se le API non hanno risposto.
   * Si ferma subito solo davanti a CAPTCHA, 429 o sessione scaduta. Un 403 su una fonte passa alla successiva.
   */
  VY.read = async ({ id, accountId = null, wardrobe = null }) => {
    if (!/^\d+$/.test(String(id))) return { ok: false, kind: "input", message: "Id dell'annuncio non valido", version: VY.version };
    const bundle = {};
    const refused = [];
    let notFound = 0;
    if (onItemPage(id)) bundle.page = readPage(id);
    if (wardrobe && String(wardrobe.id) === String(id)) bundle.wardrobe = wardrobe;
    const knownSeller = bundle.wardrobe?.user?.id ?? bundle.wardrobe?.user_id ?? bundle.page?.sellerId ?? null;
    if (accountId && (knownSeller == null || String(knownSeller) === String(accountId))) {
      const u = await get(`/item_upload/items/${id}`);
      if (HARD.includes(u.kind)) return fail(u);
      if (u.ok && u.data?.item) bundle.upload = u.data.item;
      else if (u.kind === "notFound") notFound++;
      else if (u.kind === "blocked") refused.push("modulo di vendita");
    }
    if (!(bundle.upload && itemApiRefused)) {
      const r = await get(`/items/${id}`);
      if (HARD.includes(r.kind)) return fail(r);
      if (r.ok && r.data?.item) bundle.details = r.data.item;
      else if (r.kind === "notFound") notFound++;
      else if (r.kind === "blocked") { refused.push("scheda"); if (bundle.upload) itemApiRefused = true; }
    }
    const catalogId = bundle.upload?.catalog_id ?? bundle.details?.catalog_id ?? null;
    if (bundle.page && catalogId != null) bundle.page.catalog = catalogTrail(document, catalogId) || bundle.page.catalog;
    if (!bundle.details && !bundle.upload && !usable(bundle.page)) {
      const p = await fetchPage(id);
      if (HARD.includes(p.kind)) return fail(p);
      if (p.ok && usable(p.page)) bundle.page = p.page;
      else if (p.kind === "notFound") return { ok: false, kind: "notFound", status: 404, message: "Annuncio non trovato su Vinted: può essere stato eliminato.", version: VY.version };
      else if (p.kind === "blocked") refused.push("pagina");
    }
    if (!bundle.details && !bundle.upload && !usable(bundle.page) && !bundle.wardrobe) {
      if (refused.length) return { ok: false, kind: "blocked", status: 403, message: `Vinted ha rifiutato la lettura (403: ${refused.join(", ")}) anche con un token nuovo. Vintory si ferma: ricarica la pagina di Vinted e riprova più tardi.`, version: VY.version };
      return { ok: false, kind: "unavailable", message: notFound ? "Vinted non ha fornito i dati dell'annuncio." : "Vinted non ha fornito i dati dell'annuncio: apri la sua pagina e salvalo da lì.", version: VY.version };
    }
    if (bundle.page && !usable(bundle.page)) delete bundle.page;
    return { ok: true, bundle, version: VY.version };
  };

  /** Solo la pagina dell'annuncio, scaricata come testo: serve a imparare il nome di una categoria. */
  VY.page = async ({ id, catalogId = null }) => {
    if (!/^\d+$/.test(String(id))) return { ok: false, kind: "input", message: "Id dell'annuncio non valido", version: VY.version };
    const p = await fetchPage(id, catalogId);
    if (!p.ok) return { ok: false, kind: p.kind, status: p.status, message: MESSAGES[p.kind] || p.message || "Pagina dell'annuncio non leggibile", version: VY.version };
    return { ok: true, page: p.page, version: VY.version };
  };

  /** L'annuncio è ancora online? online · sold · offline · unknown (F43). */
  VY.status = async ({ id, mine = false }) => {
    const paths = [`/items/${id}`];
    if (mine) paths.unshift(`/item_upload/items/${id}`);
    for (const p of paths) {
      const r = await get(p);
      if (HARD.includes(r.kind)) return fail(r);
      if (r.ok && r.data?.item) {
        const it = r.data.item;
        const closing = String(it.item_closing_action ?? "").toLowerCase();
        const sold = it.is_sold === true || it.is_closed === true || /sold/.test(closing) || String(it.status ?? "").toLowerCase() === "sold";
        return { ok: true, online: sold ? "sold" : "online", version: VY.version };
      }
    }
    // Nessuna API ha dato l'annuncio: decide la sua pagina pubblica.
    const st = await pageStatus(id);
    if (typeof st === "object") return fail(st);
    return { ok: true, online: st, version: VY.version };
  };

  /** Annunci visibili nella griglia della pagina dell'armadio (ripiego senza API). */
  function wardrobeFromDom(userId) {
    const seen = new Map();
    for (const a of document.querySelectorAll('main a[href*="/items/"], [role="main"] a[href*="/items/"]')) {
      const m = (a.getAttribute("href") || "").match(/\/items\/(\d+)/);
      if (!m || seen.has(m[1])) continue;
      if (a.closest('[data-testid*="notification" i], header, nav')) continue;
      const card = a.closest('[data-testid*="item" i]') || a.parentElement || a;
      const img = card.querySelector("img");
      const priceText = [...card.querySelectorAll("p, span, h3, div")].map((x) => text(x)).find((t) => /\d[\d.,]*\s?€|€\s?\d/.test(t) && t.length < 20);
      seen.set(m[1], {
        id: Number(m[1]),
        title: img?.getAttribute("alt")?.split(",")[0] || a.getAttribute("title") || text(a).slice(0, 120) || `Annuncio ${m[1]}`,
        url: new URL(a.getAttribute("href"), ORIGIN).href.split("?")[0],
        price: priceText ? priceText.replace(/[^\d,.]/g, "") : null,
        photo: img ? { url: img.currentSrc || img.src } : null,
        user_id: Number(userId),
      });
    }
    return [...seen.values()];
  }

  /** Una pagina dell'elenco di un armadio. */
  VY.wardrobe = async ({ userId, page = 1 }) => {
    if (!/^\d+$/.test(String(userId))) return { ok: false, kind: "input", message: "Id dell'armadio non valido", version: VY.version };
    const r = await get(`/wardrobe/${userId}/items?page=${Number(page) || 1}&per_page=96&order=newest_first`, 30_000);
    if (STOP.includes(r.kind)) return fail(r);
    if (r.ok && Array.isArray(r.data?.items)) {
      const items = r.data.items;
      return { ok: true, method: "api", items, page, totalPages: r.data.pagination?.total_pages ?? null, total: r.data.pagination?.total_entries ?? null, sellerLogin: items[0]?.user?.login || null, version: VY.version };
    }
    if (page === 1 && new RegExp(`^/member/${userId}(?:$|[-/])`).test(location.pathname)) {
      const items = wardrobeFromDom(userId);
      if (items.length) return { ok: true, method: "dom", items, page: 1, totalPages: 1, total: items.length, sellerLogin: null, version: VY.version, note: "Lettura dalla pagina: solo gli annunci già visibili. Scorri l'armadio fino in fondo e ripeti per vederli tutti." };
    }
    return { ok: false, kind: r.ok ? "format" : r.kind, message: r.ok ? "L'elenco dell'armadio ha un formato non riconosciuto: Vinted potrebbe averlo cambiato." : `Lettura dell'armadio non riuscita (${r.message}). Apri l'armadio su Vinted e riprova da lì.`, version: VY.version };
  };

  VY.pageKind = () => {
    const item = location.pathname.match(/^\/items\/(\d+)/);
    if (item && !/\/edit$/.test(location.pathname)) return { kind: "item", id: item[1], origin: ORIGIN };
    const member = location.pathname.match(/^\/member\/(\d+)/);
    if (member) return { kind: "wardrobe", id: member[1], origin: ORIGIN };
    return { kind: "other", id: null, origin: ORIGIN };
  };
})();
