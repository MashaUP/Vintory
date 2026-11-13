import test from "node:test";
import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import * as db from "../../src/shared/db.js";
import * as archive from "../../src/shared/archive.js";
import { exportArchive, importArchive, readBackup } from "../../src/shared/backup.js";
import { readZip } from "../../src/shared/zip.js";

const ORIGIN = "https://www.vinted.it";
const ME = "4242";
let fail = new Set();
let fetched = [];
const photoBytes = (url) => new TextEncoder().encode(`FOTO:${url}:${"x".repeat(200)}`);
const hashOf = (s) => {
  let h = 2166136261;
  for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b) >>> 0; h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35) >>> 0; h ^= h >>> 16;
  return (h >>> 0).toString(16).padStart(8, "0") + (Math.imul(h, 0x9e3779b1) >>> 0).toString(16).padStart(8, "0");
};

archive.configure({
  fetchPhoto: async (url) => { fetched.push(url); if (fail.has(url)) throw new Error("HTTP 404"); return new Blob([photoBytes(url)], { type: "image/jpeg" }); },
  analyze: async (blob) => { const t = await blob.text(); const ok = t.startsWith("FOTO:"); return { supported: true, ok, width: 800, height: 1000, dhash: ok ? hashOf(t.split(":").slice(1, 3).join(":")) : null, thumb: ok ? new Blob(["thumb"], { type: "image/jpeg" }) : null }; },
});

async function fresh() {
  await db.close();
  globalThis.indexedDB = new IDBFactory();
  fail = new Set();
  fetched = [];
}
const photo = (id) => ({ id, full_size_url: `https://images1.vinted.net/f/${id}.jpg` });
const item = (id, o = {}) => ({ id, title: `Annuncio ${id}`, description: `Descrizione ${id}`, price: { amount: "20.0", currency_code: "EUR" }, brand_dto: { id: 10, title: "Zara" }, size_title: "M", status: "Buone", user: { id: Number(ME), login: "masha" }, catalog_id: 5, photos: [photo(id * 10 + 1), photo(id * 10 + 2), photo(id * 10 + 3)], ...o });
const save = (id, o = {}, extra = {}) => archive.saveBundle({ bundle: { details: item(id, o), ...extra }, origin: ORIGIN, accountId: ME });

test("salvataggio completo: dati, foto, miniature, dati originali", async () => {
  await fresh();
  const r = await save(1);
  assert.equal(r.status, "saved");
  const l = r.listing;
  assert.equal(l.owner, "mine");
  assert.equal(l.photoCount, 3);
  assert.equal(l.photoMissing, 0);
  assert.equal(l.imageIds.length, 3);
  assert.equal(l.coverImageId, l.imageIds[0]);
  const images = await archive.getImages(l);
  assert.deepEqual(images.map((i) => i.key), ["p11", "p12", "p13"]);
  assert.ok(images.every((i) => i.blob.size > 100 && i.sha256.length === 64 && i.status === "ok"));
  assert.equal((await archive.getThumb(l.coverImageId)).size, 5);
  const raw = await archive.getRaw(l.id);
  assert.equal(raw.bundle.details.title, "Annuncio 1");
  assert.equal(raw.normalized.title, "Annuncio 1");
  assert.deepEqual(await archive.counts(), { listings: 1, raw: 1, versions: 0, images: 3, thumbs: 3, collections: 0, filters: 0, templates: 0, jobs: 0, meta: 1 });
});

test("niente doppioni: stesso ID Vinted, anche con due salvataggi insieme", async () => {
  await fresh();
  await save(1);
  const again = await save(1, { price: { amount: "15.0", currency_code: "EUR" } });
  assert.equal(again.status, "duplicate");
  assert.deepEqual(again.diffs.map((d) => d.field), ["price"]);
  assert.equal((await archive.listAll()).length, 1);
  assert.equal((await archive.listAll())[0].price, 20, "il duplicato non sovrascrive");
  const both = await Promise.all([save(2), save(2)]);
  assert.deepEqual(both.map((r) => r.status).sort(), ["duplicate", "saved"]);
  assert.equal((await archive.listAll()).length, 2);
  assert.equal(await db.count("images"), 6, "le foto del secondo tentativo non restano orfane");
});

test("annuncio di un altro utente: sezione «non miei»; senza account niente è «mio»", async () => {
  await fresh();
  const other = await save(3, { user: { id: 77, login: "altra" } });
  assert.equal(other.listing.owner, "other");
  assert.equal(other.listing.sellerLogin, "altra");
  const noAccount = await archive.saveBundle({ bundle: { details: item(4) }, origin: ORIGIN, accountId: null });
  assert.equal(noAccount.listing.owner, "other");
  const uploadOnly = await archive.saveBundle({ bundle: { upload: { id: 5, title: "Solo modulo", photos: [photo(51)] } }, origin: ORIGIN, accountId: ME });
  assert.equal(uploadOnly.listing.owner, "mine");
  assert.equal(uploadOnly.listing.sellerId, ME);
});

