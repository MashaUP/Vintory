/**
 * Modello dell'annuncio: funzioni pure, senza chrome.* né rete.
 * Vinted ha cambiato forma alle risposte più volte: si accettano le varianti note
 * e resta null ciò che non c'è. Nessun dato viene inventato.
 */
import { CONDITION_BY_STATUS_ID, FIELD_LABELS, RELIST_FORMAT, TRASH_DAYS } from "./constants.js";
import { num, ts, norm } from "./util.js";

const pick = (...vals) => {
  for (const v of vals) if (v != null && v !== "" && !(Array.isArray(v) && !v.length)) return v;
  return null;
};
const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
const idStr = (v) => (v == null || v === "" ? null : String(v));
const STATE_WORDS = /^(sold|active|hidden|reserved|closed|draft)$/i;

function thumbArea(t) {
  if (t?.width && t?.height) return t.width * t.height;
  const m = String(t?.type || "").match(/(\d+)x(\d+)/);
  return m ? Number(m[1]) * Number(m[2]) : 0;
}

/** L'URL alla risoluzione più alta disponibile (come in Vinted_Relist). */
export function bestPhotoUrl(photo) {
  if (!photo) return null;
  if (typeof photo === "string") return photo;
  if (photo.full_size_url) return photo.full_size_url;
  if (photo.high_resolution?.url) return photo.high_resolution.url;
  const thumbs = photo.thumbnails || [];
  if (thumbs.length) {
    const largest = [...thumbs].sort((a, b) => thumbArea(b) - thumbArea(a))[0];
    if (largest?.url) return largest.url;
  }
  return photo.url || photo.image_url || null;
}

export const photoKeyOf = (photo, url) => (photo && typeof photo === "object" && photo.id != null ? `p${photo.id}` : String(url || "").split("?")[0].split("/").slice(-2).join("/"));

export function photoList(...sources) {
  for (const s of sources) {
    const arr = Array.isArray(s?.photos) && s.photos.length ? s.photos : Array.isArray(s?.assigned_photos) && s.assigned_photos.length ? s.assigned_photos : s?.photo ? [s.photo] : null;
    if (!arr) continue;
    const out = [];
    const seen = new Set();
    for (const p of arr) {
      const url = bestPhotoUrl(p);
      if (!url) continue;
      const key = photoKeyOf(p, url);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ key, url, width: p?.width ?? null, height: p?.height ?? null, reduced: typeof p === "object" && !(p.full_size_url || p.high_resolution?.url) });
    }
    if (out.length) return out;
  }
  return [];
}

export function stateOf(raw) {
  if (!raw) return "active";
  const closing = String(raw.item_closing_action ?? raw.closing_action ?? "").toLowerCase();
  if (raw.is_sold === true || raw.is_closed === true || /sold|vendut/.test(closing) || String(raw.status ?? "").toLowerCase() === "sold") return "sold";
  if (raw.is_reserved || raw.reserved) return "reserved";
  if (raw.is_hidden || raw.is_draft || raw.is_visible === false || raw.is_visible === 0) return "hidden";
  return "active";
}

const colorList = (o) => [str(o?.color1), str(o?.color2), str(o?.color1_title), str(o?.color2_title)].filter(Boolean);
const colorIds = (o) => [...(Array.isArray(o?.color_ids) ? o.color_ids : []), o?.color1_id, o?.color2_id].filter((x) => x != null).map(String);
const conditionOf = (o) => {
  const s = str(o?.status_title) || (str(o?.status) && !STATE_WORDS.test(o.status) ? str(o.status) : null);
  return s || str(o?.item_status) || null;
};

/**
 * Unisce le letture disponibili di uno stesso annuncio:
 *   upload   → /item_upload/items/:id (solo il proprietario: dati del modulo di vendita)
 *   details  → scheda dell'annuncio
 *   wardrobe → riga dell'elenco dell'armadio
 *   page     → dati letti dalla pagina (etichette, percorso della categoria)
 */
