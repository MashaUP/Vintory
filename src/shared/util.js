/** Funzioni di utilità pure (browser e Node). */

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function uid(prefix = "") {
  const a = new Uint8Array(12);
  crypto.getRandomValues(a);
  return prefix + [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(data) {
  const buf = data instanceof ArrayBuffer ? data : data.buffer ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : await data.arrayBuffer();
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Minuscole, senza accenti né punteggiatura: per ricerca e confronto. */
export const norm = (s) => String(s ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

export const num = (v) => {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "object") return num(v.amount ?? v.value);
  let s = String(v).replace(/[^\d.,-]/g, "");
  if (s.includes(",") && s.includes(".")) s = s.lastIndexOf(",") > s.lastIndexOf(".") ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  else s = s.replace(",", ".");
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

/** Timestamp in ms da secondi, millisecondi o stringa ISO. Mai inventato. */
export const ts = (v) => {
  if (v == null || v === "") return null;
  if (typeof v === "number") return v > 1e12 ? v : v > 1e9 ? v * 1000 : null;
  if (/^\d+$/.test(String(v))) return ts(Number(v));
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};

export function fmtPrice(price, currency = "EUR") {
  if (price == null) return "—";
  try { return new Intl.NumberFormat("it-IT", { style: "currency", currency: currency || "EUR" }).format(price); } catch { return `${price} ${currency || ""}`.trim(); }
}
export const fmtDate = (t, withTime = false) => (t ? new Date(t).toLocaleString("it-IT", withTime ? { dateStyle: "short", timeStyle: "short" } : { dateStyle: "medium" }) : "—");
export function fmtBytes(n) {
  if (n == null) return "—";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}
export const dayStamp = (t = Date.now()) => {
  const d = new Date(t);
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
};
export const safeName = (s, max = 60) => (norm(s).replace(/ /g, "-").slice(0, max) || "annuncio");

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/** Unione profonda di oggetti semplici (gli array si sostituiscono). */
export function deepMerge(base, patch) {
  if (patch === undefined) return base;
  if (typeof base !== "object" || base === null || Array.isArray(base) || typeof patch !== "object" || patch === null || Array.isArray(patch)) return patch;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) out[k] = k in base ? deepMerge(base[k], v) : v;
  return out;
}

const SEMVER = /^(\d{1,4})\.(\d{1,4})\.(\d{1,6})$/;
/** 1 se a > b, -1 se a < b, 0 se uguali, null se una non è x.y.z. */
export function compareVersions(a, b) {
  const pa = SEMVER.exec(String(a).trim());
  const pb = SEMVER.exec(String(b).trim());
  if (!pa || !pb) return null;
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

export const extOf = (type) => ({ "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "image/avif": "avif" }[type] || "jpg");
export const typeOfExt = (name) => ({ jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", avif: "image/avif" }[String(name).split(".").pop().toLowerCase()] || "application/octet-stream");