test("una foto che non si scarica viene segnalata, le altre restano", async () => {
  await fresh();
  fail.add("https://images1.vinted.net/f/12.jpg");
  const r = await save(1);
  assert.equal(r.status, "saved");
  assert.equal(r.listing.photoCount, 3);
  assert.equal(r.listing.photoMissing, 1);
  const images = await archive.getImages(r.listing);
  assert.deepEqual(images.map((i) => i.status), ["ok", "missing", "ok"]);
  assert.equal(images[1].blob, null);
  // controllo di integrità con riscaricamento
  let rep = await archive.verifyIntegrity();
  assert.equal(rep.missing, 1);
  assert.equal(rep.ok, 2);
  assert.equal(rep.problems[0].photos.length, 1);
  fail.clear();
  rep = await archive.verifyIntegrity({ redownload: true });
  assert.equal(rep.repaired, 1);
  assert.equal(rep.missing, 0);
  assert.equal((await archive.getListing(r.listing.id)).photoMissing, 0);
  assert.ok((await archive.getImages(r.listing))[1].blob.size > 100);
});

test("integrità: una foto alterata viene riconosciuta", async () => {
  await fresh();
  const r = await save(1);
  const img = (await archive.getImages(r.listing))[0];
  await db.put("images", { ...img, blob: new Blob(["FOTO:alterata"], { type: "image/jpeg" }) });
  const rep = await archive.verifyIntegrity();
  assert.equal(rep.corrupt, 1);
  assert.equal((await archive.getListing(r.listing.id)).photoMissing, 1);
});

test("modifica della copia: l'originale resta, le versioni permettono di tornare indietro", async () => {
  await fresh();
  const { listing } = await save(1);
  let l = await archive.editListing(listing.id, { title: "Titolo mio", price: 18, notes: "in cantina", custom: { Peso: "300 g" } });
  assert.equal(l.title, "Titolo mio");
  assert.equal(l.edited, true);
  assert.deepEqual(l.editedFields.sort(), ["price", "title"]);
  assert.equal(l.notes, "in cantina");
  assert.equal((await archive.getRaw(l.id)).normalized.title, "Annuncio 1", "i dati originali non cambiano");
  let versions = await archive.listVersions(l.id);
  assert.equal(versions.length, 1);
  assert.equal(versions[0].data.title, "Annuncio 1");
  // note e preferiti non creano versioni
  await archive.editListing(l.id, { notes: "altro", favorite: true });
  assert.equal((await archive.listVersions(l.id)).length, 1);
  l = await archive.restoreVersion(l.id, versions[0].id);
  assert.equal(l.title, "Annuncio 1");
  assert.equal(l.price, 20);
  await archive.editListing(l.id, { description: "nuova" });
  l = await archive.restoreOriginal(l.id);
  assert.equal(l.description, "Descrizione 1");
  assert.equal(l.edited, false);
  assert.equal(l.imageIds.length, 3);
  versions = await archive.listVersions(l.id);
  assert.equal(versions.length, 4);
});

test("le versioni si fermano a 30", async () => {
  await fresh();
  const { listing } = await save(1);
  for (let i = 0; i < 34; i++) await archive.editListing(listing.id, { title: `T${i}` });
  const versions = await archive.listVersions(listing.id);
  assert.equal(versions.length, 30);
  assert.equal(versions[0].data.title, "T32");
});

test("aggiornamento da Vinted: segnale di modifica, solo i campi scelti, foto riusate", async () => {
  await fresh();
  const { listing } = await save(1);
  await archive.editListing(listing.id, { title: "Titolo mio" });
  const changedBundle = { details: item(1, { title: "Titolo nuovo su Vinted", price: { amount: "15.0", currency_code: "EUR" }, photos: [photo(12), photo(11), photo(14)] }) };
  const cmp = await archive.compareBundle({ bundle: changedBundle, origin: ORIGIN });
  assert.equal(cmp.changed, true);
  assert.deepEqual(cmp.diffs.map((d) => d.field), ["title", "price", "photos"]);
  assert.equal(cmp.diffs[0].edited, true);
  assert.equal((await archive.getListing(listing.id)).remoteChanged, true);
  fetched = [];
  const l = await archive.applyUpdate(listing.id, { bundle: changedBundle }, ["price", "photos"]);
  assert.equal(l.price, 15);
  assert.equal(l.title, "Titolo mio", "il campo non scelto resta quello modificato dall'utente");
  assert.equal(l.remoteChanged, false);
  assert.deepEqual(l.photoKeys, ["p12", "p11", "p14"]);
  assert.deepEqual(fetched, ["https://images1.vinted.net/f/14.jpg"], "scaricata solo la foto nuova");
  assert.equal(await db.count("images"), 4, "la foto tolta resta per le versioni e l'originale");
  assert.equal((await archive.listVersions(l.id)).length, 2);
  assert.ok((await archive.getRaw(l.id)).latest.bundle);
  // «tieni la mia copia»: nessuna versione nuova, segnale azzerato
  await archive.compareBundle({ bundle: { details: item(1, { title: "Ancora diverso" }) }, origin: ORIGIN });
  await archive.applyUpdate(listing.id, { bundle: { details: item(1, { title: "Ancora diverso" }) } }, []);
  const kept = await archive.getListing(listing.id);
  assert.equal(kept.remoteChanged, false);
  assert.equal(kept.title, "Titolo mio");
  assert.equal((await archive.listVersions(l.id)).length, 2);
  await assert.rejects(archive.applyUpdate(listing.id, { bundle: { details: item(99) } }, ["title"]), /non appartengono/);
});