export function normalizeBundle(bundle, origin) {
  const up = bundle?.upload || null;
  const det = bundle?.details || null;
  const wd = bundle?.wardrobe || null;
  const pg = bundle?.page || null;
  const vintedId = idStr(pick(up?.id, det?.id, wd?.id, pg?.id));
  if (!vintedId) return null;
  const statusId = pick(up?.status_id, det?.status_id);
  const path = pick(det?.path, wd?.path, str(det?.url) && !/^https?:/.test(det.url) ? det.url : null, str(wd?.url) && !/^https?:/.test(wd.url) ? wd.url : null);
  const absUrl = [det?.url, wd?.url, pg?.url].find((u) => typeof u === "string" && /^https?:/.test(u));
  const colors = pick(colorList(det), colorList(up), colorList(wd), pg?.attrs?.color ? String(pg.attrs.color).split(/\s*,\s*/).filter(Boolean) : null) || [];
  const crumbs = Array.isArray(pg?.breadcrumbs) ? pg.breadcrumbs.map((c) => String(c).trim()).filter(Boolean) : [];
  const n = {
    vintedId,
    origin,
    url: absUrl ? absUrl.split("?")[0] : path ? `${origin}${path}` : `${origin}/items/${vintedId}`,
    title: String(pick(up?.title, det?.title, wd?.title, pg?.title) || "").slice(0, 300),
    description: pick(up?.description, det?.description, pg?.description) != null ? String(pick(up?.description, det?.description, pg?.description)) : "",
    price: num(pick(up?.price, det?.price, det?.price_numeric, wd?.price, pg?.price)),
    currency: pick(det?.price?.currency_code, up?.price?.currency_code, wd?.price?.currency_code, up?.currency, det?.currency, wd?.currency, pg?.currency) || "EUR",
    brand: pick(str(det?.brand_dto?.title), str(det?.brand_title), str(det?.brand), str(det?.brand?.title), str(up?.brand_dto?.title), str(up?.brand_title), str(up?.brand), str(wd?.brand_title), str(pg?.attrs?.brand)),
    category: pick(crumbs.length ? crumbs.join(" › ") : null, str(det?.catalog_title), str(up?.catalog_title), str(pg?.attrs?.category)),
    size: pick(str(det?.size_title), str(det?.size), str(up?.size_title), str(up?.size), str(wd?.size_title), str(pg?.attrs?.size)),
    colors,
    condition: pick(conditionOf(det), conditionOf(wd), str(pg?.attrs?.status), CONDITION_BY_STATUS_ID[statusId] || null),
    ids: {
      brandId: idStr(pick(up?.brand_id, det?.brand_id, det?.brand_dto?.id)),
      catalogId: idStr(pick(up?.catalog_id, det?.catalog_id)),
      sizeId: idStr(pick(up?.size_id, det?.size_id)),
      statusId: idStr(statusId),
      colorIds: pick(colorIds(up), colorIds(det)) || [],
    },
    sellerId: idStr(pick(det?.user?.id, det?.user_id, up?.user_id, up?.user?.id, wd?.user?.id, wd?.user_id, pg?.sellerId)),
    sellerLogin: pick(str(det?.user?.login), str(wd?.user?.login), str(up?.user?.login), str(pg?.sellerLogin)),
    publishedAt: ts(pick(det?.created_at_ts, det?.created_at, up?.created_at_ts, up?.created_at, wd?.created_at_ts, wd?.created_at)),
    state: stateOf(det || up || wd),
    photos: photoList(up, det, wd, pg),
    sources: ["upload", "details", "wardrobe", "page"].filter((k) => bundle?.[k]),
  };
  return n;
}

/** Proprietario: «mio» solo con la prova (venditore = account letto dal cookie). Nel dubbio «altri». */
export function ownerOf(n, accountId, { uploadOk = false } = {}) {
  const me = idStr(accountId);
  if (!me) return "other";
  if (n.sellerId) return n.sellerId === me ? "mine" : "other";
  // /item_upload risponde solo al proprietario: senza id del venditore è l'unica prova disponibile.
  return uploadOk ? "mine" : "other";
}

const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
/** Impronta di ciò che conta per dire «su Vinted è cambiato»: testo, prezzo, foto. */
export function fingerprint(n) {
  return JSON.stringify([clean(n.title), clean(n.description), n.price ?? null, (n.photos || []).map((p) => p.key)]);
}

