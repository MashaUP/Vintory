/** Collezioni, modelli di descrizione, statistiche, annunci simili. */
import { h, t, clear, icon, toast, modal, confirmDialog, promptDialog, thumbImg } from "../lib.js";
import { S, live, mine, others, changed, go, rerender } from "../state.js";
import * as archive from "../../shared/archive.js";
import * as db from "../../shared/db.js";
import { stats, similarGroups, applyTemplate } from "../../shared/model.js";
import { fmtPrice, uid } from "../../shared/util.js";

// ---------------------------------------------------------------- collezioni (F31)

/** Finestra per mettere o togliere degli annunci dalle collezioni. Restituisce true se qualcosa è cambiato. */
export function pickCollections(ids) {
  return new Promise((resolve) => {
    const listings = ids.map((id) => S.byId.get(id)).filter(Boolean);
    const state = new Map(S.collections.map((c) => [c.id, listings.every((l) => (l.collectionIds || []).includes(c.id))]));
    const initial = new Map(state);
    const box = h("div", { class: "stack" });
    const name = h("input", { class: "input", placeholder: t("Nome della nuova collezione"), "aria-label": t("Nuova collezione") });
    let done = false;
    const drawList = () => {
      clear(box);
      if (!S.collections.length) box.append(h("p", { class: "muted" }, t("Ancora nessuna collezione: creane una qui sotto.")));
      for (const c of S.collections) box.append(h("label", { class: "check" }, h("input", { type: "checkbox", checked: state.get(c.id) || false, onChange: (e) => state.set(c.id, e.target.checked) }), c.name));
    };
    const add = async () => {
      const n = name.value.trim();
      if (!n) return;
      const c = { id: uid("c_"), name: n.slice(0, 60), createdAt: Date.now() };
      await db.put("collections", c);
      S.collections.push(c);
      state.set(c.id, true);
      name.value = "";
      drawList();
    };
    name.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); add(); } });
    drawList();
    modal({
      title: t("Collezioni"), onClose: () => resolve(done),
      body: h("div", { class: "stack" }, h("p", { class: "muted" }, t("{n} annunci selezionati", { n: listings.length })), box, h("div", { class: "row" }, h("div", { class: "grow" }, name), h("button", { class: "btn", type: "button", onClick: add }, icon("plus", 15), t("Crea")))),
      actions: [{ label: t("Annulla"), onClick: (c) => c() }, { id: "ok", label: t("Applica"), kind: "primary", onClick: async (c) => {
        await add();
        const changes = [...state].filter(([cid, on]) => on !== (initial.get(cid) || false));
        if (changes.length) {
          await archive.patchMany(ids, (l) => {
            const set = new Set(l.collectionIds || []);
            for (const [cid, on] of changes) { if (on) set.add(cid); else set.delete(cid); }
            l.collectionIds = [...set];
          });
          done = true;
        }
        c();
      } }],
    });
  });
}

export function renderCollections(main) {
  const all = live();
  const cards = S.collections.map((c) => {
    const items = all.filter((l) => (l.collectionIds || []).includes(c.id));
    return h("article", { class: "card coll" },
      h("button", { class: "coll-open", type: "button", onClick: () => go(`collection/${c.id}`) },
        h("div", { class: "coll-thumbs" }, items.slice(0, 4).map((l) => thumbImg(l.coverImageId, ""))),
        h("h2", null, c.name), h("div", { class: "muted small" }, t("{n} annunci", { n: items.length }), items.length ? ` · ${fmtPrice(items.reduce((a, l) => a + (l.price || 0), 0))}` : "")),
      h("div", { class: "row" },
        h("button", { class: "btn sm", type: "button", onClick: async () => { const n = await promptDialog(t("Rinomina collezione"), t("Nome"), c.name); if (n) { await db.put("collections", { ...c, name: n.slice(0, 60) }); await changed(); } } }, t("Rinomina")),
        h("button", { class: "btn sm danger", type: "button", onClick: async () => { if (await confirmDialog(t("Eliminare la collezione?"), t("«{n}» viene eliminata. Gli annunci restano nell'archivio.", { n: c.name }), { okLabel: t("Elimina"), danger: true })) { await archive.removeCollection(c.id); await changed(); } } }, t("Elimina"))));
  });
  clear(main).append(
    h("div", { class: "page-head" }, h("div", null, h("h1", null, t("Collezioni")), h("span", { class: "muted" }, t("Raccolte personali: Estate, Lotti, Da ribassare…"))),
      h("button", { class: "btn primary", type: "button", onClick: async () => { const n = await promptDialog(t("Nuova collezione"), t("Nome")); if (n) { await db.put("collections", { id: uid("c_"), name: n.slice(0, 60), createdAt: Date.now() }); await changed(); } } }, icon("plus"), t("Nuova collezione"))),
    cards.length ? h("div", { class: "coll-grid" }, cards) : h("div", { class: "empty" }, h("p", null, t("Nessuna collezione. Creane una, poi seleziona degli annunci e usa «Collezioni…» per aggiungerli."))));
}