test("etichette imparate: un id già visto riceve il suo nome", async () => {
  await fresh();
  await archive.saveBundle({ bundle: { details: item(1), page: { id: "1", attrs: {}, breadcrumbs: ["Donna", "Vestiti"] } }, origin: ORIGIN, accountId: ME });
  const r = await archive.saveBundle({ bundle: { upload: { id: 2, title: "Senza etichette", catalog_id: 5, brand_id: 10, user_id: Number(ME), photos: [photo(21)] } }, origin: ORIGIN, accountId: ME });
  assert.equal(r.listing.category, "Donna › Vestiti");
  assert.equal(r.listing.brand, "Zara");
});

test("annunci simili segnalati al salvataggio", async () => {
  await fresh();
  await save(1);
  const r = await save(2, { title: "Annuncio 1", photos: [photo(21)] });
  assert.deepEqual(r.similar.map((s) => s.reason), ["title"]);
  const same = await save(3, { title: "Diverso", photos: [photo(11)] });
  assert.equal(same.similar[0].reason, "photo");
});

test("cestino: ripristino, eliminazione definitiva, scadenza a 30 giorni, risalvataggio", async () => {
  await fresh();
  const a = (await save(1)).listing;
  const b = (await save(2)).listing;
  const c = (await save(3)).listing;
  await archive.trash([a.id, b.id, c.id]);
  assert.ok((await archive.getListing(a.id)).deletedAt);
  await archive.untrash([a.id]);
  assert.equal((await archive.getListing(a.id)).deletedAt, null);
  const again = await save(2);
  assert.equal(again.status, "restored");
  assert.equal((await archive.getListing(b.id)).deletedAt, null);
  assert.equal(await archive.purgeExpired(Date.now() + 29 * 86400e3), 0);
  assert.equal(await archive.purgeExpired(Date.now() + 31 * 86400e3), 1);
  assert.equal(await archive.getListing(c.id), undefined);
  assert.equal(await db.count("images"), 6);
  assert.equal(await db.count("thumbs"), 6);
  assert.equal(await db.count("raw"), 2);
  await archive.editListing(a.id, { title: "x" });
  await archive.purge([a.id]);
  assert.equal(await db.count("versions"), 0);
  assert.equal(await db.count("images"), 3);
});

test("collezioni: eliminare una collezione non tocca gli annunci", async () => {
  await fresh();
  const a = (await save(1)).listing;
  await db.put("collections", { id: "c1", name: "Estate" });
  await archive.patchMany([a.id], (l) => { l.collectionIds = ["c1", "c2"]; });
  await archive.removeCollection("c1");
  assert.deepEqual((await archive.getListing(a.id)).collectionIds, ["c2"]);
  assert.equal(await db.count("collections"), 0);
});

async function seed() {
  const a = (await save(1)).listing;
  const b = (await save(2, { user: { id: 77, login: "altra" } })).listing;
  await archive.editListing(a.id, { title: "Modificato", notes: "nota", custom: { Peso: "1 kg" }, favorite: true, collectionIds: ["c1"] });
  await db.put("collections", { id: "c1", name: "Estate" });
  await db.put("templates", { id: "t1", name: "Spedizione", text: "Spedisco in 24 ore" });
  await db.put("filters", { id: "f1", name: "Zara", filter: { brand: ["Zara"] } });
  return { a, b };
}