const same = (a, b) => (Array.isArray(a) || Array.isArray(b) ? JSON.stringify(a || []) === JSON.stringify(b || []) : clean(a) === clean(b));

/** Differenze tra la copia archiviata e la lettura attuale. Un campo che Vinted non ha fornito non è una differenza. */
export function diffListing(archived, current, archivedPhotoKeys = []) {
  const out = [];
  for (const f of ["title", "description", "price", "brand", "category", "size", "colors", "condition", "state"]) {
    const cur = current[f];
    if (cur == null || cur === "" || (Array.isArray(cur) && !cur.length)) continue;
    const old = archived[f];
    const equal = f === "price" ? Number(old) === Number(cur) : same(old, cur);
    if (!equal) out.push({ field: f, label: FIELD_LABELS[f], old: old ?? null, new: cur, edited: (archived.editedFields || []).includes(f) });
  }
  const curKeys = (current.photos || []).map((p) => p.key);
  if (curKeys.length && JSON.stringify(curKeys) !== JSON.stringify(archivedPhotoKeys)) {
    const added = curKeys.filter((k) => !archivedPhotoKeys.includes(k)).length;
    const removed = archivedPhotoKeys.filter((k) => !curKeys.includes(k)).length;
    out.push({ field: "photos", label: FIELD_LABELS.photos, old: archivedPhotoKeys.length, new: curKeys.length, added, removed, reordered: !added && !removed, edited: false });
  }
  return out;
}

// ---------------------------------------------------------------- ricerca, filtri, ordinamento

export const EMPTY_FILTER = { q: "", brand: [], category: [], size: [], color: [], condition: [], priceMin: null, priceMax: null, favorite: false, collection: null, online: null, seller: null };

export function searchText(l) {
  return norm([l.title, l.description, l.brand, l.category, l.size, (l.colors || []).join(" "), l.notes, l.sellerLogin, l.vintedId].filter(Boolean).join(" "));
}

export function matches(l, f) {
  if (f.q) {
    const hay = l._s ?? searchText(l);
    for (const w of norm(f.q).split(" ")) if (w && !hay.includes(w)) return false;
  }
  if (f.brand?.length && !f.brand.includes(l.brand || "")) return false;
  if (f.category?.length && !f.category.includes(l.category || "")) return false;
  if (f.size?.length && !f.size.includes(l.size || "")) return false;
  if (f.condition?.length && !f.condition.includes(l.condition || "")) return false;
  if (f.color?.length && !(l.colors || []).some((c) => f.color.includes(c))) return false;
  if (f.priceMin != null && f.priceMin !== "" && !(l.price != null && l.price >= Number(f.priceMin))) return false;
  if (f.priceMax != null && f.priceMax !== "" && !(l.price != null && l.price <= Number(f.priceMax))) return false;
  if (f.favorite && !l.favorite) return false;
  if (f.collection && !(l.collectionIds || []).includes(f.collection)) return false;
  if (f.online && l.online !== f.online) return false;
  if (f.seller && l.sellerId !== f.seller) return false;
  return true;
}

export const filterListings = (list, f) => list.filter((l) => matches(l, f));

export function sortListings(list, sort = "savedAt:desc") {
  const [key, dir] = sort.split(":");
  const m = dir === "asc" ? 1 : -1;
  const val = (l) => (key === "title" ? norm(l.title) : l[key]);
  return [...list].sort((a, b) => {
    const va = val(a);
    const vb = val(b);
    if (va == null && vb == null) return 0;
    if (va == null) return 1;        // i valori mancanti sempre in fondo
    if (vb == null) return -1;
    return (va < vb ? -1 : va > vb ? 1 : 0) * m;
  });
}

