/**
 * Lettura di Vinted dentro la pagina: le stesse API interne che usa il sito,
 * solo GET e solo i percorsi ammessi da VYGuard. Intestazioni come in Vinted_Relist.
 * Non è un'API ufficiale: se Vinted cambia formato, le funzioni lo dicono
 * invece di restituire dati incompleti. CAPTCHA, 403 e 429 fermano tutto: mai aggirati.
 */
(() => {
  "use strict";
  const VY = (globalThis.VY = globalThis.VY || {});
  const ORIGIN = location.origin;
  const BASE = `${ORIGIN}/api/v2`;
  const STOP = ["captcha", "blocked", "rate", "auth"];

  const cookie = (name) => document.cookie.split("; ").find((c) => c.startsWith(`${name}=`))?.split("=").slice(1).join("=") || null;
  const text = (el) => (el?.textContent || "").replace(/\s+/g, " ").trim();

  function csrfFromDom() {
    const meta = document.querySelector('meta[name="csrf-token"]');
    if (meta?.content) return meta.content;
    const t = document.getElementById("__NEXT_DATA__")?.textContent || "";
    const m = t.match(/"csrfToken"\s*:\s*"([^"]{16,})"/i) || t.match(/"CSRF_TOKEN"\s*:\s*"([^"]{16,})"/i);
    return m ? m[1] : null;
  }

  async function headers() {
    const h = { Accept: "application/json, text/plain, */*", locale: cookie("user-iso-locale") || cookie("anonymous-iso-locale") || document.documentElement.lang || "it-IT" };
    let tokens = {};
    try { tokens = (await chrome.runtime.sendMessage({ type: "vy:tokens", origin: ORIGIN })) || {}; } catch { /* estensione ricaricata: si prova con la pagina */ }
    const csrf = tokens.csrf || csrfFromDom();
    if (csrf) h["X-CSRF-Token"] = csrf;
    const anon = tokens.anonId || cookie("anon_id");
    if (anon) h["X-Anon-Id"] = anon;
    return h;
  }

  /**
   * L'unica funzione che parla con Vinted: GET classificata, non lancia per errori HTTP.
   * kind "api" → /api/v2 + percorso (risposta JSON); kind "page" → pagina pubblica dell'annuncio (conta solo lo stato).
   */
  async function request(kind, path, timeoutMs = 20_000) {
    globalThis.VYGuard.assertAllowed("GET", path, kind);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await fetch((kind === "page" ? ORIGIN : BASE) + path, { method: "GET", credentials: "include", cache: "no-store", redirect: "follow", headers: kind === "page" ? { Accept: "text/html" } : await headers(), signal: ctrl.signal });
    } catch (e) {
      return { ok: false, kind: "network", status: 0, message: e?.name === "AbortError" ? `Vinted non ha risposto entro ${timeoutMs / 1000} secondi` : "Connessione a Vinted non riuscita" };
    } finally {
      clearTimeout(timer);
    }
    const body = await res.text().catch(() => "");
    let data = null;
    try { data = body ? JSON.parse(body) : null; } catch { data = null; }
    if (res.ok && kind === "page") return { ok: true, status: res.status, finalPath: new URL(res.url || ORIGIN + path).pathname };
    if (res.ok) return data ? { ok: true, status: res.status, data } : { ok: false, kind: "format", status: res.status, message: "Risposta di Vinted non leggibile" };
    // Una verifica arriva con 403, 429 o 503: una normale pagina 404 può citare «challenge» nei suoi script senza esserlo.
    const challenge = [403, 429, 503].includes(res.status) && /captcha-delivery|datadome|hcaptcha|recaptcha|challenge/i.test(body.slice(0, 3000));
    let cls = "http";
    if (challenge) cls = "captcha";
    else if (res.status === 403) cls = "blocked";
    else if (res.status === 429) cls = "rate";
    else if (res.status === 401) cls = "auth";
    else if (res.status === 404 || res.status === 410) cls = "notFound";
    else if (res.status >= 500) cls = "server";
    return { ok: false, kind: cls, status: res.status, message: data?.message || data?.error || `HTTP ${res.status}` };
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
    blocked: "Vinted ha rifiutato la richiesta (403). Vintory si ferma: riprova più tardi.",
    rate: "Vinted sta limitando le richieste (429). Vintory si ferma: riprova tra qualche minuto.",
    auth: "Sessione Vinted non valida: accedi a Vinted e riprova.",
  };
  const fail = (r) => ({ ok: false, kind: r.kind, status: r.status, message: MESSAGES[r.kind] || r.message, version: VY.version });

  const onItemPage = (id) => new RegExp(`^/items/${id}(?:$|[-/])`).test(location.pathname);

  /** Dati letti dalla pagina dell'annuncio: etichette, percorso della categoria, JSON-LD. */
  function readPage(id) {
    const out = { id: String(id), url: ORIGIN + location.pathname, attrs: {}, breadcrumbs: [], photos: [] };
    for (const el of document.querySelectorAll('[data-testid^="item-attributes-"]')) {
      const key = el.getAttribute("data-testid").slice("item-attributes-".length);
      if (!/^[a-z_]{2,30}$/.test(key)) continue;
      const valueEl = el.querySelector('[itemprop], [data-testid$="-value"]') || (el.children.length > 1 ? el.lastElementChild : el);
      const v = text(valueEl);
      if (v && v.length <= 120) out.attrs[key] = v;
    }
    const seen = new Set();
    for (const el of document.querySelectorAll('[data-testid*="breadcrumb" i] a, nav[aria-label*="breadcrumb" i] a, [itemtype*="BreadcrumbList"] [itemprop="name"]')) {
      const c = text(el);
      if (!c || c.length > 60 || seen.has(c) || /^(home|vinted)$/i.test(c)) continue;
      seen.add(c);
      out.breadcrumbs.push(c);
    }
    out.breadcrumbs = out.breadcrumbs.slice(0, 6);
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
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
    if (!out.title) out.title = document.querySelector('meta[property="og:title"]')?.content || null;
    if (!out.photos.length) {
      const og = document.querySelector('meta[property="og:image"]')?.content;
      if (og && /^https:\/\//.test(og)) out.photos = [og];
    }
    // Venditore: dall'intorno dell'id nei dati incorporati (i link /member/ della pagina possono essere i tuoi).
    const scripts = [...document.querySelectorAll("script:not([src])")].map((s) => s.textContent || "").join("\n");
    const i = scripts.search(new RegExp(`"id"\\s*:\\s*${id}\\b`));
    if (i >= 0) {
      const around = scripts.slice(Math.max(0, i - 4000), i + 8000).replace(/\\"/g, '"');
      const seller = around.match(/"user_id"\s*:\s*(\d+)/) || around.match(/"user"\s*:\s*\{\s*"id"\s*:\s*(\d+)/);
      if (seller) out.sellerId = seller[1];
    }
    return out;
  }

  /**
   * Legge un annuncio.
   *  1. scheda (/items/:id/details, poi /items/:id)
   *  2. se può essere tuo: dati del modulo di vendita (/item_upload/items/:id, solo il proprietario)
   *  3. se sei sulla sua pagina: etichette e categoria dal DOM
   */
  VY.read = async ({ id, accountId = null, wardrobe = null }) => {
    if (!/^\d+$/.test(String(id))) return { ok: false, kind: "input", message: "Id dell'annuncio non valido", version: VY.version };
    const bundle = {};
    let notFound = 0;
    let r = await get(`/items/${id}/details`);
    if (STOP.includes(r.kind)) return fail(r);
    if (r.ok && r.data?.item) bundle.details = r.data.item;
    else {
      if (r.kind === "notFound") notFound++;
      r = await get(`/items/${id}`);
      if (STOP.includes(r.kind)) return fail(r);
      if (r.ok && r.data?.item) bundle.details = r.data.item;
      else if (r.kind === "notFound") notFound++;
    }
    if (onItemPage(id)) bundle.page = readPage(id);
    if (wardrobe && String(wardrobe.id) === String(id)) bundle.wardrobe = wardrobe;
    const seller = bundle.details?.user?.id ?? bundle.details?.user_id ?? bundle.wardrobe?.user?.id ?? bundle.wardrobe?.user_id ?? bundle.page?.sellerId ?? null;
    if (accountId && (seller == null || String(seller) === String(accountId))) {
      const u = await get(`/item_upload/items/${id}`);
      if (u.kind === "captcha" || u.kind === "rate") return fail(u);
      if (u.ok && u.data?.item) bundle.upload = u.data.item;
      else if (u.kind === "notFound") notFound++;
    }
    const pageUsable = Boolean(bundle.page?.title);
    if (!bundle.details && !bundle.upload && !pageUsable && !bundle.wardrobe) {
      const st = notFound >= 2 ? await pageStatus(id) : "unknown";
      if (typeof st === "object") return fail(st);
      if (st === "offline") return { ok: false, kind: "notFound", status: 404, message: "Annuncio non trovato su Vinted: può essere stato eliminato.", version: VY.version };
      return { ok: false, kind: "unavailable", message: "Vinted non ha fornito i dati dell'annuncio: apri la sua pagina e salvalo da lì.", version: VY.version };
    }
    if (bundle.page && !pageUsable && !Object.keys(bundle.page.attrs).length && !bundle.page.breadcrumbs.length) delete bundle.page;
    return { ok: true, bundle, version: VY.version };
  };

  /** L'annuncio è ancora online? online · sold · offline · unknown (F43). */
  VY.status = async ({ id, mine = false }) => {
    const paths = [`/items/${id}/details`, `/items/${id}`];
    if (mine) paths.unshift(`/item_upload/items/${id}`);
    for (const p of paths) {
      const r = await get(p);
      if (STOP.includes(r.kind) && !(mine && p.startsWith("/item_upload") && r.kind !== "captcha" && r.kind !== "rate")) return fail(r);
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
