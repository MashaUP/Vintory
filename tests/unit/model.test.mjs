import test from "node:test";
import assert from "node:assert/strict";
import * as M from "../../src/shared/model.js";
import { compareVersions, num, ts, deepMerge, norm } from "../../src/shared/util.js";
import { DEFAULT_SETTINGS } from "../../src/shared/constants.js";

const ORIGIN = "https://www.vinted.it";
const upload = { id: 501, title: "Giacca di jeans", description: "Usata poco.\nTaglia M.", price: "25.0", currency: "EUR", brand_id: 10, catalog_id: 1907, size_id: 208, status_id: 2, color_ids: [9, 12], user_id: 4242,
  photos: [{ id: 1, full_size_url: "https://images1.vinted.net/f/1.jpg", url: "https://images1.vinted.net/t/1.jpg" }, { id: 2, url: "https://images1.vinted.net/t/2.jpg", thumbnails: [{ type: "thumb310x430", url: "https://images1.vinted.net/s/2.jpg" }, { type: "thumb70x100", url: "https://images1.vinted.net/xs/2.jpg" }] }] };
const details = { id: 501, title: "Giacca di jeans", description: "Usata poco.\nTaglia M.", price: { amount: "25.0", currency_code: "EUR" }, brand_dto: { id: 10, title: "Levi's" }, size_title: "M", status: "Ottime", color1: "Blu", color2: "Bianco",
  user: { id: 4242, login: "masha" }, created_at_ts: "2026-10-01T10:00:00+02:00", path: "/items/501-giacca-di-jeans", photos: upload.photos };

test("normalizeBundle unisce modulo di vendita, scheda e pagina", () => {
  const n = M.normalizeBundle({ upload, details, page: { id: "501", attrs: {}, breadcrumbs: ["Menu del sito"], catalog: { id: "1907", names: ["Donna", "Giacche"] } } }, ORIGIN);
  // Un percorso che finisce con un'altra categoria (per esempio il menu del sito) non vale.
  assert.equal(M.normalizeBundle({ upload, page: { id: "501", attrs: {}, breadcrumbs: [], catalog: { id: "4", names: ["Donna"] } } }, ORIGIN).category, null);
  assert.equal(n.vintedId, "501");
  assert.equal(n.price, 25);
  assert.equal(n.brand, "Levi's");
  assert.equal(n.size, "M");
  assert.equal(n.condition, "Ottime");
  assert.deepEqual(n.colors, ["Blu", "Bianco"]);
  assert.equal(n.category, "Donna › Giacche");
  assert.equal(n.url, "https://www.vinted.it/items/501-giacca-di-jeans");
  assert.equal(n.sellerId, "4242");
  assert.equal(n.ids.catalogId, "1907");
  assert.deepEqual(n.ids.colorIds, ["9", "12"]);
  assert.equal(n.publishedAt, Date.parse("2026-10-01T10:00:00+02:00"));
  assert.deepEqual(n.sources, ["upload", "details", "page"]);
});

test("forme reali (1.0.2): riga dell'armadio con testo, condizioni in item_attributes, dati dei libri", () => {
  const up = { id: 9, title: "The Atlas Six", catalog_id: 2319, item_attributes: [{ code: "condition", ids: [2] }], author: "Olivie Blake", book_title: "The Atlas Six", isbn: 9781529095258, measurement_length: 20, measurement_width: 13, measurement_unit: "cm", photos: [] };
  const row = { id: 9, title: "The Atlas Six", brand: "Newton", size: "Taglia unica", status: "", price: { amount: "4.0", currency_code: "EUR" } };
  const n = M.normalizeBundle({ upload: up, wardrobe: row }, ORIGIN);
  assert.equal(n.condition, "Ottime");
  assert.equal(n.size, "Taglia unica");
  assert.equal(n.brand, "Newton");
  assert.deepEqual(n.extra, { author: "Olivie Blake", bookTitle: "The Atlas Six", isbn: "9781529095258", measures: "20 × 13 cm" });
  assert.equal(n.category, null);
  assert.equal(n.ids.catalogId, "2319");
  assert.ok(M.searchText({ ...n, title: "x" }).includes("olivie blake"));
});

