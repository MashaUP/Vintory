/** «Completa i dati mancanti» (1.0.2): categoria, taglia, marca, condizioni e dati dei libri degli annunci già archiviati. */
import { h, t, toast, modal, rpc } from "./lib.js";
import { changed, live } from "./state.js";

/** Annunci con il numero della categoria ma senza il suo nome. */
export const missingCategory = () => live().filter((l) => !l.category && l.ids?.catalogId);

export async function fillMissing() {
  const m = modal({ title: t("Completo i dati mancanti"), dismissable: false, body: h("p", { class: "muted" }, t("Leggo una pagina di Vinted per ogni categoria di cui manca il nome, con calma. Può volerci un minuto.")) });
  try {
    const r = await rpc("fill.missing");
    await changed({ silent: true });
    const parts = [t("{n} annunci completati", { n: r.filled })];
    if (r.categories) parts.push(t("{a} categorie su {b} trovate", { a: r.learned, b: r.categories }));
    toast(`${parts.join(" · ")}.${r.stopped ? ` ${r.stopped}` : ""}`, r.stopped || r.failed ? "" : "good", 7000);
    return r;
  } catch (e) {
    toast(e.message, "bad");
    return null;
  } finally {
    m.close();
  }
}

/** Avviso nell'archivio, solo se serve. */
export function fillNote(onDone) {
  const n = missingCategory().length;
  if (!n) return null;
  return h("div", { class: "note row between", id: "fill-note" },
    h("span", null, t("{n} annunci hanno solo il numero della categoria, senza il nome.", { n })),
    h("button", { class: "btn sm", type: "button", id: "fill-run", onClick: async () => { await fillMissing(); onDone?.(); } }, t("Completa i dati mancanti")));
}
