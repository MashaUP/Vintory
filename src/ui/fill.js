/** «Completa i dati mancanti»: categoria, taglia, marca, condizioni e dati dei libri degli annunci già archiviati. */
import { h, t, toast, progressDialog, rpc } from "./lib.js";
import { S, changed, live, setSettings } from "./state.js";

/** Annunci con il numero della categoria ma senza il suo nome. */
export const missingCategory = () => live().filter((l) => !l.category && l.ids?.catalogId);

export async function fillMissing() {
  const p = progressDialog(t("Completo i dati mancanti"), t("Leggo da Vinted una pagina per ogni categoria di cui manca il nome, con le pause dell'importazione. Se serve, apro l'annuncio in una scheda in secondo piano."));
  const onMsg = (m) => { if (m?.type === "vy:fill-progress") p.set(m.done, m.total, m.msg ? t("Categoria {a} di {b}: {t}", { a: Math.min(m.done + 1, m.total), b: m.total, t: m.msg }) : t("Applico i nomi trovati…")); };
  chrome.runtime.onMessage.addListener(onMsg);
  try {
    const r = await rpc("fill.missing");
    await changed({ silent: true });
    if (r.categories && !r.learned) {
      toast(t("Non sono riuscito a leggere da Vinted i nomi delle categorie ({n} provate). Apri Impostazioni › Salute, copia il report diagnostico e mandamelo.", { n: r.categories }), "bad", 12000);
    } else {
      const parts = [t("{n} annunci completati", { n: r.filled })];
      if (r.categories) parts.push(t("{a} categorie su {b} trovate", { a: r.learned, b: r.categories }));
      if (r.approx) parts.push(t("{n} solo con il nome breve", { n: r.approx }));
      toast(`${parts.join(" · ")}.${r.stopped ? ` ${r.stopped}` : ""}`, r.stopped || r.failed ? "" : "good", 8000);
    }
    return r;
  } catch (e) {
    toast(e.message, "bad");
    return null;
  } finally {
    chrome.runtime.onMessage.removeListener(onMsg);
    p.close();
  }
}

/** Avviso nell'archivio: solo se serve e se non è stato nascosto (ricompare se gli annunci senza categoria aumentano). */
export function fillNote(onDone) {
  const n = missingCategory().length;
  const hidden = S.settings?.fillNoteHidden;
  if (!n || (hidden != null && n <= hidden)) return null;
  return h("div", { class: "note row between", id: "fill-note" },
    h("span", null, t("{n} annunci hanno solo il numero della categoria, senza il nome.", { n })),
    h("span", { class: "row" },
      h("button", { class: "btn sm", type: "button", id: "fill-run", onClick: async () => { await fillMissing(); onDone?.(); } }, t("Completa i dati mancanti")),
      h("button", { class: "btn sm ghost", type: "button", id: "fill-hide", onClick: async () => { await setSettings({ fillNoteHidden: n }); onDone?.(); } }, t("Non ora"))));
}