test("foto: sempre la risoluzione più alta, senza doppioni", () => {
  const n = M.normalizeBundle({ upload }, ORIGIN);
  assert.deepEqual(n.photos.map((p) => p.url), ["https://images1.vinted.net/f/1.jpg", "https://images1.vinted.net/s/2.jpg"]);
  assert.deepEqual(n.photos.map((p) => p.key), ["p1", "p2"]);
  assert.equal(n.photos[0].reduced, false);
  assert.equal(n.photos[1].reduced, true);
  assert.equal(M.bestPhotoUrl({ high_resolution: { url: "h" }, url: "u" }), "h");
  assert.equal(M.photoList({ photos: [{ id: 1, url: "a" }, { id: 1, url: "a" }] }).length, 1);
});

test("solo modulo di vendita: condizioni dall'id, nessuna data inventata", () => {
  const n = M.normalizeBundle({ upload }, ORIGIN);
  assert.equal(n.condition, "Ottime");
  assert.equal(n.brand, null);
  assert.equal(n.publishedAt, null);
  assert.equal(n.url, "https://www.vinted.it/items/501");
});

test("riga dell'armadio e stato venduto", () => {
  const n = M.normalizeBundle({ wardrobe: { id: 7, title: "Jeans", price: { amount: "12.5", currency_code: "EUR" }, brand_title: "Zara", size_title: "40", status: "Buone", is_closed: true, user: { id: 77, login: "altra" }, photo: { id: 9, url: "https://images1.vinted.net/t/9.jpg" } } }, ORIGIN);
  assert.equal(n.state, "sold");
  assert.equal(n.condition, "Buone");
  assert.equal(n.price, 12.5);
  assert.equal(n.photos.length, 1);
  assert.equal(M.stateOf({ status: "sold" }), "sold");
  assert.equal(M.stateOf({ is_hidden: true }), "hidden");
  assert.equal(M.normalizeBundle({ page: { attrs: {} } }, ORIGIN), null);
});

test("proprietario: «mio» solo con la prova, nel dubbio «altri»", () => {
  const n = M.normalizeBundle({ details }, ORIGIN);
  assert.equal(M.ownerOf(n, "4242"), "mine");
  assert.equal(M.ownerOf(n, 4242), "mine");
  assert.equal(M.ownerOf(n, "999"), "other");
  assert.equal(M.ownerOf(n, null), "other");
  const noSeller = { ...n, sellerId: null };
  assert.equal(M.ownerOf(noSeller, "4242"), "other");
  assert.equal(M.ownerOf(noSeller, "4242", { uploadOk: true }), "mine");
});

test("impronta e differenze", () => {
  const a = M.normalizeBundle({ details }, ORIGIN);
  const b = M.normalizeBundle({ details: { ...details, price: { amount: "20.0", currency_code: "EUR" }, description: "Usata poco.\nTaglia M.  " } }, ORIGIN);
  assert.notEqual(M.fingerprint(a), M.fingerprint(b));
  assert.equal(M.fingerprint(a), M.fingerprint(M.normalizeBundle({ details: { ...details, description: "Usata poco.  Taglia M." } }, ORIGIN)));
  const archived = { ...a, editedFields: ["price"] };
  const d = M.diffListing(archived, b, ["p1", "p2"]);
  assert.deepEqual(d.map((x) => x.field), ["price"]);
  assert.equal(d[0].edited, true);
  const c = M.normalizeBundle({ details: { ...details, photos: [upload.photos[1], { id: 3, url: "https://images1.vinted.net/t/3.jpg" }] } }, ORIGIN);
  const dp = M.diffListing(a, c, ["p1", "p2"]).find((x) => x.field === "photos");
  assert.equal(dp.added, 1);
  assert.equal(dp.removed, 1);
  // un campo che Vinted non ha fornito non è una differenza
  assert.deepEqual(M.diffListing({ ...a, brand: "Levi's" }, { ...a, brand: null }, ["p1", "p2"]), []);
});