/** Valori distinti per i filtri, con il numero di annunci. */
export function facets(list) {
  const mk = () => new Map();
  const f = { brand: mk(), category: mk(), size: mk(), color: mk(), condition: mk(), seller: mk() };
  const add = (m, k) => { if (k) m.set(k, (m.get(k) || 0) + 1); };
  for (const l of list) {
    add(f.brand, l.brand); add(f.category, l.category); add(f.size, l.size); add(f.condition, l.condition);
    for (const c of l.colors || []) add(f.color, c);
    if (l.sellerId) f.seller.set(l.sellerId, { count: (f.seller.get(l.sellerId)?.count || 0) + 1, login: l.sellerLogin || f.seller.get(l.sellerId)?.login || l.sellerId });
  }
  const sorted = (m) => [...m.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))).map(([value, count]) => ({ value, count }));
  return { brand: sorted(f.brand), category: sorted(f.category), size: sorted(f.size), color: sorted(f.color), condition: sorted(f.condition), seller: [...f.seller.entries()].map(([value, v]) => ({ value, count: v.count, label: v.login })).sort((a, b) => b.count - a.count) };
}

export function stats(list) {
  const group = (key) => {
    const m = new Map();
    for (const l of list) {
      const k = l[key] || "Non indicato";
      const g = m.get(k) || { label: k, count: 0, value: 0 };
      g.count++; g.value += l.price || 0;
      m.set(k, g);
    }
    return [...m.values()].sort((a, b) => b.count - a.count);
  };
  const prices = list.map((l) => l.price).filter((p) => p != null);
  const total = prices.reduce((a, b) => a + b, 0);
  return {
    count: list.length,
    totalValue: Math.round(total * 100) / 100,
    avgPrice: prices.length ? Math.round((total / prices.length) * 100) / 100 : null,
    photos: list.reduce((a, l) => a + (l.photoCount || 0), 0),
    favorites: list.filter((l) => l.favorite).length,
    offline: list.filter((l) => l.online === "offline" || l.online === "sold").length,
    byBrand: group("brand"), byCategory: group("category"), bySize: group("size"), byCondition: group("condition"),
  };
}

// ---------------------------------------------------------------- annunci simili (F44)

export const titleKey = (title) => norm(title).split(" ").filter((w) => w.length > 1).sort().join(" ");

export function hamming(a, b) {
  if (!a || !b || a.length !== b.length) return 64;
  let d = 0;
  for (let i = 0; i < a.length; i += 8) {
    let x = (parseInt(a.slice(i, i + 8), 16) ^ parseInt(b.slice(i, i + 8), 16)) >>> 0;
    while (x) { x &= x - 1; d++; }
  }
  return d;
}

/** Annunci con ID diverso ma stessa foto (impronta visiva vicina) o stesso titolo e prezzo. */
export function findSimilar(target, others, maxDistance = 6) {
  const out = [];
  const tk = titleKey(target.title);
  for (const o of others) {
    if (o.id === target.id || o.vintedId === target.vintedId || o.deletedAt || o.owner !== target.owner) continue;
    let reason = null;
    outer: for (const a of target.dhashes || []) for (const b of o.dhashes || []) if (hamming(a, b) <= maxDistance) { reason = "photo"; break outer; }
    if (!reason && tk && tk === titleKey(o.title) && (target.price == null || o.price == null || Number(target.price) === Number(o.price))) reason = "title";
    if (reason) out.push({ id: o.id, reason });
  }
  return out;
}

/** Gruppi di annunci simili in tutto l'archivio. */
export function similarGroups(list) {
  const parent = new Map(list.map((l) => [l.id, l.id]));
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const live = list.filter((l) => !l.deletedAt);
  for (let i = 0; i < live.length; i++) for (const s of findSimilar(live[i], live.slice(i + 1))) parent.set(find(s.id), find(live[i].id));
  const groups = new Map();
  for (const l of live) { const r = find(l.id); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(l); }
  return [...groups.values()].filter((g) => g.length > 1);
}

// ---------------------------------------------------------------- esportazioni

