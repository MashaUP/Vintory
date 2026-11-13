/** Finestra «Cerca aggiornamento»: verifica, download dello zip, istruzioni e ricarica. */
import { h, t, modal, toast, rpc, confirmDialog } from "./lib.js";
import { diskVersion } from "../shared/updates.js";
import * as db from "../shared/db.js";

/**
 * Installa i file già estratti nella cartella: ricarica l'estensione (come «Installa l'aggiornamento»
 * di Vinted_Relist). Niente arriva da Internet. Se un'importazione è in corso, chiede prima.
 */
export async function installNow({ reopen = true } = {}) {
  const running = (await db.getAll("jobs").catch(() => [])).some((j) => j.status === "running");
  if (running && !(await confirmDialog(t("Importazione in corso"), t("Ricaricando Vintory l'importazione si ferma: la ritrovi «Interrotta» e la riprendi con «Riprendi», senza perdere gli annunci già salvati."), { okLabel: t("Installa comunque") }))) return;
  await rpc("update.reload", { reopen });
}

/**
 * Riquadro «Installa l'aggiornamento»: compare da solo quando la cartella di Vintory
 * contiene una versione diversa da quella in uso. Si ricontrolla quando la pagina torna in primo piano.
 */
export function mountInstallBox(box, { compact = false } = {}) {
  async function check() {
    const v = await diskVersion();
    box.replaceChildren();
    box.classList.toggle("hidden", !v.pending);
    if (!v.pending) return;
    box.append(
      h("div", { class: "install-text" }, v.newer ? t("Hai estratto Vintory {v}.", { v: v.disk }) : t("Nella cartella c'è la versione {v}.", { v: v.disk }), compact ? null : h("span", { class: "small" }, ` ${t("In uso: {v}.", { v: v.loaded })}`)),
      h("button", { class: "btn primary sm", type: "button", id: compact ? "install-popup" : "install-side", onClick: () => installNow() }, t("Installa l'aggiornamento")));
  }
  check();
  addEventListener("focus", check);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) check(); });
  const timer = setInterval(check, 30_000);
  return { check, stop: () => clearInterval(timer) };
}

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
    h("li", null, t("Premi «Installa l'aggiornamento»: compare da solo appena Vintory vede i file nuovi nella cartella.")));
  const reload = h("button", { class: "btn primary hidden", type: "button", onClick: () => installNow() }, t("Installa l'aggiornamento"));
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
