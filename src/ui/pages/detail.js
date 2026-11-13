/** Scheda completa di un annuncio: foto, dati, modifica, note, versioni, dati tecnici, aggiornamento, «Prepara». */
import { h, t, clear, icon, toast, modal, confirmDialog, saveBlob, copyText, safeUrl, rpc, progressDialog } from "../lib.js";
import { S, changed } from "../state.js";
import * as archive from "../../shared/archive.js";
import * as db from "../../shared/db.js";
import { findSimilar, applyTemplate } from "../../shared/model.js";
import { exportForRelist } from "../relist-export.js";
import { FIELD_LABELS } from "../../shared/constants.js";
import { fmtPrice, fmtDate, fmtBytes, num } from "../../shared/util.js";
import { badges, photosZip, checkLinks, ONLINE_LABEL } from "./list.js";
import { pickCollections } from "./more.js";

const REASONS = { edit: "Prima di una tua modifica", refresh: "Prima di un aggiornamento da Vinted", restore: "Prima di un ripristino" };
const fullText = (l) => [l.title, "", l.description, "", [l.brand && `Marca: ${l.brand}`, l.size && `Taglia: ${l.size}`, l.condition && `Condizioni: ${l.condition}`, (l.colors || []).length && `Colore: ${l.colors.join(", ")}`, l.price != null && `Prezzo: ${fmtPrice(l.price, l.currency)}`].filter(Boolean).join("\n")].join("\n").trim();
const showVal = (f, v) => (v == null || v === "" ? "—" : f === "price" ? fmtPrice(v) : Array.isArray(v) ? v.join(", ") : f === "state" ? ({ active: "Attivo", sold: "Venduto", reserved: "Riservato", hidden: "Nascosto" }[v] || v) : String(v));

// ---------------------------------------------------------------- foto a tutto schermo (F19)

function lightbox(urls, start = 0) {
  let i = start;
  let zoom = 1;
  const img = h("img", { alt: "" });
  const counter = h("span", { class: "lb-count" });
  const show = () => { img.src = urls[i]; zoom = 1; img.style.transform = ""; counter.textContent = `${i + 1} / ${urls.length}`; };
  const step = (d) => { i = (i + d + urls.length) % urls.length; show(); };
  const setZoom = (z) => { zoom = Math.min(5, Math.max(1, z)); img.style.transform = `scale(${zoom})`; img.style.cursor = zoom > 1 ? "zoom-out" : "zoom-in"; };
  const box = h("div", { class: "lightbox", role: "dialog", "aria-modal": "true", "aria-label": t("Foto ingrandita") },
    h("div", { class: "lb-bar" }, counter,
      h("button", { class: "btn sm", type: "button", "aria-label": t("Riduci"), onClick: () => setZoom(zoom - 0.5) }, "−"),
      h("button", { class: "btn sm", type: "button", "aria-label": t("Ingrandisci"), onClick: () => setZoom(zoom + 0.5) }, "+"),
      h("button", { class: "btn sm", type: "button", "aria-label": t("Chiudi"), onClick: () => close() }, icon("close"))),
    urls.length > 1 ? h("button", { class: "lb-nav prev", type: "button", "aria-label": t("Foto precedente"), onClick: () => step(-1) }, icon("left", 28)) : null,
    h("div", { class: "lb-stage" }, img),
    urls.length > 1 ? h("button", { class: "lb-nav next", type: "button", "aria-label": t("Foto successiva"), onClick: () => step(1) }, icon("right", 28)) : null);
  const onKey = (e) => {
    if (e.key === "Escape") { e.stopPropagation(); close(); } else if (e.key === "ArrowLeft") step(-1); else if (e.key === "ArrowRight") step(1); else if (e.key === "+") setZoom(zoom + 0.5); else if (e.key === "-") setZoom(zoom - 0.5);
  };
  function close() { document.removeEventListener("keydown", onKey, true); box.remove(); }
  img.addEventListener("click", () => setZoom(zoom > 1 ? 1 : 2.5));
  box.addEventListener("wheel", (e) => { e.preventDefault(); setZoom(zoom + (e.deltaY < 0 ? 0.25 : -0.25)); }, { passive: false });
  box.addEventListener("mousedown", (e) => { if (e.target === box || e.target.classList.contains("lb-stage")) close(); });
  document.addEventListener("keydown", onKey, true);
  document.body.append(box);
  show();
  box.querySelector("button").focus();
}

// ---------------------------------------------------------------- aggiornamento da Vinted (F42)

