/** Elenco degli annunci: ricerca, filtri, ordinamento, griglia/lista, selezione multipla, azioni di gruppo. */
import { h, t, clear, icon, toast, confirmDialog, promptDialog, saveBlob, thumbImg, progressDialog, rpc } from "../lib.js";
import { S, live, mine, others, trashed, changed, setSettings, go } from "../state.js";
import * as archive from "../../shared/archive.js";
import * as db from "../../shared/db.js";
import { EMPTY_FILTER, filterListings, sortListings, facets, toRows, toCsv, trashDaysLeft } from "../../shared/model.js";
import { buildXlsx, ZipWriter } from "../../shared/zip.js";
import { exportArchive } from "../../shared/backup.js";
import { fmtPrice, fmtDate, debounce, uid, dayStamp, safeName, extOf, sleep } from "../../shared/util.js";
import { openDetail } from "./detail.js";
import { pickCollections } from "./more.js";
import { fillNote } from "../fill.js";
import { exportForRelist } from "../relist-export.js";

const PAGE = 60;
const views = new Map();      // stato per sezione: filtri, selezione, pannello aperto
const SORTS = [["savedAt:desc", "Salvati di recente"], ["savedAt:asc", "Salvati da più tempo"], ["publishedAt:desc", "Pubblicati di recente"], ["price:asc", "Prezzo crescente"], ["price:desc", "Prezzo decrescente"], ["title:asc", "Titolo A–Z"], ["title:desc", "Titolo Z–A"]];

const SCOPES = {
  archive: { title: "Il mio archivio", base: mine, empty: "Nessun annuncio salvato. Apri un tuo annuncio su Vinted e premi «Salva in Vintory», oppure importa dal tuo armadio." },
  others: { title: "Annunci non miei", base: others, empty: "Qui finiscono gli annunci di altri utenti che decidi di salvare. Restano separati dal tuo archivio e fuori da valore e statistiche." },
  recent: { title: "Aggiunti di recente", base: () => [...live()].sort((a, b) => b.savedAt - a.savedAt).slice(0, 60), empty: "Ancora nessun annuncio salvato.", fixedSort: true },
  favorites: { title: "Preferiti", base: () => live().filter((l) => l.favorite), empty: "Nessun preferito: usa la stella su un annuncio." },
  collection: { title: "Collezione", base: (arg) => live().filter((l) => (l.collectionIds || []).includes(arg)), empty: "Collezione vuota: seleziona degli annunci e usa «Collezioni»." },
  trash: { title: "Cestino", base: trashed, empty: "Il cestino è vuoto." },
};

function viewOf(key) {
  if (!views.has(key)) views.set(key, { filter: structuredClone(EMPTY_FILTER), selection: new Set(), panel: false, shown: PAGE });
  return views.get(key);
}
const activeFilters = (f) => ["brand", "category", "size", "color", "condition"].reduce((n, k) => n + (f[k]?.length ? 1 : 0), 0) + (f.priceMin || f.priceMax ? 1 : 0) + (f.favorite ? 1 : 0) + (f.online ? 1 : 0) + (f.seller ? 1 : 0);

export const ONLINE_LABEL = { online: "Online", offline: "Non più online", sold: "Venduto", unknown: "Non verificato" };

export function badges(l) {
  const out = [];
  if (l.online === "offline") out.push(h("span", { class: "chip bad" }, t("Non più online")));
  if (l.online === "sold") out.push(h("span", { class: "chip warn" }, t("Venduto")));
  if (l.remoteChanged) out.push(h("span", { class: "chip warn" }, t("Modificato su Vinted")));
  if (l.photoMissing) out.push(h("span", { class: "chip bad" }, t("{n} foto mancanti", { n: l.photoMissing })));
  if (l.edited) out.push(h("span", { class: "chip" }, t("Modificato da te")));
  return out;
}

// ---------------------------------------------------------------- azioni di gruppo

