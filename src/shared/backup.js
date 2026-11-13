/**
 * Backup e ripristino (F11, F35, F36).
 * ZIP: vintory.json (tutti i dati) + images/<id>.<ext> + thumbs/<id>.jpg.
 * JSON: solo i dati, senza foto.
 */
import * as db from "./db.js";
import { ZipWriter, readZip } from "./zip.js";
import { BACKUP_FORMAT, BACKUP_SCHEMA, VERSION } from "./constants.js";
import { dayStamp, extOf, uid } from "./util.js";

const SIDE_STORES = ["collections", "filters", "templates", "jobs"];

export async function exportArchive({ ids = null, photos = true, settings = null, onProgress = null } = {}) {
  const listings = (await db.getAll("listings")).filter((l) => !ids || ids.includes(l.id));
  const zip = photos ? new ZipWriter() : null;
  const data = {
    format: BACKUP_FORMAT, schema: BACKUP_SCHEMA, app: VERSION, createdAt: new Date().toISOString(),
    partial: Boolean(ids), photosIncluded: photos,
    listings, raw: [], versions: [], images: [],
    collections: await db.getAll("collections"), filters: await db.getAll("filters"), templates: await db.getAll("templates"),
    jobs: ids ? [] : await db.getAll("jobs"),
    labels: await db.getMeta("labels", {}),
    settings: settings ? { customFields: settings.customFields, theme: settings.theme, view: settings.view, sort: settings.sort } : null,
  };
  let photoCount = 0;
  let done = 0;
  for (const l of listings) {
    const raw = await db.get("raw", l.id);
    if (raw) data.raw.push(raw);
    data.versions.push(...(await db.byIndex("versions", "listingId", l.id)));
    for (const img of await db.byIndex("images", "listingId", l.id)) {
      const { blob, ...meta } = img;
      meta.file = blob && photos ? `images/${img.id}.${extOf(img.type)}` : null;
      meta.thumbFile = null;
      if (blob && photos) {
        await zip.add(meta.file, blob);
        photoCount++;
        const t = await db.get("thumbs", img.id);
        if (t?.blob) { meta.thumbFile = `thumbs/${img.id}.jpg`; await zip.add(meta.thumbFile, t.blob); }
      }
      data.images.push(meta);
    }
    onProgress?.({ done: ++done, total: listings.length });
  }
  data.counts = { listings: listings.length, photos: photoCount };
  const json = JSON.stringify(data);
  const stamp = dayStamp();
  if (!photos) return { blob: new Blob([json], { type: "application/json" }), name: `Vintory-dati-${stamp}.json`, counts: data.counts };
  await zip.add("vintory.json", json);
  return { blob: zip.finish(), name: `Vintory-backup-${stamp}.zip`, counts: data.counts };
}

/** Legge l'intestazione di un backup senza importarlo. */
export async function readBackup(file) {
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  let zip = null;
  let data;
  if (head[0] === 0x50 && head[1] === 0x4b) {
    zip = await readZip(file);
    const entry = zip.get("vintory.json");
    if (!entry) throw new Error("Lo ZIP non è un backup di Vintory: manca vintory.json.");
    try { data = JSON.parse(await entry.text()); } catch { throw new Error("vintory.json è danneggiato."); }
  } else {
    try { data = JSON.parse(await file.text()); } catch { throw new Error("Il file non è un backup di Vintory (né ZIP né JSON valido)."); }
  }
  if (data?.format !== BACKUP_FORMAT || !Array.isArray(data.listings)) throw new Error("Il file non è un backup di Vintory.");
  if (!(Number(data.schema) >= 1) || data.schema > BACKUP_SCHEMA) throw new Error(`Backup creato da una versione più recente di Vintory (schema ${data.schema}): aggiorna l'estensione e riprova.`);
  return { data, zip, summary: { createdAt: data.createdAt, app: data.app, listings: data.listings.length, photos: (data.images || []).filter((i) => i.file).length, photosIncluded: Boolean(zip) } };
}

const cleanListing = (l) => ({
  ...l,
  id: String(l.id), vintedId: String(l.vintedId), title: String(l.title ?? ""), description: String(l.description ?? ""),
  owner: l.owner === "mine" ? "mine" : "other",
  url: /^https:\/\//.test(String(l.url)) ? String(l.url) : null,
  colors: Array.isArray(l.colors) ? l.colors.map(String) : [], collectionIds: Array.isArray(l.collectionIds) ? l.collectionIds.map(String) : [],
  imageIds: Array.isArray(l.imageIds) ? l.imageIds.map(String) : [], custom: l.custom && typeof l.custom === "object" ? l.custom : {},
  notes: String(l.notes ?? ""), ids: l.ids && typeof l.ids === "object" ? l.ids : {},
});