export async function updateFromVinted(l, onDone) {
  const wait = progressDialog(t("Leggo l'annuncio su Vinted"), t("Apro Vinted in sola lettura…"));
  let r;
  try { r = await rpc("vinted.read", { listingId: l.id }); } catch (e) { wait.close(); toast(e.message, "bad"); return; }
  wait.close();
  if (!r.ok) {
    toast(r.message || t("Lettura non riuscita."), "bad");
    if (r.kind === "notFound") { await changed(); onDone?.(); }
    return;
  }
  if (!r.diffs.length) {
    await archive.applyUpdate(l.id, { bundle: r.bundle }, []);
    await changed();
    toast(t("Nessuna differenza: la copia archiviata corrisponde a Vinted."), "good");
    onDone?.();
    return;
  }
  const picks = new Map(r.diffs.map((d) => [d.field, !d.edited]));
  const rows = r.diffs.map((d) => h("tr", null,
    h("td", null, h("label", { class: "check" }, h("input", { type: "checkbox", checked: picks.get(d.field), dataset: { field: d.field }, onChange: (e) => picks.set(d.field, e.target.checked) }), h("strong", null, t(d.label)))),
    h("td", { class: "diff-old" }, d.field === "photos" ? t("{n} foto", { n: d.old }) : showVal(d.field, d.old)),
    h("td", { class: "diff-new" }, d.field === "photos" ? `${t("{n} foto", { n: d.new })}${d.added ? ` · ${t("{n} nuove", { n: d.added })}` : ""}${d.removed ? ` · ${t("{n} tolte", { n: d.removed })}` : ""}${d.reordered ? ` · ${t("ordine cambiato")}` : ""}` : showVal(d.field, d.new),
      d.edited ? h("div", { class: "small muted" }, t("Questo campo l'hai modificato tu: resta com'è se non lo spunti.")) : null)));
  const apply = async (fields, close) => {
    const p = fields.includes("photos") ? progressDialog(t("Scarico le foto"), "") : null;
    try {
      await archive.applyUpdate(l.id, { bundle: r.bundle }, fields, { onProgress: ({ photo, photos }) => p?.set(photo, photos) });
      await changed();
      toast(fields.length ? t("Scheda aggiornata: la versione precedente è in «Versioni».") : t("Copia archiviata lasciata com'è."), "good");
      close();
      onDone?.();
    } catch (e) { toast(e.message, "bad"); } finally { p?.close(); }
  };
  modal({
    title: t("Differenze con Vinted"), wide: true,
    body: h("div", { class: "stack" },
      h("p", { class: "muted" }, t("Scegli cosa aggiornare. Niente viene sovrascritto senza la tua spunta, e la versione di adesso resta recuperabile.")),
      h("div", { class: "table-wrap" }, h("table", { class: "table" }, h("thead", null, h("tr", null, h("th", null, t("Campo")), h("th", null, t("In archivio")), h("th", null, t("Su Vinted adesso")))), h("tbody", null, rows)))),
    actions: [
      { label: t("Tieni la mia copia"), onClick: (c) => apply([], c) },
      { id: "apply", label: t("Applica i campi spuntati"), kind: "primary", onClick: (c) => apply([...picks].filter(([, on]) => on).map(([f]) => f), c) },
    ],
  });
}

// ---------------------------------------------------------------- «Prepara» (F45–F48)