export const EXPORT_COLUMNS = [
  ["ID Vinted", (l) => l.vintedId], ["Titolo", (l) => l.title], ["Descrizione", (l) => l.description], ["Prezzo", (l) => l.price],
  ["Valuta", (l) => l.currency], ["Marca", (l) => l.brand], ["Categoria", (l) => l.category], ["Taglia", (l) => l.size],
  ["Colore", (l) => (l.colors || []).join(", ")], ["Condizioni", (l) => l.condition], ["Foto", (l) => l.photoCount],
  ["Proprietario", (l) => (l.owner === "mine" ? "Mio" : "Altri")], ["Venditore", (l) => l.sellerLogin], ["URL", (l) => l.url],
  ["Pubblicato", (l) => (l.publishedAt ? new Date(l.publishedAt).toISOString().slice(0, 10) : "")],
  ["Salvato", (l) => (l.savedAt ? new Date(l.savedAt).toISOString().slice(0, 10) : "")],
  ["Preferito", (l) => (l.favorite ? "Sì" : "")], ["Note", (l) => l.notes],
];

export function toRows(listings, customFields = []) {
  const header = [...EXPORT_COLUMNS.map((c) => c[0]), ...customFields];
  const rows = listings.map((l) => [...EXPORT_COLUMNS.map((c) => c[1](l) ?? ""), ...customFields.map((f) => l.custom?.[f] ?? "")]);
  return [header, ...rows];
}

/** CSV con separatore «;» e BOM: si apre correttamente in Excel italiano. */
export function toCsv(rows) {
  const cell = (v) => {
    let s = typeof v === "number" ? String(v).replace(".", ",") : String(v ?? "");
    if (/^[=+\-@]/.test(s) && typeof v !== "number") s = `'${s}`;        // niente formule da testo archiviato
    return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return `﻿${rows.map((r) => r.map(cell).join(";")).join("\r\n")}\r\n`;
}

/** Formato di scambio per Vinted_Relist: dati leggibili + dati del modulo di vendita, quando ci sono. */
export function toRelistExport(listing, raw, photoFiles = []) {
  return {
    format: RELIST_FORMAT,
    schema: 1,
    exportedAt: new Date().toISOString(),
    source: { vintedId: listing.vintedId, url: listing.url, origin: listing.origin },
    listing: {
      title: listing.title, description: listing.description, price: listing.price, currency: listing.currency,
      brand: listing.brand, category: listing.category, size: listing.size, colors: listing.colors || [], condition: listing.condition,
      ids: listing.ids || {},
    },
    photos: photoFiles,
    uploadDraft: raw?.bundle?.upload || null,
  };
}

/** Segnaposto dei modelli di descrizione: {titolo} {marca} {taglia} {colore} {condizioni} {prezzo} {categoria}. */
export function applyTemplate(text, l) {
  const map = { titolo: l.title, marca: l.brand, taglia: l.size, colore: (l.colors || []).join(", "), condizioni: l.condition, prezzo: l.price != null ? String(l.price).replace(".", ",") : "", categoria: l.category };
  return String(text || "").replace(/\{(\w+)\}/g, (m, k) => (k.toLowerCase() in map ? map[k.toLowerCase()] ?? "" : m));
}

export const trashExpired = (deletedAt, now = Date.now()) => Boolean(deletedAt) && now - deletedAt >= TRASH_DAYS * 86400e3;
export const trashDaysLeft = (deletedAt, now = Date.now()) => Math.max(0, Math.ceil((deletedAt + TRASH_DAYS * 86400e3 - now) / 86400e3));
export const backupDue = (lastAt, days, now = Date.now()) => Boolean(days) && (!lastAt || now - lastAt >= days * 86400e3);

/** Id e percorso dell'annuncio o dell'armadio da un URL di Vinted. */
export function parseVintedUrl(url) {
  try {
    const u = new URL(url);
    const item = u.pathname.match(/^\/items\/(\d+)/);
    if (item) return { kind: "item", id: item[1], origin: u.origin };
    const member = u.pathname.match(/^\/member\/(\d+)/);
    if (member) return { kind: "wardrobe", id: member[1], origin: u.origin };
    return { kind: "other", id: null, origin: u.origin };
  } catch { return { kind: "none", id: null, origin: null }; }
}

/** Id utente dal «sub» di un token JWT (cookie access_token_web): si legge solo il numero, il token non viene salvato. */
export function userIdFromToken(value) {
  try {
    const part = String(value).split(".")[1];
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const sub = JSON.parse(atob(b64 + "===".slice((b64.length + 3) % 4)))?.sub;
    return /^\d+$/.test(String(sub)) ? String(sub) : null;
  } catch { return null; }
}