test("backup ZIP: esportazione e ripristino completo su una nuova installazione", async () => {
  await fresh();
  const { a } = await seed();
  const out = await exportArchive({ settings: { customFields: ["Peso"], theme: "dark" } });
  assert.match(out.name, /^Vintory-backup-\d{4}-\d{2}-\d{2}_\d{4}\.zip$/);
  assert.deepEqual(out.counts, { listings: 2, photos: 6 });
  const zip = await readZip(out.blob);
  assert.ok(zip.has("vintory.json"));
  assert.equal([...zip.keys()].filter((k) => k.startsWith("images/")).length, 6);
  assert.equal([...zip.keys()].filter((k) => k.startsWith("thumbs/")).length, 6);
  const info = await readBackup(out.blob);
  assert.equal(info.summary.listings, 2);
  assert.equal(info.summary.photos, 6);

  await fresh();                                   // nuova installazione
  const r = await importArchive(out.blob, { mode: "replace" });
  assert.equal(r.added, 2);
  assert.equal(r.photos, 6);
  assert.equal(r.photosMissing, 0);
  assert.deepEqual(r.settings.customFields, ["Peso"]);
  const l = await archive.getListing(a.id);
  assert.equal(l.title, "Modificato");
  assert.equal(l.notes, "nota");
  assert.equal(l.favorite, true);
  assert.deepEqual(l.collectionIds, ["c1"]);
  assert.equal(l.owner, "mine");
  const images = await archive.getImages(l);
  assert.equal(images.length, 3);
  assert.deepEqual(new Uint8Array(await images[0].blob.arrayBuffer()), photoBytes("https://images1.vinted.net/f/11.jpg"));
  assert.equal(images[0].blob.type, "image/jpeg");
  assert.equal((await archive.getThumb(l.coverImageId)).size, 5);
  assert.equal((await archive.listVersions(l.id)).length, 1);
  assert.equal((await archive.getRaw(l.id)).normalized.title, "Annuncio 1");
  assert.equal((await archive.restoreOriginal(l.id)).title, "Annuncio 1");
  assert.equal((await db.getAll("collections"))[0].name, "Estate");
  assert.equal(await db.count("templates"), 1);
  assert.equal(await db.count("filters"), 1);
  assert.equal((await archive.listAll()).find((x) => x.vintedId === "2").owner, "other");
  const rep = await archive.verifyIntegrity();
  assert.equal(rep.ok, 6);
  assert.equal(rep.missing + rep.corrupt, 0);
});

test("importazione in un archivio esistente: unisce senza doppioni", async () => {
  await fresh();
  await seed();
  const out = await exportArchive();
  await fresh();
  await save(2, { title: "Già qui", user: { id: 77, login: "altra" } });
  await save(9);
  const r = await importArchive(out.blob, { mode: "merge" });
  assert.equal(r.added, 1);
  assert.equal(r.skipped, 1);
  const all = await archive.listAll();
  assert.equal(all.length, 3);
  assert.equal(all.find((l) => l.vintedId === "2").title, "Già qui", "l'annuncio presente non viene sovrascritto");
  const again = await importArchive(out.blob, { mode: "merge" });
  assert.equal(again.added, 0);
  assert.equal(again.skipped, 2);
  assert.equal(await db.count("images"), 9);
});

test("backup parziale e file solo dati; file estranei rifiutati", async () => {
  await fresh();
  const { a } = await seed();
  const part = await exportArchive({ ids: [a.id] });
  assert.deepEqual(part.counts, { listings: 1, photos: 3 });
  const json = await exportArchive({ photos: false });
  assert.match(json.name, /\.json$/);
  await fresh();
  const r = await importArchive(json.blob, { mode: "merge" });
  assert.equal(r.added, 2);
  assert.equal(r.photos, 0);
  assert.equal(r.photosMissing, 6);
  const l = (await archive.listAll())[0];
  assert.equal(l.photoMissing, 3);
  assert.equal(l.coverImageId, null);
  await assert.rejects(readBackup(new Blob(["ciao"])), /non è un backup/);
  await assert.rejects(readBackup(new Blob([JSON.stringify({ format: "altro", listings: [] })])), /non è un backup di Vintory/);
  await assert.rejects(readBackup(new Blob([JSON.stringify({ format: "vintory-backup", schema: 99, listings: [] })])), /versione più recente/);
});

test("un backup manomesso non porta dentro indirizzi pericolosi né tipi sbagliati", async () => {
  await fresh();
  const evil = { format: "vintory-backup", schema: 1, listings: [{ id: "x1", vintedId: 1, title: 5, url: "javascript:alert(1)", owner: "admin", colors: "rosso", imageIds: null }, { title: "senza id" }], images: [], raw: [], versions: [] };
  const r = await importArchive(new Blob([JSON.stringify(evil)]), { mode: "merge" });
  assert.equal(r.added, 1);
  assert.equal(r.invalid, 1);
  const l = (await archive.listAll())[0];
  assert.equal(l.url, null);
  assert.equal(l.owner, "other");
  assert.equal(l.title, "5");
  assert.deepEqual(l.colors, []);
  assert.deepEqual(l.imageIds, []);
});
