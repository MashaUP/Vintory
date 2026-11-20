/**
 * Aggiornamenti e link del progetto.
 *  - Verifica: legge version.json dal ramo main del repository (pubblico, senza credenziali).
 *  - Download: scarica lo zip dalla radice del repository, ne controlla lo SHA-256
 *    se version.json lo dichiara, e lo salva in Download/Vintory.
 *  - Installazione: estrai lo zip sopra la cartella dell'estensione, poi «Ricarica Vintory».
 *    Un'estensione caricata da cartella non può aggiornarsi da sola: il browser non lo consente.
 *  - Link (Discord, Ko-fi…): links.json nella radice del repository, riletto ogni 12 ore.
 */
import { VERSION, REPO, DEFAULT_LINKS, LINK_HOSTS } from "./constants.js";
import { compareVersions, sha256Hex } from "./util.js";
import { getSettings, saveSettings, getState, setState } from "./store.js";

const REPO_RE = /^[\w.-]{1,60}\/[\w.-]{1,80}$/;
const ZIP_RE = /^[\w.-]{1,80}\.zip$/;
const MIN_INTERVAL = 60_000;

export function githubError(status) {
  if (status === 404) return "version.json non trovato: il controllo funziona quando il repository è pubblico e contiene i file di Vintory.";
  if (status === 403 || status === 429) return "GitHub ha limitato le richieste da questa rete: riprova più tardi.";
  if (!status) return "GitHub non è raggiungibile: controlla la connessione.";
  return `GitHub ha risposto con un errore (HTTP ${status}).`;
}

/** Interpreta version.json. */
export function parseVersionFile(json, installed = VERSION) {
  const latest = String(json?.version || "").trim();
  const cmp = compareVersions(latest, installed);
  if (cmp === null) return { ok: false, error: "version.json non contiene una versione valida (x.y.z)." };
  const zip = ZIP_RE.test(String(json.zip || "")) ? json.zip : null;
  const sha256 = /^[a-f0-9]{64}$/i.test(String(json.sha256 || "")) ? json.sha256.toLowerCase() : null;
  const notes = Array.isArray(json.notes) ? json.notes.map((n) => String(n).slice(0, 300)).slice(0, 12) : [];
  return { ok: true, latest, available: cmp === 1, zip, sha256, notes, date: typeof json.date === "string" ? json.date.slice(0, 10) : null };
}

async function repoOf() {
  const repo = (await getSettings()).updates?.repo || REPO;
  return REPO_RE.test(repo) ? repo : REPO;
}

export async function checkUpdate({ manual = false } = {}) {
  const prev = await getState("update", null);
  if (prev?.checkedAt && Date.now() - prev.checkedAt < MIN_INTERVAL) return prev;
  const repo = await repoOf();
  let status;
  try {
    const res = await fetch(`https://raw.githubusercontent.com/${repo}/main/version.json`, { credentials: "omit", cache: "no-store" });
    if (!res.ok) status = { ok: false, error: githubError(res.status), httpStatus: res.status };
    else status = parseVersionFile(await res.json());
  } catch {
    status = { ok: false, error: githubError(0) };
  }
  status = { ...status, checkedAt: Date.now(), installed: VERSION, repo, manual };
  await setState("update", status);
  return status;
}

/** true una sola volta per ogni nuova versione: serve alla notifica. */
export async function shouldNotify(status) {
  if (!status?.available) return false;
  const s = await getSettings();
  if (s.updates.lastNotified === status.latest) return false;
  await saveSettings({ updates: { lastNotified: status.latest } });
  return true;
}