async function prepare(l, onDone) {
  const templates = await db.getAll("templates");
  const title = h("input", { class: "input", value: l.title, maxlength: "300" });
  const desc = h("textarea", { class: "input", rows: "9" }, l.description || "");
  desc.value = l.description || "";
  const price = h("input", { class: "input", type: "number", min: "0", step: "0.5", value: l.price ?? "" });
  const draft = () => ({ ...l, title: title.value.trim(), description: desc.value, price: num(price.value) });
  const tplSel = templates.length ? h("select", { class: "input", "aria-label": t("Modello di descrizione") }, templates.map((x) => h("option", { value: x.id }, x.name))) : null;
  const body = h("div", { class: "stack" },
    h("p", { class: "muted" }, t("Una copia modificabile dei dati archiviati, da riusare per un nuovo annuncio. Vintory non pubblica nulla: copi i testi e scarichi le foto.")),
    h("label", { class: "field" }, t("Titolo"), title),
    h("label", { class: "field" }, t("Descrizione"), desc),
    tplSel ? h("div", { class: "row" }, tplSel,
      h("button", { class: "btn sm", type: "button", onClick: () => { const x = templates.find((y) => y.id === tplSel.value); if (x) desc.value = `${desc.value.trimEnd()}${desc.value.trim() ? "\n\n" : ""}${applyTemplate(x.text, draft())}`; } }, t("Aggiungi in fondo")),
      h("button", { class: "btn sm", type: "button", onClick: () => { const x = templates.find((y) => y.id === tplSel.value); if (x) desc.value = applyTemplate(x.text, draft()); } }, t("Sostituisci"))) : h("div", { class: "small muted" }, t("Suggerimento: crea dei modelli di descrizione nella sezione «Modelli» per inserirli qui.")),
    h("label", { class: "field", style: { maxWidth: "200px" } }, t("Prezzo"), price),
    h("div", { class: "row" },
      h("button", { class: "btn sm", type: "button", onClick: () => copyText(title.value) }, icon("copy", 15), t("Copia titolo")),
      h("button", { class: "btn sm", type: "button", onClick: () => copyText(desc.value) }, icon("copy", 15), t("Copia descrizione")),
      h("button", { class: "btn sm", type: "button", onClick: () => copyText(fullText(draft())) }, icon("copy", 15), t("Copia tutto")),
      h("button", { class: "btn sm", type: "button", onClick: () => photosZip([l]) }, icon("download", 15), t("Foto (ZIP)")),
      h("button", { class: "btn sm", type: "button", onClick: () => exportForRelist([l], { draft: draft() }) }, icon("upload", 15), t("Esporta per Vinted_Relist"))));
  modal({
    title: t("Prepara: {t}", { t: l.title }), wide: true, body,
    actions: [
      { label: t("Chiudi"), onClick: (c) => c() },
      { label: t("Apri «Vendi» su Vinted"), onClick: () => window.open(`${l.origin}/items/new`, "_blank", "noopener") },
      { id: "save-draft", label: t("Salva queste modifiche nella scheda"), kind: "primary", onClick: async (c) => { const d = draft(); await archive.editListing(l.id, { title: d.title, description: d.description, price: d.price }); await changed(); toast(t("Modifiche salvate nella copia archiviata."), "good"); c(); onDone?.(); } },
    ],
  });
}

// ---------------------------------------------------------------- scheda

