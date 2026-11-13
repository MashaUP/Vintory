/** Mattoni dell'interfaccia: elementi creati con il DOM (mai HTML da stringhe), finestre, avvisi, traduzioni. */
import * as archive from "../shared/archive.js";

// ---------------------------------------------------------------- lingua (predisposta: l'italiano è la chiave)
const DICT = { it: {} };
let lang = "it";
export const LANGS = [{ id: "it", label: "Italiano" }];
export const setLang = (l) => { lang = DICT[l] ? l : "it"; document.documentElement.lang = lang; };
/** t("Salvati {n} annunci", { n: 3 }). Una lingua nuova si aggiunge a DICT con le stesse frasi come chiavi. */
export function t(s, vars) {
  let out = DICT[lang]?.[s] ?? s;
  if (vars) for (const [k, v] of Object.entries(vars)) out = out.replaceAll(`{${k}}`, String(v));
  return out;
}

// ---------------------------------------------------------------- DOM
// Nelle pagine dell'estensione append() ignora null, false e stringhe vuote e accetta elenchi:
// quello nativo scriverebbe il testo «null» al posto di un elemento facoltativo assente.
const nativeAppend = Element.prototype.append;
Element.prototype.append = function (...nodes) {
  return nativeAppend.apply(this, nodes.flat(Infinity).filter((n) => n != null && n !== false && n !== ""));
};

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "value" || k === "checked" || k === "disabled" || k === "selected" || k === "indeterminate") el[k] = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  append(el, children);
  return el;
}
export function append(el, children) {
  el.append(...children);
  return el;
}
export const clear = (el) => { el.replaceChildren(); return el; };

/** Solo link https: un indirizzo arrivato da un backup non deve poter eseguire nulla. */
export const safeUrl = (u) => (typeof u === "string" && /^https:\/\//.test(u) ? u : null);

const ICONS = {
  archive: "M3 7h18v4H3zM5 11v9h14v-9M10 15h4",
  users: "M16 11a4 4 0 1 0-8 0M3 21a9 9 0 0 1 18 0",
  clock: "M12 7v5l3 2M12 3a9 9 0 1 0 0 18a9 9 0 0 0 0-18",
  star: "M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z",
  folder: "M3 6h6l2 2h10v11H3z",
  copy: "M8 8h12v12H8zM4 4h12v2M4 4v12h2",
  download: "M12 3v12M7 10l5 5 5-5M4 21h16",
  upload: "M12 21V9M7 14l5-5 5 5M4 3h16",
  doc: "M6 3h9l4 4v14H6zM14 3v5h5M9 13h7M9 17h7",
  chart: "M4 20V10M10 20V4M16 20v-8M22 20H2",
  trash: "M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14",
  shield: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z",
  gear: "M12 9a3 3 0 1 0 0 6a3 3 0 0 0 0-6M19 12l2-1-2-4-2 1-2-1-.5-2h-5L9 7 7 8 5 7 3 11l2 1v2l-2 1 2 4 2-1 2 1 .5 2h5l.5-2 2-1 2 1 2-4-2-1z",
  heart: "M12 20s-7-4.5-9-9a5 5 0 0 1 9-3a5 5 0 0 1 9 3c-2 4.5-9 9-9 9z",
  grid: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
  list: "M4 6h16M4 12h16M4 18h16",
  close: "M5 5l14 14M19 5L5 19",
  search: "M11 4a7 7 0 1 0 0 14a7 7 0 0 0 0-14M21 21l-5-5",
  filter: "M3 5h18l-7 8v6l-4 2v-8z",
  link: "M10 14a4 4 0 0 0 6 0l3-3a4 4 0 0 0-6-6l-1 1M14 10a4 4 0 0 0-6 0l-3 3a4 4 0 0 0 6 6l1-1",
  refresh: "M20 11a8 8 0 1 0-2 6M20 4v7h-7",
  plus: "M12 5v14M5 12h14",
  check: "M5 12l5 5 9-10",
  left: "M15 5l-7 7 7 7",
  right: "M9 5l7 7-7 7",
  edit: "M4 20h4l11-11-4-4L4 16zM14 6l4 4",
  external: "M14 4h6v6M20 4l-9 9M18 14v6H4V6h6",
};
export function icon(name, size = 18) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", size);
  svg.setAttribute("height", size);
  svg.setAttribute("fill", name === "star-full" ? "currentColor" : "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute("d", ICONS[name === "star-full" ? "star" : name] || ICONS.doc);
  svg.append(p);
  return svg;
}

// ---------------------------------------------------------------- avvisi e finestre
let toastBox = null;
export function toast(message, kind = "", ms = 4500) {
  if (!toastBox) { toastBox = h("div", { class: "toasts", role: "status", "aria-live": "polite" }); document.body.append(toastBox); }
  const el = h("div", { class: `toast ${kind}` }, message);
  toastBox.append(el);
  setTimeout(() => el.remove(), kind === "bad" ? Math.max(ms, 8000) : ms);
  return el;
}

/** Finestra modale. actions: [{ label, kind, onClick(close) }]. Esc e clic fuori la chiudono. */
export function modal({ title, body, actions = [], wide = false, onClose = null, dismissable = true }) {
  const prevFocus = document.activeElement;
  const footer = actions.length ? h("footer", null, actions.map((a) => h("button", { class: `btn ${a.kind || ""}`, type: "button", onClick: () => a.onClick?.(close), dataset: a.id ? { act: a.id } : null }, a.label))) : null;
  const titleEl = h("h2", { id: `m${Date.now()}` }, title);
  const box = h("div", { class: `modal${wide ? " wide" : ""}`, role: "dialog", "aria-modal": "true", "aria-labelledby": titleEl.id },
    h("header", null, titleEl, dismissable ? h("button", { class: "btn ghost sm", type: "button", "aria-label": t("Chiudi"), onClick: () => close() }, icon("close")) : null),
    h("div", { class: "body" }, body), footer);
  const overlay = h("div", { class: "overlay" }, box);
  let closed = false;
  function close(result) {
    if (closed) return;
    closed = true;
    document.removeEventListener("keydown", onKey, true);
    overlay.remove();
    onClose?.(result);
    if (prevFocus?.isConnected) prevFocus.focus();
  }
  function onKey(e) {
    if (document.querySelector(".lightbox")) return;          // la foto a tutto schermo gestisce da sé il suo Esc
    if (e.key === "Escape" && dismissable && [...document.querySelectorAll(".overlay")].pop() === overlay) { e.stopPropagation(); close(); }
  }
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay && dismissable) close(); });
  document.addEventListener("keydown", onKey, true);
  document.body.append(overlay);
  (box.querySelector("[autofocus], .body input, .body textarea, .body select, footer .primary, footer .btn") || box.querySelector("button"))?.focus();
  return { close, el: box, body: box.querySelector(".body") };
}

