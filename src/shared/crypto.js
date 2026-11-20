/**
 * Cifratura dei backup con una password (formato «VYENC1»).
 * - Chiave: PBKDF2-SHA256 (600 000 iterazioni, sale casuale) → AES-GCM a 256 bit.
 * - Il file è diviso in blocchi da 4 MiB, ognuno cifrato e autenticato a parte: non serve
 *   tenere in memoria l'intero archivio. Ogni blocco porta nel controllo l'intestazione,
 *   il suo numero e se è l'ultimo: blocchi scambiati, tolti o un file troncato non si aprono.
 * - La password non viene mai salvata nel file né mandata a Google.
 *
 * File: "VYENC1" · lunghezza intestazione (4 byte) · intestazione JSON · blocchi (4 byte di lunghezza + dati cifrati).
 */
const MAGIC = new TextEncoder().encode("VYENC1");
const CHUNK = 4 * 1024 * 1024;
export const ITERATIONS = 600_000;
const enc = new TextEncoder();
const dec = new TextDecoder();

const b64 = (bytes) => btoa(String.fromCharCode(...bytes));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const u32 = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n); return b; };
const concat = (...parts) => { const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };

async function deriveKey(password, salt, iterations) {
  if (!password) throw new Error("Serve una password.");
  const base = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

const ivFor = (prefix, i) => concat(prefix, u32(i));
const aadFor = (header, i, last) => concat(header, u32(i), new Uint8Array([last ? 1 : 0]));

export async function isEncrypted(blob) {
  const head = new Uint8Array(await blob.slice(0, MAGIC.length).arrayBuffer());
  return head.length === MAGIC.length && head.every((b, i) => b === MAGIC[i]);
}

/** Cifra un Blob. onProgress({ done, total }) in byte. */
export async function encryptBlob(blob, password, { onProgress = null, iterations = ITERATIONS } = {}) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prefix = crypto.getRandomValues(new Uint8Array(8));
  const header = enc.encode(JSON.stringify({ v: 1, kdf: "PBKDF2-SHA256", iter: iterations, salt: b64(salt), prefix: b64(prefix), chunk: CHUNK, size: blob.size }));
  const key = await deriveKey(password, salt, iterations);
  const parts = [MAGIC, u32(header.length), header];
  const count = Math.max(1, Math.ceil(blob.size / CHUNK));
  for (let i = 0; i < count; i++) {
    const plain = new Uint8Array(await blob.slice(i * CHUNK, (i + 1) * CHUNK).arrayBuffer());
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: ivFor(prefix, i), additionalData: aadFor(header, i, i === count - 1) }, key, plain));
    parts.push(u32(ct.length), ct);
    onProgress?.({ done: Math.min(blob.size, (i + 1) * CHUNK), total: blob.size });
  }
  return new Blob(parts, { type: "application/octet-stream" });
}

/** Decifra un file «VYENC1». Password sbagliata, file troncato o modificato → errore chiaro. */
export async function decryptBlob(blob, password, { onProgress = null, type = "application/zip" } = {}) {
  if (!(await isEncrypted(blob))) throw new Error("Il file non è un backup cifrato di Vintory.");
  let pos = MAGIC.length;
  const read = async (n) => { const b = new Uint8Array(await blob.slice(pos, pos + n).arrayBuffer()); pos += n; if (b.length !== n) throw new Error("Backup cifrato incompleto: il file è troncato."); return b; };
  const hlen = new DataView((await read(4)).buffer).getUint32(0);
  if (hlen > 4096) throw new Error("Backup cifrato danneggiato.");
  const header = await read(hlen);
  let h;
  try { h = JSON.parse(dec.decode(header)); } catch { throw new Error("Backup cifrato danneggiato."); }
  if (h.v !== 1 || h.kdf !== "PBKDF2-SHA256") throw new Error("Backup cifrato creato da una versione più recente di Vintory: aggiorna l'estensione.");
  const key = await deriveKey(password, unb64(h.salt), h.iter);
  const prefix = unb64(h.prefix);
  const count = Math.max(1, Math.ceil(h.size / h.chunk));
  const out = [];
  let done = 0;
  for (let i = 0; i < count; i++) {
    const len = new DataView((await read(4)).buffer).getUint32(0);
    if (len > h.chunk + 16) throw new Error("Backup cifrato danneggiato.");
    const ct = await read(len);
    let plain;
    try {
      plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: ivFor(prefix, i), additionalData: aadFor(header, i, i === count - 1) }, key, ct));
    } catch {
      throw new Error(i === 0 ? "Password sbagliata (oppure il file è danneggiato)." : "Backup cifrato danneggiato: un blocco non torna.");
    }
    out.push(plain);
    done += plain.length;
    onProgress?.({ done, total: h.size });
  }
  if (pos !== blob.size) throw new Error("Backup cifrato danneggiato: ci sono dati in più.");
  if (done !== h.size) throw new Error("Backup cifrato incompleto.");
  return new Blob(out, { type });
}