export async function openDetail(id, { update = false } = {}) {
  let l = await archive.getListing(id);
  if (!l) { toast(t("Annuncio non trovato nell'archivio."), "bad"); return; }
  let urls = [];
  let tab = "info";
  const body = h("div", { class: "detail" });
  const m = modal({ title: l.title || t("Annuncio"), wide: true, body, onClose: () => { for (const u of urls) if (u) URL.revokeObjectURL(u); } });
  const titleEl = m.el.querySelector("header h2");

  async function refresh() {
    l = await archive.getListing(id);
    if (!l) { m.close(); return; }
    titleEl.textContent = l.title || t("Annuncio");
    await draw();
  }

  async function draw() {
    for (const u of urls) if (u) URL.revokeObjectURL(u);
    const images = await archive.getImages(l);
    urls = images.map((i) => (i.blob ? URL.createObjectURL(i.blob) : null));
    const okIdx = urls.map((u, i) => (u ? i : -1)).filter((i) => i >= 0);
    let cur = okIdx[0] ?? -1;
    const main = h("img", { class: "main", alt: l.title || "" });
    const info = h("div", { class: "small muted" });
    const strip = h("div", { class: "strip" });
    const show = (i) => {
      cur = i;
      main.src = urls[i];
      const im = images[i];
      info.textContent = `${t("Foto {a} di {b}", { a: i + 1, b: images.length })}${im.width ? ` · ${im.width}×${im.height}` : ""} · ${fmtBytes(im.size)}${im.reduced ? ` · ${t("risoluzione ridotta")}` : ""}`;
      for (const b of strip.children) b.classList.toggle("on", Number(b.dataset.i) === i);
    };
    images.forEach((im, i) => {
      strip.append(urls[i]
        ? h("button", { type: "button", dataset: { i }, "aria-label": t("Foto {n}", { n: i + 1 }), onClick: () => show(i) }, h("img", { src: urls[i], alt: "" }))
        : h("div", { class: "missing", title: im.error || "" }, t("Foto {n} mancante", { n: i + 1 })));
    });
    const gallery = h("div", { class: "gallery" }, cur >= 0 ? h("button", { class: "main-wrap", type: "button", "aria-label": t("Ingrandisci la foto"), onClick: () => lightbox(okIdx.map((i) => urls[i]), okIdx.indexOf(cur)) }, main) : h("div", { class: "empty" }, t("Nessuna foto disponibile")), info, strip);
    if (cur >= 0) show(cur);

    const similar = findSimilar(l, S.listings);
    const url = safeUrl(l.url);
    const isMine = l.owner === "mine";
    const act = (label, ic, fn, cls = "") => h("button", { class: `btn sm ${cls}`, type: "button", onClick: fn }, ic ? icon(ic, 15) : null, label);
    const actions = h("div", { class: "row actions" },
      url ? h("a", { class: "btn sm", href: url, target: "_blank", rel: "noopener" }, icon("external", 15), t("Apri su Vinted")) : null,
      isMine ? act(t("Prepara"), "edit", () => prepare(l, refresh), "primary") : null,
      act(t("Aggiorna da Vinted"), "refresh", () => updateFromVinted(l, refresh)),
      act(t("Controlla link"), "link", async () => { await checkLinks([l]); refresh(); }),
      act(l.favorite ? t("Togli dai preferiti") : t("Preferito"), l.favorite ? "star-full" : "star", async () => { await archive.patchMany([l.id], (x) => { x.favorite = !x.favorite; }); await changed(); refresh(); }),
      act(t("Collezioni…"), "folder", async () => { if (await pickCollections([l.id])) { await changed(); refresh(); } }),
      act(t("Foto (ZIP)"), "download", () => photosZip([l])),
      isMine ? act(t("Per Vinted_Relist"), "upload", () => exportForRelist([l])) : null,
      h("select", { class: "input", style: { width: "auto", minHeight: "30px", padding: "3px 8px" }, "aria-label": t("Copia"), onChange: (e) => {
        const k = e.target.value; e.target.value = "";
        if (k === "title") copyText(l.title); else if (k === "description") copyText(l.description || ""); else if (k === "all") copyText(fullText(l)); else if (k === "url" && url) copyText(url);
      } }, h("option", { value: "" }, t("Copia…")), h("option", { value: "title" }, t("Titolo")), h("option", { value: "description" }, t("Descrizione")), h("option", { value: "all" }, t("Tutto")), url ? h("option", { value: "url" }, t("Link")) : null),
      l.deletedAt
        ? act(t("Ripristina dal cestino"), null, async () => { await archive.untrash([l.id]); await changed(); refresh(); })
        : act(t("Sposta nel cestino"), "trash", async () => { await archive.trash([l.id]); await changed(); toast(t("Spostato nel cestino: lo ritrovi lì per 30 giorni.")); m.close(); }, "danger"));

    const tabs = [["info", "Scheda"], ["edit", "Modifica"], ["notes", "Note e campi"], ["versions", "Versioni"], ["raw", "Dati tecnici"]];
    const panel = h("div", { class: "tab-panel", role: "tabpanel" });
    const tabBar = h("div", { class: "tabs", role: "tablist" }, tabs.map(([k, label]) => h("button", { type: "button", role: "tab", "aria-selected": String(tab === k), class: tab === k ? "on" : "", dataset: { tab: k }, onClick: () => { tab = k; draw(); } }, t(label))));

    const dl = (pairs) => h("dl", { class: "props" }, pairs.filter(([, v]) => v != null && v !== "").map(([k, v]) => [h("dt", null, t(k)), h("dd", null, v)]));
    if (tab === "info") {
      const colls = (l.collectionIds || []).map((cid) => S.collections.find((c) => c.id === cid)).filter(Boolean);
      panel.append(
        h("div", { class: "price" }, fmtPrice(l.price, l.currency)),
        h("div", { class: "row badges" }, h("span", { class: `chip ${isMine ? "primary" : ""}` }, isMine ? t("Mio annuncio") : t("Non mio")), h("span", { class: `chip ${l.online === "online" ? "good" : ""}` }, t(ONLINE_LABEL[l.online] || "Non verificato")), badges(l).filter((b) => !/online|Venduto/.test(b.textContent)), colls.map((c) => h("span", { class: "chip" }, c.name))),
        l.remoteChanged ? h("div", { class: "note warn" }, t("Su Vinted questo annuncio è cambiato dopo il salvataggio."), " ", h("a", { href: "#", onClick: (e) => { e.preventDefault(); updateFromVinted(l, refresh); } }, t("Rivedi le differenze"))) : null,
        similar.length ? h("div", { class: "note" }, t("Somiglia a {n} annunci già in archivio (stessa foto o stesso titolo):", { n: similar.length }), " ", similar.slice(0, 4).map((s, i) => [i ? ", " : "", h("a", { href: "#", onClick: (e) => { e.preventDefault(); m.close(); openDetail(s.id); } }, S.byId.get(s.id)?.title || s.id)])) : null,
        h("div", { class: "desc" }, l.description || h("span", { class: "muted" }, t("Nessuna descrizione"))),
        dl([["Marca", l.brand], ["Categoria", l.category || (l.ids?.catalogId ? t("n. {id} (nome da completare: Salute › «Completa i dati mancanti»)", { id: l.ids.catalogId }) : null)], ["Taglia", l.size], ["Colore", (l.colors || []).join(", ")], ["Condizioni", l.condition],
          ["Autore", l.extra?.author], ["Titolo del libro", l.extra?.bookTitle], ["ISBN", l.extra?.isbn], ["Produttore", l.extra?.manufacturer], ["Modello", l.extra?.model], ["Misure", l.extra?.measures],
          ["Venditore", l.sellerLogin || (isMine ? t("Tu") : null)], ["ID Vinted", l.vintedId], ["Pubblicato", l.publishedAt ? fmtDate(l.publishedAt) : null], ["Salvato", fmtDate(l.savedAt, true)],
          ["Ultimo confronto con Vinted", fmtDate(l.onlineCheckedAt, true)], ["Foto", `${l.photoCount}${l.photoMissing ? ` (${t("{n} mancanti", { n: l.photoMissing })})` : ""}`],
          ...Object.entries(l.custom || {}).filter(([, v]) => v), l.notes ? ["Note", l.notes] : [null, null]]));
    } else if (tab === "edit") {
      const f = {
        title: h("input", { class: "input", value: l.title, maxlength: "300", name: "title" }),
        description: h("textarea", { class: "input", rows: "8", name: "description" }),
        price: h("input", { class: "input", type: "number", min: "0", step: "0.5", value: l.price ?? "", name: "price" }),
        brand: h("input", { class: "input", value: l.brand || "", name: "brand" }), category: h("input", { class: "input", value: l.category || "", name: "category" }),
        size: h("input", { class: "input", value: l.size || "", name: "size" }), colors: h("input", { class: "input", value: (l.colors || []).join(", "), name: "colors" }),
        condition: h("input", { class: "input", value: l.condition || "", name: "condition" }),
      };
      f.description.value = l.description || "";
      panel.append(h("form", { class: "stack", onSubmit: async (e) => {
        e.preventDefault();
        await archive.editListing(l.id, { title: f.title.value.trim(), description: f.description.value, price: num(f.price.value), brand: f.brand.value.trim() || null, category: f.category.value.trim() || null, size: f.size.value.trim() || null, colors: f.colors.value.split(",").map((x) => x.trim()).filter(Boolean), condition: f.condition.value.trim() || null });
        await changed();
        toast(t("Copia archiviata aggiornata. L'annuncio su Vinted non viene toccato."), "good");
        tab = "info";
        refresh();
      } },
      h("div", { class: "note" }, t("Modifichi solo la copia in Vintory: l'annuncio su Vinted resta com'è, e i dati originali restano recuperabili da «Versioni».")),
      h("label", { class: "field" }, t("Titolo"), f.title), h("label", { class: "field" }, t("Descrizione"), f.description),
      h("div", { class: "form-grid" }, h("label", { class: "field" }, t("Prezzo"), f.price), h("label", { class: "field" }, t("Marca"), f.brand), h("label", { class: "field" }, t("Taglia"), f.size), h("label", { class: "field" }, t("Condizioni"), f.condition), h("label", { class: "field" }, t("Colore (separati da virgola)"), f.colors), h("label", { class: "field" }, t("Categoria"), f.category)),
      h("div", { class: "row" }, h("button", { class: "btn primary", type: "submit" }, t("Salva modifiche")))));
    } else if (tab === "notes") {
      const notes = h("textarea", { class: "input", rows: "5", name: "notes", placeholder: t("Dove si trova il capo, prezzo minimo che accetti, a chi l'hai promesso…") });
      notes.value = l.notes || "";
      const names = [...new Set([...S.settings.customFields, ...Object.keys(l.custom || {})])];
      const inputs = names.map((n) => [n, h("input", { class: "input", value: l.custom?.[n] || "", dataset: { custom: n } })]);
      panel.append(h("form", { class: "stack", onSubmit: async (e) => {
        e.preventDefault();
        await archive.editListing(l.id, { notes: notes.value, custom: Object.fromEntries(inputs.map(([n, el]) => [n, el.value.trim()]).filter(([, v]) => v)) });
        await changed();
        toast(t("Note salvate."), "good");
        refresh();
      } },
      h("label", { class: "field" }, t("Note private"), notes),
      h("div", { class: "form-grid" }, inputs.map(([n, el]) => h("label", { class: "field" }, n, el))),
      h("div", { class: "small muted" }, t("I nomi dei campi personalizzati si gestiscono in "), h("a", { href: "#settings", onClick: () => m.close() }, t("Impostazioni"))),
      h("div", { class: "row" }, h("button", { class: "btn primary", type: "submit" }, t("Salva note e campi")))));
    } else if (tab === "versions") {
      const versions = await archive.listVersions(l.id);
      panel.append(h("div", { class: "row between" }, h("p", { class: "muted" }, t("Ogni modifica o aggiornamento salva qui com'era la scheda prima (ultime 30).")),
        h("button", { class: "btn sm", type: "button", disabled: !l.edited && !versions.length, onClick: async () => {
          if (!(await confirmDialog(t("Tornare ai dati originali?"), t("La scheda torna com'era al primo salvataggio da Vinted. La versione di adesso resta in elenco.")))) return;
          try { await archive.restoreOriginal(l.id); await changed(); toast(t("Dati originali ripristinati."), "good"); refresh(); } catch (e) { toast(e.message, "bad"); }
        } }, t("Ripristina i dati originali"))));
      if (!versions.length) panel.append(h("div", { class: "empty" }, t("Nessuna versione precedente: la scheda non è mai stata modificata.")));
      else panel.append(h("div", { class: "table-wrap" }, h("table", { class: "table" }, h("thead", null, h("tr", null, h("th", null, t("Quando")), h("th", null, t("Motivo")), h("th", null, t("Diverso da adesso")), h("th", null, ""))),
        h("tbody", null, versions.map((v) => {
          const diff = Object.keys(v.data).filter((k) => FIELD_LABELS[k] && JSON.stringify(v.data[k] ?? null) !== JSON.stringify(l[k] ?? null)).map((k) => t(FIELD_LABELS[k]));
          if (JSON.stringify(v.imageIds || []) !== JSON.stringify(l.imageIds || [])) diff.push(t("Foto"));
          return h("tr", null, h("td", null, fmtDate(v.at, true)), h("td", null, t(REASONS[v.reason] || v.reason)), h("td", null, diff.join(", ") || t("uguale")),
            h("td", null, h("button", { class: "btn sm", type: "button", onClick: async () => { try { await archive.restoreVersion(l.id, v.id); await changed(); toast(t("Versione ripristinata."), "good"); tab = "info"; refresh(); } catch (e) { toast(e.message, "bad"); } } }, t("Ripristina"))));
        })))));
    } else if (tab === "raw") {
      const raw = await archive.getRaw(l.id);
      const json = JSON.stringify(raw?.bundle ?? null, null, 2);
      panel.append(h("p", { class: "muted" }, t("I dati così come Vinted li ha forniti al salvataggio, conservati per recuperare fedelmente l'annuncio.")),
        dl([["Fonti lette", (l.sources || []).map((s) => ({ upload: t("modulo di vendita"), details: t("scheda"), wardrobe: t("elenco armadio"), page: t("pagina") }[s] || s)).join(", ")], ["Letti il", raw ? fmtDate(raw.capturedAt, true) : null], ["Ultimo aggiornamento", raw?.latest ? fmtDate(raw.latest.capturedAt, true) : null], ["ID categoria", l.ids?.catalogId], ["ID marca", l.ids?.brandId], ["ID taglia", l.ids?.sizeId], ["ID condizioni", l.ids?.statusId]]),
        h("div", { class: "row" }, h("button", { class: "btn sm", type: "button", onClick: () => copyText(json) }, icon("copy", 15), t("Copia JSON")), h("button", { class: "btn sm", type: "button", onClick: () => saveBlob(new Blob([json], { type: "application/json" }), `${l.vintedId}-dati-originali.json`) }, icon("download", 15), t("Scarica JSON"))),
        h("pre", { class: "raw", tabindex: "0" }, json.length > 60000 ? `${json.slice(0, 60000)}\n… (${t("troncato: scarica il JSON per vederlo tutto")})` : json));
    }
    clear(body).append(gallery, h("div", { class: "dside" }, actions, tabBar, panel));
  }

  await draw();
  if (update) updateFromVinted(l, refresh);
  return m;
}

