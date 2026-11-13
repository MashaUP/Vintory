/** Finestra «Cerca aggiornamento»: verifica, download dello zip, istruzioni e ricarica. */
import { h, t, modal, toast, rpc } from "./lib.js";

export function showUpdate(st) {
  if (!st) return;
  if (!st.ok) { modal({ title: t("Cerca aggiornamento"), body: h("div", { class: "note warn" }, st.error), actions: [{ label: t("Chiudi"), onClick: (c) => c() }] }); return; }
  if (!st.available) {
    modal({ title: t("Cerca aggiornamento"), body: h("p", null, t("Vintory è aggiornato: versione {v}.", { v: st.installed })), actions: [{ label: t("Chiudi"), kind: "primary", onClick: (c) => c() }] });
    return;
  }
  const status = h("div", { class: "small muted" });
  const steps = h("ol", { class: "hidden", style: { paddingLeft: "18px", margin: "8px 0 0" } },
    h("li", null, t("Apri la cartella Download › Vintory ed estrai lo zip.")),
    h("li", null, t("Copia il contenuto della cartella «Vintory» sopra quella da cui hai caricato l'estensione, sostituendo i file.")),
    h("li", null, t("Premi «Ricarica Vintory» qui sotto.")));
  const reload = h("button", { class: "btn primary hidden", type: "button", onClick: () => rpc("update.reload") }, t("Ricarica Vintory"));
  const body = h("div", { class: "stack" },
    h("p", null, t("È disponibile la versione {new} (installata: {old}).", { new: st.latest, old: st.installed })),
    st.notes?.length ? h("ul", { style: { paddingLeft: "18px", margin: 0 } }, st.notes.map((n) => h("li", null, n))) : null,
    h("div", { class: "note" }, t("Il tuo archivio non viene toccato dall'aggiornamento. Un backup prima di aggiornare resta una buona idea.")),
    status, steps, h("div", null, reload));
  modal({
    title: t("Aggiornamento disponibile"), body,
    actions: [
      { label: t("Più tardi"), onClick: (c) => c() },
      {
        id: "download", label: t("Scarica e installa"), kind: "primary", onClick: async () => {
          status.textContent = t("Scarico…");
          try {
            const r = await rpc("update.download");
            status.textContent = r.verified ? t("Scaricato {name} in Download › Vintory (impronta verificata).", { name: r.name }) : t("Scaricato {name} in Download › Vintory.", { name: r.name });
            steps.classList.remove("hidden");
            reload.classList.remove("hidden");
          } catch (e) {
            status.textContent = "";
            toast(e.message, "bad");
          }
        },
      },
    ],
  });
}
