/**
 * Google Drive (facoltativo): backup cifrati nella cartella nascosta dell'app («appDataFolder»).
 * Stesso metodo di BingeMap: Client ID OAuth di tipo «Applicazione web» inserito dall'utente,
 * accesso con chrome.identity.launchWebAuthFlow, permesso drive.appdata (vede solo i file di Vintory).
 * Nessun server di Vintory. Il token resta in chrome.storage.session (si perde chiudendo il browser),
 * mai su disco, mai nei backup né nel report.
 */
import { getSettings } from "./store.js";

const SCOPE = "https://www.googleapis.com/auth/drive.appdata";
const API = "https://www.googleapis.com/drive/v3";
const UP = "https://www.googleapis.com/upload/drive/v3";
const PREFIX = "Vintory-backup-";
const PIECE = 32 * 256 * 1024;          // 8 MiB: multiplo di 256 KiB, come chiede Google per i caricamenti a pezzi
const TOKEN_KEY = "vy:gtoken";

let authOverride = null;
/** Solo per le prove automatiche: sostituisce la finestra di accesso di Google. */
export const setAuthFlowForTests = (fn) => { authOverride = fn; };

export const redirectUrl = () => chrome.identity.getRedirectURL("google");
export const validClientId = (s) => /^[\w-]{5,200}\.apps\.googleusercontent\.com$/.test(String(s || "").trim());

async function flow(url, interactive) {
  if (authOverride) return authOverride(url, interactive);
  return chrome.identity.launchWebAuthFlow({ url, interactive });
}

async function cachedToken() {
  const { [TOKEN_KEY]: c } = await chrome.storage.session.get(TOKEN_KEY);
  return c && c.exp > Date.now() + 60_000 ? c.token : null;
}

export async function isConnected() {
  return Boolean(await cachedToken());
}

/**
 * Token di accesso. interactive=false prova senza finestra (funziona se hai già dato il consenso
 * e sei collegato a Google nel browser); se non riesce restituisce null.
 */
export async function getToken({ interactive = true } = {}) {
  const c = await cachedToken();
  if (c) return c;
  const cid = String((await getSettings()).drive?.clientId || "").trim();
  if (!validClientId(cid)) {
    if (!interactive) return null;
    throw new Error("Manca il Client ID Google (Backup › Google Drive).");
  }
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.searchParams.set("client_id", cid);
  u.searchParams.set("response_type", "token");
  u.searchParams.set("redirect_uri", redirectUrl());
  u.searchParams.set("scope", SCOPE);
  u.searchParams.set("include_granted_scopes", "true");
  u.searchParams.set("prompt", interactive ? "select_account" : "none");
  let back;
  try { back = await flow(u.href, interactive); } catch (e) {
    if (!interactive) return null;
    throw new Error(/did not approve|canceled|closed/i.test(String(e?.message)) ? "Accesso a Google annullato." : `Accesso a Google non riuscito: ${e?.message || e}. Controlla che l'indirizzo di ritorno sia registrato nel Client ID.`);
  }
  const hash = new URLSearchParams(String(back || "").split("#")[1] || "");
  const token = hash.get("access_token");
  if (!token) {
    if (!interactive) return null;
    const err = hash.get("error");
    throw new Error(err === "redirect_uri_mismatch" ? "Google rifiuta l'indirizzo di ritorno: aggiungilo al Client ID (Backup › Google Drive)." : err ? `Accesso a Google non riuscito: ${err}` : "Accesso a Google annullato.");
  }
  const exp = Date.now() + (Number(hash.get("expires_in")) || 3500) * 1000;
  await chrome.storage.session.set({ [TOKEN_KEY]: { token, exp } });
  return token;
}

export async function signOut() {
  const token = await cachedToken();
  await chrome.storage.session.remove(TOKEN_KEY);
  if (token) { try { await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, { method: "POST" }); } catch { /* senza rete: il token scade da solo */ } }
}