const L = (o) => ({ id: o.id, vintedId: String(o.id), owner: "mine", title: "", description: "", colors: [], collectionIds: [], dhashes: [], ...o });
const list = [
  L({ id: "a", title: "Giacca di jeans", brand: "Levi's", size: "M", price: 25, savedAt: 3, colors: ["Blu"], condition: "Ottime", category: "Giacche", favorite: true }),
  L({ id: "b", title: "Vestito a fiori", brand: "Zara", size: "S", price: 12, savedAt: 1, colors: ["Rosso", "Blu"], condition: "Buone", category: "Vestiti", collectionIds: ["c1"] }),
  L({ id: "c", title: "Scarpe da ginnastica", brand: "Nike", size: "40", price: null, savedAt: 2, description: "Pochissimo usate, perché strette", online: "offline" }),
];

test("ricerca senza accenti e su più parole, filtri combinati", () => {
  const f = (o) => M.filterListings(list, { ...M.EMPTY_FILTER, ...o }).map((l) => l.id);
  assert.deepEqual(f({ q: "JEANS giacca" }), ["a"]);
  assert.deepEqual(f({ q: "perche" }), ["c"]);
  assert.deepEqual(f({ brand: ["Zara", "Nike"] }), ["b", "c"]);
  assert.deepEqual(f({ color: ["Blu"] }), ["a", "b"]);
  assert.deepEqual(f({ priceMin: 10, priceMax: 20 }), ["b"]);
  assert.deepEqual(f({ favorite: true }), ["a"]);
  assert.deepEqual(f({ collection: "c1" }), ["b"]);
  assert.deepEqual(f({ online: "offline" }), ["c"]);
  assert.deepEqual(f({ q: "zzz" }), []);
});

test("ordinamento: i valori mancanti sempre in fondo", () => {
  const s = (k) => M.sortListings(list, k).map((l) => l.id);
  assert.deepEqual(s("price:asc"), ["b", "a", "c"]);
  assert.deepEqual(s("price:desc"), ["a", "b", "c"]);
  assert.deepEqual(s("savedAt:desc"), ["a", "c", "b"]);
  assert.deepEqual(s("title:asc"), ["a", "c", "b"]);
});

test("filtri disponibili e statistiche", () => {
  const fc = M.facets(list);
  assert.deepEqual(fc.color[0], { value: "Blu", count: 2 });
  assert.equal(fc.brand.length, 3);
  const st = M.stats(list);
  assert.equal(st.count, 3);
  assert.equal(st.totalValue, 37);
  assert.equal(st.avgPrice, 18.5);
  assert.equal(st.favorites, 1);
  assert.equal(st.offline, 1);
  assert.equal(st.byBrand.length, 3);
});

test("annunci simili: stessa foto o stesso titolo e prezzo, mai tra «miei» e «altri»", () => {
  assert.equal(M.hamming("ffffffffffffffff", "fffffffffffffffe"), 1);
  assert.equal(M.hamming("0000000000000000", "ffffffffffffffff"), 64);
  const a = L({ id: "a", title: "Giacca jeans Levi's", price: 25, dhashes: ["a1b2c3d4e5f60718"] });
  const b = L({ id: "b", title: "Altro titolo", price: 30, dhashes: ["a1b2c3d4e5f60719"] });
  const c = L({ id: "c", title: "levi's JEANS giacca", price: 25, dhashes: ["0f0f0f0f0f0f0f0f"] });
  const d = L({ id: "d", title: "Giacca jeans Levi's", price: 25, owner: "other", dhashes: ["a1b2c3d4e5f60718"] });
  const e = L({ id: "e", title: "Tutt'altro", price: 5, dhashes: ["1234567890abcdef"] });
  assert.deepEqual(M.findSimilar(a, [a, b, c, d, e]), [{ id: "b", reason: "photo" }, { id: "c", reason: "title" }]);
  const groups = M.similarGroups([a, b, c, d, e]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].map((x) => x.id).sort(), ["a", "b", "c"]);
});

test("CSV per Excel italiano e niente formule dal testo", () => {
  const rows = M.toRows([L({ id: "1", title: '=CMD("x")', description: "riga1\nriga2; con punto e virgola", price: 12.5, custom: { Peso: "300 g" } })], ["Peso"]);
  const csv = M.toCsv(rows);
  assert.ok(csv.startsWith("﻿ID Vinted;Titolo;"));
  assert.ok(csv.includes("\"'=CMD(\"\"x\"\")\""));
  assert.ok(csv.includes('"riga1\nriga2; con punto e virgola"'));
  assert.ok(csv.includes(";12,5;"));
  assert.ok(csv.trimEnd().endsWith(";300 g"));
});