// ---------------------------------------------------------------- modelli di descrizione (F48)

const SAMPLE = { title: "Giacca di jeans", brand: "Levi's", size: "M", colors: ["Blu"], condition: "Ottime", price: 25, category: "Donna › Giacche" };

function editTemplate(tpl) {
  const name = h("input", { class: "input", value: tpl?.name || "", maxlength: "60", autofocus: true });
  const text = h("textarea", { class: "input", rows: "8" });
  text.value = tpl?.text || "";
  const preview = h("div", { class: "desc preview" });
  const upd = () => { preview.textContent = applyTemplate(text.value, SAMPLE) || t("L'anteprima compare qui."); };
  text.addEventListener("input", upd);
  upd();
  modal({
    title: tpl ? t("Modifica modello") : t("Nuovo modello"), wide: true,
    body: h("div", { class: "stack" }, h("label", { class: "field" }, t("Nome"), name), h("label", { class: "field" }, t("Testo"), text),
      h("div", { class: "small muted" }, t("Segnaposto: {titolo} {marca} {taglia} {colore} {condizioni} {prezzo} {categoria}. Vengono sostituiti con i dati dell'annuncio.")),
      h("div", null, h("h3", null, t("Anteprima con un annuncio di esempio")), preview)),
    actions: [{ label: t("Annulla"), onClick: (c) => c() }, { id: "ok", label: t("Salva modello"), kind: "primary", onClick: async (c) => {
      if (!name.value.trim() || !text.value.trim()) { toast(t("Servono un nome e un testo."), "bad"); return; }
      await db.put("templates", { id: tpl?.id || uid("t_"), name: name.value.trim(), text: text.value, createdAt: tpl?.createdAt || Date.now(), updatedAt: Date.now() });
      c();
      rerender();
    } }],
  });
}

export async function renderTemplates(main) {
  const list = (await db.getAll("templates")).sort((a, b) => a.name.localeCompare(b.name));
  clear(main).append(
    h("div", { class: "page-head" }, h("div", null, h("h1", null, t("Modelli di descrizione")), h("span", { class: "muted" }, t("Testi riutilizzabili per spedizione, misure, condizioni. Si inseriscono da «Prepara»."))),
      h("button", { class: "btn primary", type: "button", onClick: () => editTemplate(null) }, icon("plus"), t("Nuovo modello"))),
    list.length ? h("div", { class: "stack" }, list.map((x) => h("article", { class: "card" }, h("div", { class: "row between" }, h("h2", null, x.name),
      h("div", { class: "row" }, h("button", { class: "btn sm", type: "button", onClick: () => editTemplate(x) }, t("Modifica")),
        h("button", { class: "btn sm danger", type: "button", onClick: async () => { if (await confirmDialog(t("Eliminare il modello?"), x.name, { okLabel: t("Elimina"), danger: true })) { await db.del("templates", x.id); rerender(); } } }, t("Elimina")))),
    h("div", { class: "desc" }, x.text)))) : h("div", { class: "empty" }, h("p", null, t("Nessun modello. Esempio: «Spedizione entro 24 ore. Taglia {taglia}, condizioni: {condizioni}.»"))));
}

