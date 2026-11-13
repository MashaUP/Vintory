/** IndexedDB: apertura, migrazioni numerate e operazioni di base. */
import { DB_NAME, DB_VERSION } from "./constants.js";

export const STORES = ["listings", "raw", "versions", "images", "thumbs", "collections", "filters", "templates", "jobs", "meta"];
let dbp = null;

function migrate(db, oldVersion) {
  if (oldVersion < 1) {
    const listings = db.createObjectStore("listings", { keyPath: "id" });
    listings.createIndex("vintedId", "vintedId", { unique: true });
    listings.createIndex("owner", "owner");
    db.createObjectStore("raw", { keyPath: "listingId" });
    const versions = db.createObjectStore("versions", { keyPath: "id", autoIncrement: true });
    versions.createIndex("listingId", "listingId");
    const images = db.createObjectStore("images", { keyPath: "id" });
    images.createIndex("listingId", "listingId");
    const thumbs = db.createObjectStore("thumbs", { keyPath: "imageId" });
    thumbs.createIndex("listingId", "listingId");
    db.createObjectStore("collections", { keyPath: "id" });
    db.createObjectStore("filters", { keyPath: "id" });
    db.createObjectStore("templates", { keyPath: "id" });
    db.createObjectStore("jobs", { keyPath: "id" });
    db.createObjectStore("meta", { keyPath: "key" });
  }
}

export function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => migrate(req.result, e.oldVersion);
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { db.close(); dbp = null; };
      db.onclose = () => { dbp = null; };
      resolve(db);
    };
    req.onerror = () => { dbp = null; reject(req.error); };
    req.onblocked = () => { dbp = null; reject(new Error("Archivio occupato da un'altra scheda di Vintory: chiudila e riprova.")); };
  });
  return dbp;
}

export async function close() {
  if (!dbp) return;
  try { (await dbp).close(); } catch { /* già chiuso */ }
  dbp = null;
}

export const rq = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

/**
 * Transazione: fn riceve gli store e deve usare solo richieste IndexedDB
 * (un await su altro chiuderebbe la transazione). Si risolve a transazione completata.
 */
export async function tx(names, mode, fn) {
  const db = await open();
  const list = Array.isArray(names) ? names : [names];
  return new Promise((resolve, reject) => {
    const t = db.transaction(list, mode);
    let out;
    t.oncomplete = () => resolve(out);
    t.onerror = (e) => reject(e.target?.error || t.error || new Error("Errore dell'archivio"));
    t.onabort = () => reject(t.error || new Error("Operazione sull'archivio annullata"));
    const stores = Object.fromEntries(list.map((n) => [n, t.objectStore(n)]));
    const fail = (e) => { try { t.abort(); } catch { /* già chiusa */ } reject(e); };
    let r;
    try { r = fn(stores, t); } catch (e) { fail(e); return; }
    Promise.resolve(r).then((v) => { out = v; }, fail);
  });
}

export const get = (store, key) => tx(store, "readonly", (s) => rq(s[store].get(key)));
export const getAll = (store) => tx(store, "readonly", (s) => rq(s[store].getAll()));
export const put = (store, value) => tx(store, "readwrite", (s) => rq(s[store].put(value)));
export const del = (store, key) => tx(store, "readwrite", (s) => rq(s[store].delete(key)));
export const count = (store) => tx(store, "readonly", (s) => rq(s[store].count()));
export const clear = (store) => tx(store, "readwrite", (s) => rq(s[store].clear()));
export const byIndex = (store, index, key) => tx(store, "readonly", (s) => rq(s[store].index(index).getAll(key)));
export const oneByIndex = (store, index, key) => tx(store, "readonly", (s) => rq(s[store].index(index).get(key)));
export const keysByIndex = (store, index, key) => tx(store, "readonly", (s) => rq(s[store].index(index).getAllKeys(key)));
export const allKeys = (store) => tx(store, "readonly", (s) => rq(s[store].getAllKeys()));

export async function getMeta(key, fallback = null) {
  const r = await get("meta", key);
  return r ? r.value : fallback;
}
export const setMeta = (key, value) => put("meta", { key, value });
