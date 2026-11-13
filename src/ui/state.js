/** Stato condiviso della dashboard: impostazioni, annunci in memoria, navigazione. */
import * as archive from "../shared/archive.js";
import * as db from "../shared/db.js";
import { searchText } from "../shared/model.js";
import { getSettings, saveSettings } from "../shared/store.js";
import { rpc } from "./lib.js";

export const S = { settings: null, account: { userId: null, origin: "https://www.vinted.it" }, listings: [], byId: new Map(), collections: [], links: {} };

export async function reload() {
  const all = await archive.listAll();
  for (const l of all) l._s = searchText(l);
  S.listings = all;
  S.byId = new Map(all.map((l) => [l.id, l]));
  S.collections = (await db.getAll("collections")).sort((a, b) => a.name.localeCompare(b.name));
}

export async function setSettings(patch) {
  S.settings = await saveSettings(patch);
  return S.settings;
}
export async function loadSettings() { S.settings = await getSettings(); return S.settings; }

/** #nome/arg?chiave=valore */
export function parseRoute(hash = location.hash) {
  const [path, query = ""] = hash.replace(/^#/, "").split("?");
  const [name = "archive", arg = null] = path.split("/");
  return { name: name || "archive", arg, params: Object.fromEntries(new URLSearchParams(query)) };
}
export const go = (hash) => { if (location.hash === `#${hash}`) rerender(); else location.hash = hash; };

let renderer = () => {};
export const setRenderer = (fn) => { renderer = fn; };
export const rerender = () => renderer();

/** Dopo una modifica: ricarica i dati, ridisegna e avvisa popup e altre schede. */
let ownChangeAt = 0;
export const lastOwnChange = () => ownChangeAt;
export async function changed({ silent = false } = {}) {
  ownChangeAt = Date.now();
  await reload();
  if (!silent) rerender();
  rpc("changed").catch(() => {});
}

export const live = () => S.listings.filter((l) => !l.deletedAt);
export const mine = () => live().filter((l) => l.owner === "mine");
export const others = () => live().filter((l) => l.owner !== "mine");
export const trashed = () => S.listings.filter((l) => l.deletedAt);
