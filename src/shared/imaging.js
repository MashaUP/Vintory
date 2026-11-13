/**
 * Analisi di una foto: dimensioni, miniatura e impronta visiva (dHash a 64 bit).
 * Funziona nel service worker e nelle pagine (createImageBitmap + OffscreenCanvas).
 * Se la foto non si decodifica, ok resta false: il controllo di integrità lo segnala.
 */
import { THUMB_SIDE } from "./constants.js";

export async function analyze(blob) {
  const out = { supported: false, ok: false, width: null, height: null, thumb: null, dhash: null };
  if (typeof createImageBitmap !== "function" || typeof OffscreenCanvas !== "function") return out;
  out.supported = true;
  let bmp;
  try { bmp = await createImageBitmap(blob); } catch { return out; }
  try {
    out.width = bmp.width;
    out.height = bmp.height;
    out.ok = bmp.width > 0 && bmp.height > 0;
    if (!out.ok) return out;
    const k = Math.min(1, THUMB_SIDE / Math.max(bmp.width, bmp.height));
    const tw = Math.max(1, Math.round(bmp.width * k));
    const th = Math.max(1, Math.round(bmp.height * k));
    const c = new OffscreenCanvas(tw, th);
    const g = c.getContext("2d");
    g.fillStyle = "#fff";
    g.fillRect(0, 0, tw, th);
    g.drawImage(bmp, 0, 0, tw, th);
    out.thumb = await c.convertToBlob({ type: "image/jpeg", quality: 0.82 });
    const s = new OffscreenCanvas(9, 8);
    const sg = s.getContext("2d", { willReadFrequently: true });
    sg.drawImage(bmp, 0, 0, 9, 8);
    const d = sg.getImageData(0, 0, 9, 8).data;
    const gray = (x, y) => { const i = (y * 9 + x) * 4; return d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114; };
    let hex = "";
    for (let y = 0; y < 8; y++) {
      let byte = 0;
      for (let x = 0; x < 8; x++) byte = (byte << 1) | (gray(x, y) > gray(x + 1, y) ? 1 : 0);
      hex += byte.toString(16).padStart(2, "0");
    }
    out.dhash = hex;
  } catch { /* miniatura non disponibile: la foto originale resta salvata */ } finally {
    try { bmp.close(); } catch { /* niente */ }
  }
  return out;
}