test("modelli, formato per Vinted_Relist, cestino, backup scaduto, indirizzi", () => {
  assert.equal(M.applyTemplate("Taglia {taglia}, {Marca}, € {prezzo} {ignoto}", { size: "M", brand: "Zara", price: 12.5 }), "Taglia M, Zara, € 12,5 {ignoto}");
  const ph = [{ file: "photos/1/01.jpg", type: "image/jpeg", width: 10, height: 10, sha256: "x" }];
  const e1 = M.relistEntry(L({ id: "1", vintedId: "1", title: "T", ids: { catalogId: "5" }, origin: ORIGIN, url: "u", photoCount: 2, editedFields: ["title"] }), { capturedAt: 1, bundle: { upload } }, ph);
  assert.equal(e1.uploadDraft.catalog_id, 1907);
  assert.equal(e1.uploadDraftAt, 1);
  assert.deepEqual(e1.photos, ph);
  assert.equal(e1.photosMissing, 1);
  assert.deepEqual(e1.editedFields, ["title"]);
  // Dopo «Aggiorna da Vinted» vale l'ultima lettura del modulo di vendita.
  const e2 = M.relistEntry(L({ id: "1", vintedId: "1", title: "T" }), { capturedAt: 1, bundle: { upload }, latest: { capturedAt: 2, bundle: { upload: { ...upload, price: "9.0" } } } }, []);
  assert.equal(e2.uploadDraft.price, "9.0");
  assert.equal(e2.uploadDraftAt, 2);
  const pkg = M.relistPackage([e1, e2], "1.1.0");
  assert.equal(pkg.format, "vintory-relist");
  assert.equal(pkg.schema, 2);
  assert.equal(pkg.count, 2);
  const now = Date.now();
  assert.equal(M.trashExpired(now - 31 * 86400e3, now), true);
  assert.equal(M.trashExpired(now - 29 * 86400e3, now), false);
  assert.equal(M.trashExpired(null, now), false);
  assert.equal(M.trashDaysLeft(now - 29 * 86400e3, now), 1);
  assert.equal(M.backupDue(null, 7, now), true);
  assert.equal(M.backupDue(now - 8 * 86400e3, 7, now), true);
  assert.equal(M.backupDue(now - 86400e3, 7, now), false);
  assert.equal(M.backupDue(null, 0, now), false);
  assert.deepEqual(M.parseVintedUrl("https://www.vinted.it/items/123-giacca?x=1"), { kind: "item", id: "123", origin: ORIGIN });
  assert.deepEqual(M.parseVintedUrl("https://www.vinted.it/member/77-anna"), { kind: "wardrobe", id: "77", origin: ORIGIN });
  assert.equal(M.parseVintedUrl("non un url").kind, "none");
});

test("id utente dal token, senza leggere altro", () => {
  const payload = Buffer.from(JSON.stringify({ sub: "4242", exp: 1 })).toString("base64url");
  assert.equal(M.userIdFromToken(`aaa.${payload}.zzz`), "4242");
  assert.equal(M.userIdFromToken("rotto"), null);
  assert.equal(M.userIdFromToken(`a.${Buffer.from('{"sub":"x"}').toString("base64url")}.b`), null);
});

test("utilità: versioni, numeri, date, impostazioni", () => {
  assert.equal(compareVersions("1.10.0", "1.9.9"), 1);
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
  assert.equal(compareVersions("0.9.0", "1.0.0"), -1);
  assert.equal(compareVersions("1.0", "1.0.0"), null);
  assert.equal(num("1.234,50 €"), 1234.5);
  assert.equal(num({ amount: "9.90" }), 9.9);
  assert.equal(num(""), null);
  assert.equal(ts(1760000000), 1760000000000);
  assert.equal(ts("pippo"), null);
  assert.equal(norm("Perché  NO?"), "perche no");
  const merged = deepMerge(DEFAULT_SETTINGS, { backup: { remindDays: 3 }, customFields: ["A"] });
  assert.equal(merged.backup.remindDays, 3);
  assert.equal(merged.backup.keep, 5);
  assert.deepEqual(merged.customFields, ["A"]);
});