// ---------------------------------------------------------------- statistiche (F49)

function bars(title, rows, total) {
  const top = rows.slice(0, 10);
  const max = Math.max(1, ...top.map((r) => r.count));
  return h("section", { class: "card" }, h("h2", null, title),
    top.length ? h("table", { class: "table bars" }, h("thead", null, h("tr", null, h("th", null, ""), h("th", null, ""), h("th", { class: "num" }, t("Annunci")), h("th", { class: "num" }, t("Valore")))),
      h("tbody", null, top.map((r) => h("tr", null, h("td", { class: "ell" }, r.label), h("td", { class: "bar" }, h("i", { style: { width: `${Math.round((r.count / max) * 100)}%` } })), h("td", { class: "num" }, r.count), h("td", { class: "num" }, fmtPrice(r.value)))))) : h("p", { class: "muted" }, t("Nessun dato.")),
    rows.length > 10 ? h("div", { class: "small muted" }, t("Mostrati i primi 10 di {n} ({t} annunci in tutto).", { n: rows.length, t: total })) : null);
}

export function renderStats(main) {
  const st = stats(mine());
  const o = others();
  const tile = (value, label) => h("div", { class: "card tile" }, h("b", null, value), h("span", { class: "muted" }, label));
  clear(main).append(
    h("div", { class: "page-head" }, h("div", null, h("h1", null, t("Statistiche")), h("span", { class: "muted" }, t("Solo i tuoi annunci in archivio. Gli annunci non tuoi non entrano nel valore.")))),
    h("div", { class: "tiles" }, tile(st.count, t("Annunci miei")), tile(fmtPrice(st.totalValue), t("Valore totale")), tile(st.avgPrice != null ? fmtPrice(st.avgPrice) : "—", t("Prezzo medio")), tile(st.photos, t("Foto archiviate")), tile(st.favorites, t("Preferiti")), tile(st.offline, t("Non più online o venduti")), tile(o.length, t("Annunci non miei"))),
    h("div", { class: "stat-grid" }, bars(t("Per marca"), st.byBrand, st.count), bars(t("Per categoria"), st.byCategory, st.count), bars(t("Per taglia"), st.bySize, st.count), bars(t("Per condizioni"), st.byCondition, st.count)));
}

// ---------------------------------------------------------------- annunci simili (F44)

export async function renderDuplicates(main) {
  const { openDetail } = await import("./detail.js");
  const groups = similarGroups(S.listings);
  clear(main).append(
    h("div", { class: "page-head" }, h("div", null, h("h1", null, t("Annunci simili")), h("span", { class: "muted" }, t("ID diverso ma stessa foto o stesso titolo e prezzo: succede dopo una ripubblicazione.")))),
    groups.length ? h("div", { class: "stack" }, groups.map((g) => h("section", { class: "card" }, h("h2", null, t("{n} annunci che si somigliano", { n: g.length })),
      h("div", { class: "dupes" }, g.sort((a, b) => b.savedAt - a.savedAt).map((l, i) => h("article", { class: "dupe" },
        h("button", { class: "mini big", type: "button", "aria-label": t("Apri {t}", { t: l.title }), onClick: () => openDetail(l.id) }, thumbImg(l.coverImageId, "")),
        h("div", { class: "grow" }, h("div", { class: "t" }, l.title), h("div", { class: "muted small" }, `${fmtPrice(l.price, l.currency)} · ID ${l.vintedId} · ${t("salvato il")} ${new Date(l.savedAt).toLocaleDateString("it-IT")}`), i === 0 ? h("span", { class: "chip primary" }, t("Il più recente")) : null),
        h("button", { class: "btn sm danger", type: "button", onClick: async () => { await archive.trash([l.id]); await changed(); toast(t("Spostato nel cestino.")); } }, t("Nel cestino")))))))) : h("div", { class: "empty" }, h("p", null, t("Nessun annuncio simile trovato."))));
}