/**
 * Importa un backup.
 *   merge   → aggiunge ciò che manca; gli annunci già presenti (stesso ID Vinted) restano come sono.
 *   replace → svuota l'archivio e ripristina il backup.
 */
export async function importArchive(file, { mode = "merge", onProgress = null } = {}) {
  const { data, zip } = await readBackup(file);
  if (mode === "replace") for (const s of db.STORES) await db.clear(s);
  const haveVinted = new Set((await db.getAll("listings")).map((l) => l.vintedId));
  const haveIds = new Set(await db.allKeys("listings"));
  const haveImages = new Set(await db.allKeys("images"));
  const rawById = new Map((data.raw || []).map((r) => [r.listingId, r]));
  const group = (arr) => { const m = new Map(); for (const x of arr || []) { if (!m.has(x.listingId)) m.set(x.listingId, []); m.get(x.listingId).push(x); } return m; };
  const versionsBy = group(data.versions);
  const imagesBy = group(data.images);
  const report = { added: 0, skipped: 0, invalid: 0, photos: 0, photosMissing: 0, collections: 0, templates: 0, filters: 0 };
  let done = 0;
  for (const src of data.listings) {
    onProgress?.({ done: done++, total: data.listings.length });
    if (!src || src.id == null || src.vintedId == null) { report.invalid++; continue; }
    const l = cleanListing(src);
    if (haveVinted.has(l.vintedId)) { report.skipped++; continue; }
    const oldId = l.id;
    if (haveIds.has(l.id)) l.id = uid("l_");
    const imageMap = new Map();
    const images = [];
    const thumbs = [];
    for (const meta of imagesBy.get(oldId) || []) {
      const { file, thumbFile, ...rec } = meta;
      const newId = haveImages.has(rec.id) ? uid("i_") : String(rec.id);
      imageMap.set(String(rec.id), newId);
      rec.id = newId;
      rec.listingId = l.id;
      const entry = file && zip ? zip.get(file) : null;
      rec.blob = entry ? await entry.blob(rec.type || "image/jpeg") : null;
      if (rec.blob) report.photos++;
      else { rec.status = "missing"; rec.error = rec.error || "foto non inclusa nel backup"; rec.size = 0; report.photosMissing++; }
      images.push(rec);
      const te = thumbFile && zip ? zip.get(thumbFile) : null;
      if (te) thumbs.push({ imageId: newId, listingId: l.id, blob: await te.blob("image/jpeg") });
      haveImages.add(newId);
    }
    const remap = (ids) => (ids || []).map((i) => imageMap.get(String(i))).filter(Boolean);
    l.imageIds = remap(l.imageIds);
    const hasBlob = (id) => Boolean(images.find((i) => i.id === id)?.blob);
    const cover = imageMap.get(String(l.coverImageId));
    l.coverImageId = (cover && hasBlob(cover) ? cover : l.imageIds.find(hasBlob)) || null;
    l.photoMissing = images.filter((i) => l.imageIds.includes(i.id) && i.status !== "ok").length;
    l.importedAt = Date.now();
    const raw = rawById.get(oldId);
    const versions = (versionsBy.get(oldId) || []).map(({ id, ...v }) => ({ ...v, listingId: l.id, imageIds: remap(v.imageIds) }));
    await db.tx(["listings", "raw", "versions", "images", "thumbs"], "readwrite", (s) => {
      s.listings.put(l);
      if (raw) s.raw.put({ ...raw, listingId: l.id, imageIds: remap(raw.imageIds) });
      for (const v of versions) s.versions.add(v);
      for (const i of images) s.images.put(i);
      for (const t of thumbs) s.thumbs.put(t);
    });
    haveVinted.add(l.vintedId);
    haveIds.add(l.id);
    report.added++;
  }
  for (const store of SIDE_STORES) {
    const have = new Set(await db.allKeys(store));
    for (const rec of data[store] || []) {
      if (!rec || rec.id == null || have.has(rec.id)) continue;
      await db.put(store, rec);
      if (store in report) report[store]++;
    }
  }
  if (data.labels && typeof data.labels === "object") {
    const labels = await db.getMeta("labels", {});
    for (const [kind, map] of Object.entries(data.labels)) labels[kind] = { ...(map || {}), ...(labels[kind] || {}) };
    await db.setMeta("labels", labels);
  }
  onProgress?.({ done: data.listings.length, total: data.listings.length });
  return { ...report, settings: data.settings || null, mode };
}