async function gfetch(token, url, opts = {}) {
  let res;
  try { res = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${token}` } }); } catch {
    throw new Error("Google Drive non è raggiungibile: controlla la connessione.");
  }
  if (res.status === 401) { await chrome.storage.session.remove(TOKEN_KEY); throw Object.assign(new Error("Sessione Google scaduta: accedi di nuovo."), { auth: true }); }
  if (res.status === 403) {
    const body = await res.text().catch(() => "");
    throw new Error(/storageQuotaExceeded|quota/i.test(body) ? "Il tuo Google Drive è pieno." : /accessNotConfigured|has not been used|disabled/i.test(body) ? "Google Drive API non attiva nel progetto Google Cloud del Client ID: attivala e riprova." : "Google Drive ha rifiutato la richiesta (403).");
  }
  if (!res.ok && res.status !== 308) throw new Error(`Google Drive ha risposto con un errore (HTTP ${res.status}).`);
  return res;
}

/** Backup di Vintory nel Drive, dal più recente. */
export async function listBackups(token) {
  const q = encodeURIComponent(`name contains '${PREFIX}' and trashed = false`);
  const fields = encodeURIComponent("files(id,name,size,createdTime,appProperties)");
  const res = await gfetch(token, `${API}/files?spaces=appDataFolder&q=${q}&fields=${fields}&orderBy=createdTime%20desc&pageSize=100`);
  const d = await res.json();
  return (d.files || []).filter((f) => f.name.startsWith(PREFIX)).map((f) => ({ id: f.id, name: f.name, size: Number(f.size) || 0, createdAt: Date.parse(f.createdTime) || null, props: f.appProperties || {} }));
}

/** Carica un file a pezzi da 8 MiB (caricamento «resumable»): ogni pezzo si riprova fino a 3 volte. */
export async function uploadBackup(token, blob, name, appProperties = {}, { onProgress = null } = {}) {
  const props = Object.fromEntries(Object.entries(appProperties).map(([k, v]) => [k, String(v).slice(0, 100)]));
  const init = await gfetch(token, `${UP}/files?uploadType=resumable&fields=id`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Type": "application/octet-stream", "X-Upload-Content-Length": String(blob.size) },
    body: JSON.stringify({ name, parents: ["appDataFolder"], mimeType: "application/octet-stream", appProperties: props }),
  });
  const session = init.headers.get("Location");
  if (!session) throw new Error("Google Drive non ha aperto il caricamento.");
  let start = 0;
  while (start < blob.size || blob.size === 0) {
    const end = Math.min(blob.size, start + PIECE);
    let res = null;
    for (let attempt = 1; attempt <= 3 && !res; attempt++) {
      try {
        res = await fetch(session, { method: "PUT", headers: { "Content-Range": blob.size ? `bytes ${start}-${end - 1}/${blob.size}` : "bytes */0" }, body: blob.slice(start, end) });
        if (res.status >= 500) { res = null; throw new Error("server"); }
      } catch {
        if (attempt === 3) throw new Error("Caricamento su Google Drive interrotto: riprova.");
        await new Promise((r) => setTimeout(r, 1500 * attempt));
      }
    }
    if (res.status === 200 || res.status === 201) { onProgress?.({ done: blob.size, total: blob.size }); return (await res.json()).id; }
    if (res.status !== 308) throw new Error(`Caricamento su Google Drive non riuscito (HTTP ${res.status}).`);
    const range = res.headers.get("Range");
    start = range ? Number(range.split("-")[1]) + 1 : end;
    onProgress?.({ done: start, total: blob.size });
    if (blob.size === 0) break;
  }
  throw new Error("Caricamento su Google Drive non concluso.");
}

export async function downloadBackup(token, id, { onProgress = null } = {}) {
  const res = await gfetch(token, `${API}/files/${encodeURIComponent(id)}?alt=media`);
  const total = Number(res.headers.get("Content-Length")) || 0;
  if (!res.body || !onProgress) return new Blob([await res.arrayBuffer()]);
  const reader = res.body.getReader();
  const parts = [];
  let done = 0;
  for (;;) {
    const { value, done: end } = await reader.read();
    if (end) break;
    parts.push(value);
    done += value.length;
    onProgress({ done, total });
  }
  return new Blob(parts);
}

export async function deleteFile(token, id) {
  await gfetch(token, `${API}/files/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** Tiene solo gli ultimi «keep» backup di Vintory nel Drive. */
export async function prune(token, keep) {
  const list = await listBackups(token);
  for (const f of list.slice(Math.max(1, keep))) await deleteFile(token, f.id).catch(() => {});
  return Math.max(0, list.length - Math.max(1, keep));
}

export const backupName = (stamp) => `${PREFIX}${stamp}.vyenc`;