export async function exportTable(list, kind) {
  if (!list.length) { toast(t("Nessun annuncio da esportare.")); return; }
  const rows = toRows(list, S.settings.customFields);
  if (kind === "xlsx") saveBlob(await buildXlsx(rows, "Annunci"), `Vintory-annunci-${dayStamp()}.xlsx`);
  else saveBlob(new Blob([toCsv(rows)], { type: "text/csv;charset=utf-8" }), `Vintory-annunci-${dayStamp()}.csv`);
  toast(t("Esportati {n} annunci.", { n: list.length }), "good");
}

/** ZIP con le foto originali: una cartella per annuncio. */
export async function photosZip(list) {
  const p = progressDialog(t("Preparo le foto"), "");
  try {
    const zip = new ZipWriter();
    let n = 0;
    for (let i = 0; i < list.length; i++) {
      const l = list[i];
      const folder = list.length > 1 ? `${safeName(l.title, 40)}-${l.vintedId}/` : "";
      const images = await archive.getImages(l);
      images.forEach((img, k) => { img._name = `${folder}${String(k + 1).padStart(2, "0")}.${extOf(img.type)}`; });
      for (const img of images) if (img.blob) { await zip.add(img._name, img.blob); n++; }
      p.set(i + 1, list.length, l.title);
    }
    if (!n) { toast(t("Nessuna foto disponibile da scaricare."), "bad"); return; }
    saveBlob(zip.finish(), list.length === 1 ? `${safeName(list[0].title, 40)}-${list[0].vintedId}-foto.zip` : `Vintory-foto-${dayStamp()}.zip`);
  } catch (e) { toast(e.message, "bad"); } finally { p.close(); }
}

/** Controllo «il link funziona ancora?» (F43): manuale, con una pausa tra un annuncio e l'altro. */
export async function checkLinks(list) {
  const p = progressDialog(t("Controllo i link su Vinted"), "");
  const out = { online: 0, offline: 0, sold: 0, unknown: 0 };
  let stopped = null;
  try {
    for (let i = 0; i < list.length; i++) {
      p.set(i, list.length, list[i].title);
      const r = await rpc("vinted.check", { listingId: list[i].id });
      if (!r.ok) { if (r.stop) { stopped = r.message; break; } out.unknown++; } else out[r.online]++;
      if (i < list.length - 1) await sleep(1200 + Math.random() * 800);
    }
  } catch (e) { stopped = e.message; } finally { p.close(); }
  await changed();
  if (stopped) toast(stopped, "bad");
  else toast(t("Online: {a} · Non più online: {b} · Venduti: {c}{d}", { a: out.online, b: out.offline, c: out.sold, d: out.unknown ? ` · ${t("Non verificati")}: ${out.unknown}` : "" }), out.offline ? "" : "good", 7000);
}

async function saveFilter(v) {
  const name = await promptDialog(t("Salva filtro"), t("Nome del filtro"), "", { okLabel: t("Salva") });
  if (!name) return;
  await db.put("filters", { id: uid("f_"), name, filter: structuredClone(v.filter), createdAt: Date.now() });
  toast(t("Filtro salvato."), "good");
}

// ---------------------------------------------------------------- disegno

