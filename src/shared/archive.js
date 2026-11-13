/**
 * L'archivio: salvataggio, aggiornamento, versioni, cestino, integrità.
 * Usato dal service worker (salvataggi) e dalla dashboard (gestione).
 * Nessuna funzione qui scrive qualcosa su Vinted.
 */
import * as db from "./db.js";
import { normalizeBundle, ownerOf, fingerprint, findSimilar, diffListing, trashExpired } from "./model.js";
import { analyze as analyzeImage } from "./imaging.js";
import { uid, sha256Hex, typeOfExt } from "./util.js";
import { MAX_VERSIONS, PHOTO_TIMEOUT_MS } from "./constants.js";

export const CONTENT_FIELDS = ["title", "description", "price", "currency", "brand", "category", "size", "colors", "condition"];
const FLAT_HASH = /^(0{16}|f{16})$/;

/** Scarica una foto: solo https, limite di 60 secondi, deve essere un'immagine non vuota. */
export async function fetchPhoto(url) {
  if (!/^https:\/\//.test(String(url))) throw new Error("indirizzo della foto non valido");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PHOTO_TIMEOUT_MS);
  try {
    const res = await fetch(url, { credentials: "omit", cache: "no-store", signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    if (!blob.size) throw new Error("file vuoto");
    if (blob.type && !/^image\//.test(blob.type) && !/octet-stream/.test(blob.type)) throw new Error(`non è un'immagine (${blob.type})`);
    return blob;
  } catch (e) {
    throw new Error(e?.name === "AbortError" ? "nessuna risposta in 60 secondi" : e.message);
  } finally {
    clearTimeout(timer);
  }
}

const deps = { fetchPhoto, analyze: analyzeImage };
/** Per i test: sostituisce il download e l'analisi delle foto. */
export const configure = (patch) => Object.assign(deps, patch);

// ---------------------------------------------------------------- etichette imparate (id → nome)

const LABEL_FIELDS = { catalog: ["catalogId", "category"], brand: ["brandId", "brand"], size: ["sizeId", "size"], status: ["statusId", "condition"] };

/** Un'etichetta appena imparata completa anche gli annunci già salvati che avevano solo l'id. */
async function backfillLabels(learned) {
  for (const l of await db.getAll("listings")) {
    let dirty = false;
    for (const [kind, id, label] of learned) {
      const [idKey, field] = LABEL_FIELDS[kind] || [];
      if (idKey && l.ids?.[idKey] === id && !l[field]) { l[field] = label; dirty = true; }
    }
    if (dirty) await db.put("listings", l);
  }
}

async function applyLabels(n) {
  const labels = await db.getMeta("labels", {});
  const learned = [];
  let changed = false;
  const both = (kind, id, field) => {
    if (!id) return;
    if (n[field]) { if (labels[kind]?.[id] !== n[field]) { (labels[kind] ||= {})[id] = n[field]; changed = true; learned.push([kind, id, n[field]]); } } else if (labels[kind]?.[id]) n[field] = labels[kind][id];
  };
  both("catalog", n.ids.catalogId, "category");
  both("brand", n.ids.brandId, "brand");
  both("size", n.ids.sizeId, "size");
  both("status", n.ids.statusId, "condition");
  const cids = n.ids.colorIds || [];
  if (n.colors.length && n.colors.length === cids.length) {
    cids.forEach((id, i) => { if (labels.color?.[id] !== n.colors[i]) { (labels.color ||= {})[id] = n.colors[i]; changed = true; } });
  } else if (!n.colors.length && cids.length) n.colors = cids.map((id) => labels.color?.[id]).filter(Boolean);
  if (changed) await db.setMeta("labels", labels);
  if (learned.length) await backfillLabels(learned);
}

/** Il nome di questa categoria manca e non è ancora stato imparato: serve leggere la pagina dell'annuncio. */
export async function missingCatalog(bundle, origin) {
  const n = normalizeBundle(bundle, origin);
  if (!n?.ids.catalogId || n.category) return null;
  const labels = await db.getMeta("labels", {});
  return labels.catalog?.[n.ids.catalogId] ? null : n.ids.catalogId;
}

export async function learnLabel(kind, id, name) {
  if (!id || !name) return;
  const labels = await db.getMeta("labels", {});
  if (labels[kind]?.[id] === name) return;
  (labels[kind] ||= {})[id] = name;
  await db.setMeta("labels", labels);
}

export async function labelFor(kind, id) {
  return (await db.getMeta("labels", {}))[kind]?.[id] || null;
}

const EMPTY = (v) => v == null || v === "" || (Array.isArray(v) && !v.length);

/**
 * Completa gli annunci già archiviati con ciò che i dati originali e le etichette imparate sanno già:
 * marca, categoria, taglia, colore, condizioni, dati dei libri. Non tocca i campi modificati a mano
 * né quelli già pieni. Nessuna richiesta a Vinted.
 */
export async function refill({ ids = null } = {}) {
  const labels = await db.getMeta("labels", {});
  let changed = 0;
  for (const l of await listAll()) {
    if (ids && !ids.includes(l.id)) continue;
    const raw = await db.get("raw", l.id);
    const src = raw?.latest?.bundle || raw?.bundle;
    const n = src ? normalizeBundle(src, l.origin) : null;
    const edited = new Set(l.editedFields || []);
    let dirty = false;
    if (n) {
      for (const f of ["brand", "category", "size", "colors", "condition"]) {
        if (!edited.has(f) && EMPTY(l[f]) && !EMPTY(n[f])) { l[f] = n[f]; dirty = true; }
      }
      const ids2 = { ...(l.ids || {}) };
      for (const [k, v] of Object.entries(n.ids)) if (EMPTY(ids2[k]) && !EMPTY(v)) { ids2[k] = v; dirty = true; }
      l.ids = ids2;
      if (Object.keys(n.extra || {}).length && JSON.stringify(n.extra) !== JSON.stringify(l.extra || {})) { l.extra = { ...(l.extra || {}), ...n.extra }; dirty = true; }
    }
    const fromLabel = (field, kind, id) => {
      if (!edited.has(field) && EMPTY(l[field]) && id && labels[kind]?.[id]) { l[field] = labels[kind][id]; dirty = true; }
    };
    fromLabel("category", "catalog", l.ids?.catalogId);
    fromLabel("brand", "brand", l.ids?.brandId);
    fromLabel("size", "size", l.ids?.sizeId);
    fromLabel("condition", "status", l.ids?.statusId);
    if (!edited.has("colors") && EMPTY(l.colors) && (l.ids?.colorIds || []).length) {
      const c = l.ids.colorIds.map((id) => labels.color?.[id]).filter(Boolean);
      if (c.length) { l.colors = c; dirty = true; }
    }
    if (dirty) { await db.put("listings", l); changed++; }
  }
  return changed;
}

// ---------------------------------------------------------------- foto

async function downloadPhotos(listingId, photos, reuse = new Map(), onProgress = null) {
  const images = [];
  const thumbs = [];
  for (let i = 0; i < photos.length; i++) {
    const p = photos[i];
    onProgress?.({ photo: i + 1, photos: photos.length });
    const kept = reuse.get(p.key);
    if (kept && kept.blob) { images.push({ ...kept, order: i }); continue; }
    const rec = { id: uid("i_"), listingId, order: i, key: p.key, sourceUrl: p.url, reduced: Boolean(p.reduced), addedAt: Date.now(), status: "ok", error: null, blob: null, type: null, size: 0, width: null, height: null, sha256: null, dhash: null };
    try {
      const blob = await deps.fetchPhoto(p.url);
      rec.blob = blob;
      rec.type = blob.type && /^image\//.test(blob.type) ? blob.type : typeOfExt(p.url.split("?")[0]);
      rec.size = blob.size;
      rec.sha256 = await sha256Hex(blob);
      const a = await deps.analyze(blob);
      rec.width = a.width; rec.height = a.height; rec.dhash = a.dhash;
      if (a.supported && !a.ok) { rec.status = "corrupt"; rec.error = "la foto scaricata non si apre"; }
      if (a.thumb) thumbs.push({ imageId: rec.id, listingId, blob: a.thumb });
    } catch (e) {
      rec.status = "missing";
      rec.error = e.message;
    }
    images.push(rec);
  }
  return { images, thumbs };
}

function photoSummary(listing, images) {
  listing.imageIds = images.map((i) => i.id);
  listing.coverImageId = images.find((i) => i.blob)?.id || null;
  listing.photoCount = images.length;
  listing.photoMissing = images.filter((i) => i.status !== "ok").length;
  listing.photoKeys = images.map((i) => i.key);
  listing.dhashes = images.map((i) => i.dhash).filter((h) => h && !FLAT_HASH.test(h));
}

export const findByVintedId = (vintedId) => db.oneByIndex("listings", "vintedId", String(vintedId));

// ---------------------------------------------------------------- salvataggio

/**
 * Salva un annuncio letto da Vinted.
 * Esiti: saved · duplicate (già in archivio, con le differenze) · restored (era nel cestino).
 */
export async function saveBundle({ bundle, origin, accountId = null, source = "manual", jobId = null }, { onProgress = null } = {}) {
  const n = normalizeBundle(bundle, origin);
  if (!n) throw new Error("Vinted non ha fornito i dati dell'annuncio.");
  if (!n.title && !n.photos.length) throw new Error("Dati dell'annuncio incompleti: mancano titolo e foto.");
  await applyLabels(n);
  const existing = await findByVintedId(n.vintedId);
  if (existing) {
    const diffs = diffListing(existing, n, existing.photoKeys || []);
    if (existing.deletedAt) {
      existing.deletedAt = null;
      await db.put("listings", existing);
      return { status: "restored", listing: existing, diffs };
    }
    return { status: "duplicate", listing: existing, diffs };
  }
  const id = uid("l_");
  const now = Date.now();
  const { images, thumbs } = await downloadPhotos(id, n.photos, new Map(), onProgress);
  const { photos, sources, ...fields } = n;
  const listing = {
    id, ...fields,
    owner: ownerOf(n, accountId, { uploadOk: Boolean(bundle.upload) }),
    sources,
    savedAt: now, updatedAt: now, refreshedAt: now,
    favorite: false, collectionIds: [], notes: "", custom: {}, edited: false, editedFields: [],
    online: n.state === "sold" ? "sold" : "online", onlineCheckedAt: now, remoteChanged: false,
    deletedAt: null, source, jobId,
    fp: fingerprint(n),
  };
  if (listing.owner === "mine" && !listing.sellerId) listing.sellerId = String(accountId);
  photoSummary(listing, images);
  const similar = findSimilar(listing, await db.getAll("listings"));
  try {
    await db.tx(["listings", "raw", "images", "thumbs"], "readwrite", (s) => {
      s.listings.put(listing);
      s.raw.put({ listingId: id, vintedId: n.vintedId, capturedAt: now, bundle, normalized: { ...fields }, imageIds: listing.imageIds });
      for (const i of images) s.images.put(i);
      for (const t of thumbs) s.thumbs.put(t);
    });
  } catch (e) {
    if (e?.name === "ConstraintError") {       // due salvataggi insieme dello stesso annuncio: vince il primo
      const first = await findByVintedId(n.vintedId);
      if (first) return { status: "duplicate", listing: first, diffs: [] };
    }
    throw e;
  }
  return { status: "saved", listing, similar, photoMissing: listing.photoMissing };
}

/** Confronta la copia archiviata con una nuova lettura, senza cambiare nulla tranne il segnale «modificato su Vinted». */
export async function compareBundle({ bundle, origin }) {
  const n = normalizeBundle(bundle, origin);
  if (!n) return null;
  const listing = await findByVintedId(n.vintedId);
  if (!listing) return null;
  await applyLabels(n);
  const diffs = diffListing(listing, n, listing.photoKeys || []);
  const changed = fingerprint(n) !== listing.fp;
  const online = n.state === "sold" ? "sold" : "online";
  if (listing.remoteChanged !== changed || listing.online !== online) {
    listing.remoteChanged = changed;
    listing.online = online;
    listing.onlineCheckedAt = Date.now();
    await db.put("listings", listing);
  }
  return { listing, diffs, changed };
}

async function snapshot(listing, reason) {
  const data = Object.fromEntries(CONTENT_FIELDS.map((f) => [f, listing[f]]));
  await db.put("versions", { listingId: listing.id, at: Date.now(), reason, data, imageIds: [...(listing.imageIds || [])] });
  const all = (await db.byIndex("versions", "listingId", listing.id)).sort((a, b) => a.at - b.at || a.id - b.id);
  if (all.length > MAX_VERSIONS) for (const v of all.slice(0, all.length - MAX_VERSIONS)) await db.del("versions", v.id);
}

/** Elimina le foto dell'annuncio che non servono più né alla scheda, né a una versione, né all'originale. */
async function gcImages(listing) {
  const keep = new Set(listing.imageIds || []);
  for (const v of await db.byIndex("versions", "listingId", listing.id)) for (const i of v.imageIds || []) keep.add(i);
  for (const i of (await db.get("raw", listing.id))?.imageIds || []) keep.add(i);
  const drop = (await db.keysByIndex("images", "listingId", listing.id)).filter((k) => !keep.has(k));
  if (drop.length) await db.tx(["images", "thumbs"], "readwrite", (s) => { for (const k of drop) { s.images.delete(k); s.thumbs.delete(k); } });
}

/**
 * Applica alla copia archiviata i campi scelti dall'utente (F42).
 * fields vuoto = «tieni la mia copia»: si azzera solo il segnale di modifica.
 */
export async function applyUpdate(listingId, { bundle }, fields = [], { onProgress = null } = {}) {
  const listing = await db.get("listings", listingId);
  if (!listing) throw new Error("Annuncio non trovato nell'archivio.");
  const n = normalizeBundle(bundle, listing.origin);
  if (!n || n.vintedId !== listing.vintedId) throw new Error("I dati letti non appartengono a questo annuncio.");
  await applyLabels(n);
  const now = Date.now();
  if (fields.length) await snapshot(listing, "refresh");
  for (const f of fields) {
    if (f === "photos") continue;
    if (!CONTENT_FIELDS.includes(f) && f !== "state") continue;
    listing[f] = n[f];
    listing.editedFields = (listing.editedFields || []).filter((x) => x !== f);
  }
  if (fields.includes("price")) listing.currency = n.currency;
  let thumbs = [];
  let images = null;
  if (fields.includes("photos")) {
    const current = await getImages(listing);
    const r = await downloadPhotos(listing.id, n.photos, new Map(current.map((i) => [i.key, i])), onProgress);
    images = r.images; thumbs = r.thumbs;
    photoSummary(listing, images);
  }
  if (Object.keys(n.extra || {}).length) listing.extra = { ...(listing.extra || {}), ...n.extra };
  listing.ids = { ...listing.ids, ...Object.fromEntries(Object.entries(n.ids).filter(([, v]) => v != null && !(Array.isArray(v) && !v.length))) };
  listing.state = n.state;
  listing.online = n.state === "sold" ? "sold" : "online";
  listing.onlineCheckedAt = now;
  listing.refreshedAt = now;
  listing.updatedAt = now;
  listing.remoteChanged = false;
  listing.fp = fingerprint(n);
  listing.edited = (listing.editedFields || []).length > 0;
  const raw = (await db.get("raw", listing.id)) || { listingId: listing.id, vintedId: listing.vintedId };
  raw.latest = { capturedAt: now, bundle };
  await db.tx(["listings", "raw", "images", "thumbs"], "readwrite", (s) => {
    s.listings.put(listing);
    s.raw.put(raw);
    for (const i of images || []) s.images.put(i);
    for (const t of thumbs) s.thumbs.put(t);
  });
  await gcImages(listing);
  return listing;
}

/** Modifica della copia archiviata: l'originale resta in «raw» e nelle versioni. */
export async function editListing(listingId, patch) {
  const listing = await db.get("listings", listingId);
  if (!listing) throw new Error("Annuncio non trovato nell'archivio.");
  const changed = CONTENT_FIELDS.filter((f) => f in patch && JSON.stringify(patch[f] ?? null) !== JSON.stringify(listing[f] ?? null));
  if (changed.length) {
    await snapshot(listing, "edit");
    for (const f of changed) listing[f] = patch[f];
    listing.editedFields = [...new Set([...(listing.editedFields || []), ...changed])];
    listing.edited = true;
  }
  for (const f of ["notes", "custom", "favorite", "collectionIds"]) if (f in patch) listing[f] = patch[f];
  listing.updatedAt = Date.now();
  await db.put("listings", listing);
  return listing;
}

/** Modifica rapida di più annunci (preferiti, collezioni): nessuna versione. */
export async function patchMany(ids, fn) {
  const out = [];
  for (const id of ids) {
    const l = await db.get("listings", id);
    if (!l) continue;
    fn(l);
    await db.put("listings", l);
    out.push(l);
  }
  return out;
}

export const listVersions = async (listingId) => (await db.byIndex("versions", "listingId", listingId)).sort((a, b) => b.at - a.at || b.id - a.id);

async function existingImageIds(ids) {
  const out = [];
  for (const id of ids || []) if (await db.get("images", id)) out.push(id);
  return out;
}

export async function restoreVersion(listingId, versionId) {
  const listing = await db.get("listings", listingId);
  const v = await db.get("versions", versionId);
  if (!listing || !v || v.listingId !== listingId) throw new Error("Versione non trovata.");
  await snapshot(listing, "restore");
  Object.assign(listing, v.data);
  const images = (await Promise.all((await existingImageIds(v.imageIds)).map((id) => db.get("images", id))));
  if (images.length) photoSummary(listing, images);
  listing.edited = true;
  listing.editedFields = [...CONTENT_FIELDS];
  listing.updatedAt = Date.now();
  await db.put("listings", listing);
  return listing;
}

/** Riporta la scheda ai dati letti da Vinted al primo salvataggio. */
export async function restoreOriginal(listingId) {
  const listing = await db.get("listings", listingId);
  const raw = await db.get("raw", listingId);
  if (!listing || !raw?.normalized) throw new Error("Dati originali non disponibili per questo annuncio.");
  await snapshot(listing, "restore");
  for (const f of CONTENT_FIELDS) listing[f] = raw.normalized[f];
  const images = await Promise.all((await existingImageIds(raw.imageIds)).map((id) => db.get("images", id)));
  if (images.length) photoSummary(listing, images);
  listing.edited = false;
  listing.editedFields = [];
  listing.updatedAt = Date.now();
  await db.put("listings", listing);
  return listing;
}

// ---------------------------------------------------------------- lettura

export const listAll = () => db.getAll("listings");
export const getListing = (id) => db.get("listings", id);
export const getRaw = (id) => db.get("raw", id);

export async function getImages(listing) {
  const all = await db.byIndex("images", "listingId", listing.id);
  const order = new Map((listing.imageIds || []).map((id, i) => [id, i]));
  return all.filter((i) => order.has(i.id)).sort((a, b) => order.get(a.id) - order.get(b.id));
}

/** Miniatura della foto; se manca, la foto intera. */
export async function getThumb(imageId) {
  if (!imageId) return null;
  const t = await db.get("thumbs", imageId);
  if (t?.blob) return t.blob;
  return (await db.get("images", imageId))?.blob || null;
}

// ---------------------------------------------------------------- cestino

export const trash = (ids) => patchMany(ids, (l) => { l.deletedAt = Date.now(); });
export const untrash = (ids) => patchMany(ids, (l) => { l.deletedAt = null; });

export async function purge(ids) {
  for (const id of ids) {
    await db.tx(["listings", "raw", "versions", "images", "thumbs"], "readwrite", async (s) => {
      s.listings.delete(id);
      s.raw.delete(id);
      for (const st of ["versions", "images", "thumbs"]) for (const k of await db.rq(s[st].index("listingId").getAllKeys(id))) s[st].delete(k);
    });
  }
  return ids.length;
}

export async function purgeExpired(now = Date.now()) {
  const expired = (await listAll()).filter((l) => trashExpired(l.deletedAt, now)).map((l) => l.id);
  if (expired.length) await purge(expired);
  return expired.length;
}

export async function removeCollection(id) {
  await db.del("collections", id);
  const hit = (await listAll()).filter((l) => (l.collectionIds || []).includes(id)).map((l) => l.id);
  await patchMany(hit, (l) => { l.collectionIds = l.collectionIds.filter((c) => c !== id); });
}

// ---------------------------------------------------------------- integrità (F21)

/**
 * Controlla le foto: presenti, non vuote, impronta SHA-256 invariata, apribili.
 * Con redownload prova a riscaricare dall'indirizzo originale quelle mancanti o rovinate.
 */
export async function verifyIntegrity({ ids = null, redownload = false, onProgress = null } = {}) {
  const listings = (await listAll()).filter((l) => !ids || ids.includes(l.id));
  const report = { listings: listings.length, photos: 0, ok: 0, missing: 0, corrupt: 0, repaired: 0, problems: [] };
  let done = 0;
  for (const l of listings) {
    const bad = [];
    let dirty = false;
    for (const imageId of l.imageIds || []) {
      report.photos++;
      let img = await db.get("images", imageId);
      let status = "ok";
      let error = null;
      if (!img || !img.blob || !img.blob.size) { status = "missing"; error = img?.error || "foto non presente nell'archivio"; } else {
        const sha = await sha256Hex(img.blob);
        if (img.sha256 && sha !== img.sha256) { status = "corrupt"; error = "il contenuto non corrisponde all'impronta salvata"; } else {
          const a = await deps.analyze(img.blob);
          if (a.supported && !a.ok) { status = "corrupt"; error = "la foto non si apre"; }
        }
      }
      if (status !== "ok" && redownload && img?.sourceUrl) {
        const r = await downloadPhotos(l.id, [{ key: img.key, url: img.sourceUrl, reduced: img.reduced }]);
        const fresh = r.images[0];
        if (fresh.status === "ok") {
          img = { ...fresh, id: img.id, order: img.order, addedAt: img.addedAt };
          await db.tx(["images", "thumbs"], "readwrite", (s) => { s.images.put(img); if (r.thumbs[0]) s.thumbs.put({ ...r.thumbs[0], imageId: img.id }); });
          status = "ok"; error = null; report.repaired++; dirty = true;
        }
      }
      if (img && (img.status !== status || img.error !== error)) { img.status = status; img.error = error; await db.put("images", img); dirty = true; }
      report[status]++;
      if (status !== "ok") bad.push({ imageId, status, error });
    }
    const missing = bad.length;
    if (dirty || (l.photoMissing || 0) !== missing) {
      const fresh = await db.get("listings", l.id);
      if (fresh) {
        const imgs = await getImages(fresh);
        fresh.photoMissing = missing;
        fresh.coverImageId = imgs.find((i) => i.blob && i.status === "ok")?.id || fresh.coverImageId;
        fresh.dhashes = imgs.map((i) => i.dhash).filter((h) => h && !FLAT_HASH.test(h));
        await db.put("listings", fresh);
      }
    }
    if (bad.length) report.problems.push({ id: l.id, title: l.title, photos: bad });
    onProgress?.({ done: ++done, total: listings.length });
  }
  return report;
}

// ---------------------------------------------------------------- spazio e conteggi

export async function storageInfo() {
  const est = (await navigator.storage?.estimate?.()) || {};
  const persisted = (await navigator.storage?.persisted?.()) ?? null;
  return { usage: est.usage ?? null, quota: est.quota ?? null, persisted };
}
export const requestPersistence = async () => (await navigator.storage?.persist?.()) ?? false;

export async function counts() {
  const out = {};
  for (const s of db.STORES) out[s] = await db.count(s);
  return out;
}