export function confirmDialog(title, text, { okLabel = t("Conferma"), danger = false, cancelLabel = t("Annulla") } = {}) {
  return new Promise((resolve) => {
    let answer = false;
    modal({
      title, body: h("p", null, text), onClose: () => resolve(answer),
      actions: [{ label: cancelLabel, onClick: (c) => c() }, { id: "ok", label: okLabel, kind: danger ? "danger" : "primary", onClick: (c) => { answer = true; c(); } }],
    });
  });
}

export function promptDialog(title, label, value = "", { okLabel = t("Salva"), multiline = false } = {}) {
  return new Promise((resolve) => {
    let answer = null;
    const input = h(multiline ? "textarea" : "input", { class: "input", value, autofocus: true });
    const m = modal({
      title, body: h("label", { class: "field" }, label, input), onClose: () => resolve(answer),
      actions: [{ label: t("Annulla"), onClick: (c) => c() }, { id: "ok", label: okLabel, kind: "primary", onClick: (c) => { answer = input.value.trim(); c(); } }],
    });
    if (!multiline) input.addEventListener("keydown", (e) => { if (e.key === "Enter") { answer = input.value.trim(); m.close(); } });
  });
}

/** Finestra con barra di avanzamento per le operazioni lunghe. */
export function progressDialog(title, text = "") {
  const bar = h("i");
  const label = h("p", { class: "muted" }, text);
  const m = modal({ title, dismissable: false, body: h("div", { class: "stack" }, label, h("div", { class: "progress", role: "progressbar" }, bar)) });
  return {
    set(done, total, msg) { bar.style.width = `${total ? Math.round((done / total) * 100) : 0}%`; if (msg) label.textContent = msg; },
    close: () => m.close(),
  };
}

export function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = h("a", { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export async function copyText(text, okMessage = t("Copiato negli appunti")) {
  try { await navigator.clipboard.writeText(text); toast(okMessage, "good", 2000); } catch { toast(t("Copia non riuscita: seleziona il testo e copialo a mano."), "bad"); }
}

export async function rpc(method, params = {}) {
  const r = await chrome.runtime.sendMessage({ type: "vy:rpc", method, params });
  if (r?.__error) throw new Error(r.error);
  return r;
}

export function applyTheme(theme) {
  const dark = theme === "dark" || (theme !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}

// ---------------------------------------------------------------- miniature
const thumbCache = new Map();
/** URL di una miniatura (in cache finché la pagina resta aperta). */
export async function thumbUrl(imageId) {
  if (!imageId) return null;
  if (thumbCache.has(imageId)) return thumbCache.get(imageId);
  const blob = await archive.getThumb(imageId);
  const url = blob ? URL.createObjectURL(blob) : null;
  thumbCache.set(imageId, url);
  return url;
}
export function forgetThumbs() {
  for (const u of thumbCache.values()) if (u) URL.revokeObjectURL(u);
  thumbCache.clear();
}

let lazy = null;
/** <img> che carica la miniatura solo quando entra nello schermo. */
export function thumbImg(imageId, alt = "") {
  const img = h("img", { alt, loading: "lazy", decoding: "async" });
  if (!imageId) { img.classList.add("empty"); return img; }
  img.dataset.image = imageId;
  lazy ||= new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      lazy.unobserve(e.target);
      thumbUrl(e.target.dataset.image).then((u) => { if (u) e.target.src = u; else e.target.classList.add("empty"); });
    }
  }, { rootMargin: "300px" });
  lazy.observe(img);
  return img;
}