export async function renderList(main, scopeName, arg) {
  const scope = SCOPES[scopeName];
  const key = scopeName + (arg || "");
  const v = viewOf(key);
  const isTrash = scopeName === "trash";
  const base = scope.base(arg);
  const coll = scopeName === "collection" ? S.collections.find((c) => c.id === arg) : null;
  const savedFilters = await db.getAll("filters");
  let results = [];

  const count = h("span", { class: "muted" });
  const resultsBox = h("div", { id: "results" });
  const selBar = h("div", { class: "selbar hidden", role: "region", "aria-label": t("Azioni sulla selezione") });
  const panelBox = h("div");
  const sentinel = h("div", { class: "sentinel" });

  const search = h("input", { class: "input", type: "search", placeholder: t("Cerca per titolo, descrizione, marca…"), value: v.filter.q, "aria-label": t("Cerca"), id: "search" });
  search.addEventListener("input", debounce(() => { v.filter.q = search.value; v.shown = PAGE; draw(); }, 350));

  const sortSel = h("select", { class: "input", "aria-label": t("Ordina per"), style: { width: "auto" }, disabled: Boolean(scope.fixedSort), onChange: async (e) => { await setSettings({ sort: e.target.value }); draw(); } },
    SORTS.map(([val, label]) => h("option", { value: val, selected: S.settings.sort === val }, t(label))));
  const viewBtn = (mode, ic, label) => h("button", { class: `btn sm${S.settings.view === mode ? " on" : ""}`, type: "button", "aria-label": label, "aria-pressed": String(S.settings.view === mode), title: label, dataset: { view: mode }, onClick: async () => { await setSettings({ view: mode }); renderList(main, scopeName, arg); } }, icon(ic));
  const filterBtn = h("button", { class: "btn", type: "button", id: "filters-toggle", "aria-expanded": String(v.panel), onClick: () => { v.panel = !v.panel; filterBtn.setAttribute("aria-expanded", String(v.panel)); drawPanel(); } }, icon("filter"), t("Filtri"));
  const savedSel = savedFilters.length ? h("select", { class: "input", style: { width: "auto" }, "aria-label": t("Filtri salvati"), onChange: (e) => {
    const f = savedFilters.find((x) => x.id === e.target.value);
    if (!f) return;
    v.filter = { ...structuredClone(EMPTY_FILTER), ...structuredClone(f.filter) };
    search.value = v.filter.q || "";
    v.panel = true; v.shown = PAGE;
    drawPanel(); draw();
  } }, h("option", { value: "" }, t("Filtri salvati…")), savedFilters.map((f) => h("option", { value: f.id }, f.name))) : null;
  const exportSel = h("select", { class: "input", style: { width: "auto" }, "aria-label": t("Esporta"), onChange: async (e) => {
    const kind = e.target.value;
    e.target.value = "";
    if (kind) await exportTable(results, kind);
  } }, h("option", { value: "" }, t("Esporta elenco…")), h("option", { value: "csv" }, "CSV"), h("option", { value: "xlsx" }, "Excel (.xlsx)"));

  const headActions = [];
  if (scopeName === "archive") headActions.push(h("button", { class: "btn", type: "button", id: "check-open", onClick: () => go("check?run=1") }, icon("refresh"), t("Controlla il mio armadio")));
  if (scopeName === "archive" || scopeName === "others") headActions.push(h("button", { class: "btn primary", type: "button", onClick: () => go("import") }, icon("download"), t("Importa da un armadio")));
  if (isTrash && base.length) headActions.push(h("button", { class: "btn danger", type: "button", onClick: async () => {
    if (!(await confirmDialog(t("Svuotare il cestino?"), t("{n} annunci verranno eliminati per sempre, con le loro foto. Non si può annullare.", { n: base.length }), { okLabel: t("Elimina per sempre"), danger: true }))) return;
    await archive.purge(base.map((l) => l.id));
    v.selection.clear();
    await changed();
  } }, t("Svuota cestino")));
  if (coll) headActions.push(h("button", { class: "btn", type: "button", onClick: () => go("collections") }, icon("left"), t("Tutte le collezioni")));

  clear(main).append(
    h("div", { class: "page-head" }, h("div", null, h("h1", null, coll ? coll.name : t(scope.title)), count), h("div", { class: "row" }, headActions)),
    isTrash ? h("div", { class: "note" }, t("Gli annunci nel cestino vengono eliminati definitivamente dopo 30 giorni.")) : null,
    scopeName === "archive" || scopeName === "others" ? fillNote(() => go(scopeName)) : null,
    scopeName === "others" ? h("div", { class: "note" }, t("Annunci di altri utenti: consultazione, note, foto e backup. «Prepara» e l'esportazione per Vinted_Relist sono riservati ai tuoi annunci.")) : null,
    h("div", { class: "toolbar" }, h("div", { class: "grow search" }, search), sortSel, filterBtn, savedSel, isTrash ? null : exportSel, h("div", { class: "row", role: "group", "aria-label": t("Vista") }, viewBtn("grid", "grid", t("Griglia")), viewBtn("list", "list", t("Lista")))),
    panelBox, selBar, resultsBox, sentinel);

  function drawPanel() {
    clear(panelBox);
    const n = activeFilters(v.filter);
    clear(filterBtn).append(icon("filter"), t("Filtri"), n ? h("span", { class: "chip primary" }, n) : null);
    if (!v.panel) return;
    const fc = facets(base);
    const group = (field, label, values) => {
      if (!values.length) return null;
      const box = h("div", { class: "facet" });
      for (const { value, count: c } of values.slice(0, 80)) {
        box.append(h("label", { class: "check" }, h("input", { type: "checkbox", checked: v.filter[field].includes(value), onChange: (e) => {
          v.filter[field] = e.target.checked ? [...v.filter[field], value] : v.filter[field].filter((x) => x !== value);
          v.shown = PAGE; draw(); drawPanel();
        } }), h("span", { class: "grow" }, value), h("span", { class: "muted small" }, c)));
      }
      return h("fieldset", { class: "facet-group" }, h("legend", null, t(label), v.filter[field].length ? ` (${v.filter[field].length})` : ""), box);
    };
    const priceIn = (k, ph) => h("input", { class: "input", type: "number", min: "0", step: "0.5", placeholder: ph, value: v.filter[k] ?? "", "aria-label": ph, onInput: debounce((e) => { v.filter[k] = e.target.value === "" ? null : Number(e.target.value); v.shown = PAGE; draw(); }, 350) });
    panelBox.append(h("section", { class: "card filters", "aria-label": t("Filtri") },
      h("div", { class: "facets" },
        group("brand", "Marca", fc.brand), group("category", "Categoria", fc.category), group("size", "Taglia", fc.size), group("color", "Colore", fc.color), group("condition", "Condizioni", fc.condition),
        h("fieldset", { class: "facet-group" }, h("legend", null, t("Altro")),
          h("div", { class: "stack" },
            h("div", { class: "row" }, priceIn("priceMin", t("Prezzo min")), priceIn("priceMax", t("Prezzo max"))),
            h("label", { class: "check" }, h("input", { type: "checkbox", checked: v.filter.favorite, onChange: (e) => { v.filter.favorite = e.target.checked; draw(); } }), t("Solo preferiti")),
            h("select", { class: "input", "aria-label": t("Stato del link"), onChange: (e) => { v.filter.online = e.target.value || null; draw(); } }, h("option", { value: "" }, t("Qualsiasi stato del link")), Object.entries(ONLINE_LABEL).map(([k, lab]) => h("option", { value: k, selected: v.filter.online === k }, t(lab)))),
            fc.seller.length > 1 || scopeName === "others" ? h("select", { class: "input", "aria-label": t("Venditore"), onChange: (e) => { v.filter.seller = e.target.value || null; draw(); } }, h("option", { value: "" }, t("Tutti i venditori")), fc.seller.map((s) => h("option", { value: s.value, selected: v.filter.seller === s.value }, `${s.label} (${s.count})`))) : null))),
      h("div", { class: "row" },
        h("button", { class: "btn sm", type: "button", onClick: () => { v.filter = structuredClone(EMPTY_FILTER); search.value = ""; v.shown = PAGE; draw(); drawPanel(); } }, t("Azzera filtri")),
        h("button", { class: "btn sm", type: "button", disabled: !n && !v.filter.q, onClick: async () => { await saveFilter(v); renderList(main, scopeName, arg); } }, t("Salva questo filtro…")),
        savedFilters.length ? h("button", { class: "btn sm ghost", type: "button", onClick: async () => {
          const name = await promptDialog(t("Elimina un filtro salvato"), t("Scrivi il nome del filtro da eliminare"), savedFilters[0].name, { okLabel: t("Elimina") });
          const f = savedFilters.find((x) => x.name === name);
          if (f) { await db.del("filters", f.id); renderList(main, scopeName, arg); }
        } }, t("Elimina un filtro salvato…")) : null)));
  }

  function drawSelection() {
    const ids = [...v.selection].filter((id) => S.byId.has(id));
    v.selection = new Set(ids);
    clear(selBar);
    selBar.classList.toggle("hidden", !ids.length);
    if (!ids.length) return;
    const list = ids.map((id) => S.byId.get(id));
    const act = (label, fn, cls = "") => h("button", { class: `btn sm ${cls}`, type: "button", onClick: fn }, label);
    selBar.append(h("strong", null, t("{n} selezionati", { n: ids.length })),
      act(t("Seleziona tutti ({n})", { n: results.length }), () => { for (const l of results) v.selection.add(l.id); draw(); }),
      act(t("Deseleziona"), () => { v.selection.clear(); draw(); }));
    if (isTrash) {
      selBar.append(act(t("Ripristina"), async () => { await archive.untrash(ids); v.selection.clear(); await changed(); toast(t("Ripristinati."), "good"); }),
        act(t("Elimina per sempre"), async () => {
          if (!(await confirmDialog(t("Eliminare per sempre?"), t("{n} annunci e le loro foto verranno eliminati definitivamente.", { n: ids.length }), { okLabel: t("Elimina per sempre"), danger: true }))) return;
          await archive.purge(ids); v.selection.clear(); await changed();
        }, "danger"));
      return;
    }
    const allFav = list.every((l) => l.favorite);
    selBar.append(
      act(allFav ? t("Togli dai preferiti") : t("Aggiungi ai preferiti"), async () => { await archive.patchMany(ids, (l) => { l.favorite = !allFav; }); await changed(); }),
      act(t("Collezioni…"), async () => { if (await pickCollections(ids)) await changed(); }),
      act(t("Controlla link"), () => checkLinks(list)),
      act(t("Foto (ZIP)"), () => photosZip(list)),
      list.some((l) => l.owner === "mine") ? act(t("Per Vinted_Relist"), () => exportForRelist(list)) : null,
      act("CSV", () => exportTable(list, "csv")),
      act("Excel", () => exportTable(list, "xlsx")),
      act(t("Backup della selezione"), async () => {
        const p = progressDialog(t("Creo il backup"), "");
        try { const r = await exportArchive({ ids, settings: S.settings, onProgress: ({ done, total }) => p.set(done, total) }); saveBlob(r.blob, r.name.replace("backup", "selezione")); } catch (e) { toast(e.message, "bad"); } finally { p.close(); }
      }),
      act(t("Sposta nel cestino"), async () => { await archive.trash(ids); v.selection.clear(); await changed(); toast(t("Spostati nel cestino: li ritrovi lì per 30 giorni.")); }, "danger"));
  }

  const toggleSel = (id, on) => { if (on) v.selection.add(id); else v.selection.delete(id); drawSelection(); };
  const favBtn = (l) => h("button", { class: `fav${l.favorite ? " on" : ""}`, type: "button", "aria-label": l.favorite ? t("Togli dai preferiti") : t("Aggiungi ai preferiti"), "aria-pressed": String(Boolean(l.favorite)), onClick: async (e) => {
    e.stopPropagation();
    await archive.patchMany([l.id], (x) => { x.favorite = !x.favorite; });
    await changed();
  } }, icon(l.favorite ? "star-full" : "star", 16));

  function card(l) {
    const sub = [l.brand, l.size].filter(Boolean).join(" · ");
    return h("article", { class: `item${v.selection.has(l.id) ? " sel" : ""}`, dataset: { id: l.id } },
      h("label", { class: "pick" }, h("input", { type: "checkbox", checked: v.selection.has(l.id), "aria-label": t("Seleziona {t}", { t: l.title }), onChange: (e) => { e.target.closest(".item").classList.toggle("sel", e.target.checked); toggleSel(l.id, e.target.checked); } })),
      isTrash ? null : favBtn(l),
      h("button", { class: "thumb", type: "button", "aria-label": t("Apri {t}", { t: l.title }), onClick: () => openDetail(l.id) }, thumbImg(l.coverImageId, ""), l.photoCount > 1 ? h("span", { class: "count" }, l.photoCount) : null),
      h("div", { class: "meta" },
        h("div", { class: "t", title: l.title }, l.title || t("Senza titolo")),
        h("div", { class: "row between" }, h("strong", null, fmtPrice(l.price, l.currency)), h("span", { class: "muted small ell" }, sub)),
        h("div", { class: "row badges" }, isTrash ? h("span", { class: "chip" }, t("Eliminato tra {n} giorni", { n: trashDaysLeft(l.deletedAt) })) : badges(l), l.owner !== "mine" && scopeName !== "others" ? h("span", { class: "chip" }, t("Non mio")) : null)));
  }

  function rowOf(l) {
    return h("tr", { dataset: { id: l.id }, class: v.selection.has(l.id) ? "sel" : "" },
      h("td", null, h("input", { type: "checkbox", checked: v.selection.has(l.id), "aria-label": t("Seleziona {t}", { t: l.title }), onChange: (e) => toggleSel(l.id, e.target.checked) })),
      h("td", null, h("button", { class: "mini", type: "button", "aria-label": t("Apri {t}", { t: l.title }), onClick: () => openDetail(l.id) }, thumbImg(l.coverImageId, ""))),
      h("td", null, h("a", { href: "#", class: "t", onClick: (e) => { e.preventDefault(); openDetail(l.id); } }, l.title || t("Senza titolo")), h("div", { class: "row badges" }, badges(l))),
      h("td", null, l.brand || "—"), h("td", null, l.size || "—"), h("td", { class: "num" }, fmtPrice(l.price, l.currency)),
      h("td", null, scopeName === "others" ? (l.sellerLogin || "—") : fmtDate(l.savedAt)),
      h("td", null, isTrash ? t("{n} giorni", { n: trashDaysLeft(l.deletedAt) }) : favBtn(l)));
  }

  let observer = null;
  function draw() {
    results = filterListings(base, v.filter);
    if (!scope.fixedSort) results = sortListings(results, S.settings.sort);
    count.textContent = results.length === base.length ? t("{n} annunci", { n: base.length }) : t("{a} di {b} annunci", { a: results.length, b: base.length });
    clear(resultsBox);
    observer?.disconnect();
    if (!base.length) { resultsBox.append(h("div", { class: "empty" }, h("p", null, coll ? t("Collezione vuota: seleziona degli annunci e usa «Collezioni…».") : t(scope.empty)))); drawSelection(); return; }
    if (!results.length) { resultsBox.append(h("div", { class: "empty" }, h("p", null, t("Nessun annuncio corrisponde alla ricerca o ai filtri.")))); drawSelection(); return; }
    const slice = results.slice(0, v.shown);
    if (S.settings.view === "list") {
      resultsBox.append(h("div", { class: "card table-wrap" }, h("table", { class: "table items" },
        h("thead", null, h("tr", null, h("th", null, ""), h("th", null, ""), h("th", null, t("Titolo")), h("th", null, t("Marca")), h("th", null, t("Taglia")), h("th", { class: "num" }, t("Prezzo")), h("th", null, scopeName === "others" ? t("Venditore") : t("Salvato")), h("th", null, ""))),
        h("tbody", null, slice.map(rowOf)))));
    } else resultsBox.append(h("div", { class: "grid" }, slice.map(card)));
    if (results.length > v.shown) {
      observer = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) { v.shown += PAGE; draw(); } }, { rootMargin: "600px" });
      observer.observe(sentinel);
    }
    drawSelection();
  }

  drawPanel();
  draw();
}
