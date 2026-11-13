/** Impostazioni e piccolo stato in chrome.storage.local (l'archivio vero sta in IndexedDB). */
import { DEFAULT_SETTINGS } from "./constants.js";
import { deepMerge } from "./util.js";

export async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  return deepMerge(DEFAULT_SETTINGS, settings || {});
}

export async function saveSettings(patch) {
  const next = deepMerge(await getSettings(), patch);
  await chrome.storage.local.set({ settings: next });
  return next;
}

export async function getState(key, fallback = null) {
  const k = `state:${key}`;
  return (await chrome.storage.local.get(k))[k] ?? fallback;
}
export const setState = (key, value) => chrome.storage.local.set({ [`state:${key}`]: value });

/** Registro degli ultimi 50 errori tecnici: solo dove e cosa, mai titoli, testi o identificativi. */
export async function logError(where, error) {
  try {
    const list = await getState("errors", []);
    list.unshift({ at: Date.now(), where, message: String(error?.message || error).slice(0, 300) });
    await setState("errors", list.slice(0, 50));
  } catch { /* il registro non deve mai far fallire l'operazione */ }
}