/** Scarica lo zip della nuova versione (dal service worker: data URL, lì non esiste URL.createObjectURL). */
export async function downloadUpdate() {
  const st = await getState("update", null);
  if (!st?.available || !st.zip) throw new Error("Nessuno zip indicato in version.json: scaricalo dalla pagina GitHub del progetto.");
  const url = `https://github.com/${st.repo}/raw/HEAD/${encodeURIComponent(st.zip)}`;
  // 1. Verifica: lo zip si scarica in memoria e se ne controlla l'impronta prima di salvare qualunque cosa.
  const res = await fetch(url, { credentials: "omit", cache: "no-store" });
  if (!res.ok) throw new Error(`Download non riuscito (HTTP ${res.status}).`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const hash = await sha256Hex(bytes);
  if (st.sha256 && st.sha256 !== hash) throw new Error("Lo zip scaricato non corrisponde all'impronta dichiarata: non viene salvato. Riprova o scaricalo da GitHub.");
  // 2. Salvataggio dall'indirizzo vero di GitHub, come Vinted_Relist: il file si chiama «Vintory-x.y.z.zip» anche se
  //    il browser ignora il nome indicato (succede con un indirizzo «data:» quando un'altra estensione gestisce i download).
  const downloadId = await chrome.downloads.download({ url, filename: `Vintory/${st.zip}`, conflictAction: "uniquify", saveAs: false });
  return { downloadId, name: st.zip, verified: Boolean(st.sha256), hash };
}

/** Vecchi nomi delle chiavi di links.json, ancora accettati (fino alla 1.2.1 «bugReport»). */
const LINK_ALIASES = { bugReport: "bugs" };

/** Tiene solo i link https verso domini noti; gli altri restano quelli di serie. */
export function parseLinks(json) {
  const links = { ...DEFAULT_LINKS };
  const src = { ...(json?.links && typeof json.links === "object" ? json.links : {}) };
  for (const [old, now] of Object.entries(LINK_ALIASES)) {
    if (old in src && !(now in src)) src[now] = src[old];
    delete src[old];
  }
  for (const [k, v] of Object.entries(src)) {
    if (!v || typeof v.url !== "string" || !/^[a-zA-Z]\w{0,30}$/.test(k)) continue;
    if (v.enabled === false) { delete links[k]; continue; }
    let host;
    try { const u = new URL(v.url); if (u.protocol !== "https:") continue; host = u.hostname.replace(/^www\./, ""); } catch { continue; }
    if (!LINK_HOSTS.includes(host)) continue;
    links[k] = { url: v.url, label: String(v.label || DEFAULT_LINKS[k]?.label || k).slice(0, 40) };
  }
  return links;
}

export async function getLinks({ force = false } = {}) {
  const cached = await getState("links", null);
  const s = await getSettings();
  if (!force && (!s.links.autoRefresh || (cached?.at && Date.now() - cached.at < 12 * 3600e3))) return cached?.links || DEFAULT_LINKS;
  if (force && cached?.at && Date.now() - cached.at < MIN_INTERVAL) return cached.links || DEFAULT_LINKS;
  try {
    const res = await fetch(`https://raw.githubusercontent.com/${await repoOf()}/main/links.json`, { credentials: "omit", cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const links = parseLinks(await res.json());
    await setState("links", { at: Date.now(), links, remote: true });
    return links;
  } catch {
    const links = cached?.links || DEFAULT_LINKS;
    await setState("links", { at: Date.now(), links, remote: Boolean(cached?.remote) });
    return links;
  }
}

/**
 * La cartella dell'estensione è stata sovrascritta con un'altra versione?
 * Un'estensione caricata da cartella legge i suoi file dal disco: manifest.json sul disco è
 * la versione estratta, chrome.runtime.getManifest() quella in uso fino a «Ricarica».
 */
export async function diskVersion() {
  const loaded = chrome.runtime.getManifest().version;
  try {
    const res = await fetch(`${chrome.runtime.getURL("manifest.json")}?t=${Date.now()}`, { cache: "no-store" });
    const disk = String((await res.json()).version || "");
    const cmp = compareVersions(disk, loaded);
    return { loaded, disk, pending: cmp !== null && cmp !== 0, newer: cmp === 1 };
  } catch {
    return { loaded, disk: null, pending: false, newer: false };
  }
}
