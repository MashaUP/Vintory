/** Popup: stato dell'annuncio aperto, salvataggio rapido, ultimi salvati, collegamenti. */
import { h, t, clear, toast, rpc, applyTheme, thumbUrl, safeUrl, icon } from "./lib.js";
import { getSettings } from "../shared/store.js";
import { fmtPrice, fmtDate } from "../shared/util.js";
import { showUpdate } from "./update-ui.js";

const app = document.getElementById("app");
let tab = null;

const openDash = async (hash) => { await rpc("open.dashboard", { hash }); window.close(); };

function nowCard(ctx) {
  if (ctx.kind === "item") {
    const box = h("section", { class: "now" });
    const state = ctx.saved
      ? ctx.remoteChanged ? h("div", { class: "state" }, h("span", { class: "chip warn" }, t("Modificato su Vinted")), t("dopo il salvataggio")) : h("div", { class: "state" }, h("span", { class: "chip good" }, t("Salvato")), t("in archivio"))
      : h("div", { class: "state" }, h("span", { class: "chip primary" }, t("Non salvato")));
    box.append(state);
    if (ctx.title) box.append(h("div", { class: "title" }, ctx.title));
    if (ctx.saved) {
      box.append(h("div", { class: "row" },
        h("button", { class: "btn primary", type: "button", onClick: () => openDash(`archive?item=${ctx.listingId}${ctx.remoteChanged ? "&update=1" : ""}`) }, ctx.remoteChanged ? t("Rivedi le differenze") : t("Apri la scheda"))));
    } else {
      const btn = h("button", { class: "btn primary", type: "button", id: "save" }, t("Salva in Vintory"));
      const msg = h("div", { class: "small muted" });
      btn.addEventListener("click", () => save(btn, msg, false));
      box.append(h("div", { class: "row" }, btn), msg);
    }
    return box;
  }
  if (ctx.kind === "wardrobe") {
    return h("section", { class: "now" },
      h("div", { class: "state" }, ctx.mine ? t("Il tuo armadio") : t("Armadio di un altro utente")),
      h("div", { class: "row" }, h("button", { class: "btn primary", type: "button", onClick: () => openDash(`import?origin=${encodeURIComponent(ctx.origin)}&user=${ctx.id}&tab=${tab.id}`) }, t("Importa da questo armadio"))));
  }
  return h("section", { class: "now" }, h("div", { class: "muted" }, ctx.kind === "none" ? t("Apri un annuncio o un armadio su Vinted per salvarlo qui.") : t("Apri la pagina di un annuncio per salvarlo, o un armadio per importarne più di uno.")));
}

async function save(btn, msg, confirmOther) {
  btn.disabled = true;
  btn.textContent = t("Salvo…");
  try {
    const r = await rpc("save.tab", { tabId: tab.id, confirmOther });
    if (r.status === "needsConfirm") {
      clear(msg).append(h("div", { class: "note warn" }, t("Questo annuncio non è tuo{who}. Verrà salvato nella sezione «Annunci non miei».", { who: r.seller ? ` (${r.seller})` : "" })),
        h("div", { class: "row", style: { marginTop: "8px" } }, h("button", { class: "btn primary sm", type: "button", id: "confirm-other", onClick: () => { clear(msg); save(btn, msg, true); } }, t("Salva comunque"))));
      btn.disabled = false;
      btn.textContent = t("Salva in Vintory");
      return;
    }
    await render();
    if (r.status === "saved") toast(r.photoMissing ? t("Salvato, ma {n} foto non sono state scaricate.", { n: r.photoMissing }) : t("Salvato con {n} foto.", { n: r.photoCount }), r.photoMissing ? "bad" : "good");
    else if (r.status === "restored") toast(t("Era nel cestino: ripristinato."), "good");
    else toast(t("Già in archivio: nessun doppione creato."));
  } catch (e) {
    btn.disabled = false;
    btn.textContent = t("Salva in Vintory");
    clear(msg).append(h("div", { class: "note bad" }, e.message));
  }
}

async function render() {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  tab = active;
  const [ctx, sum] = await Promise.all([tab ? rpc("tab.context", { tabId: tab.id }) : { kind: "none" }, rpc("popup.summary")]);
  document.getElementById("version").textContent = `${t("Versione")} ${sum.version}`;
  clear(app);
  app.append(nowCard(ctx));
  if (sum.update?.available) app.append(h("div", { class: "note good" }, t("È disponibile Vintory {v}.", { v: sum.update.latest }), " ", h("a", { href: "#", onClick: (e) => { e.preventDefault(); showUpdate(sum.update); } }, t("Dettagli"))));
  if (sum.backupDue) app.append(h("div", { class: "note warn" }, sum.lastBackupAt ? t("Ultimo backup: {d}. È ora di rifarlo.", { d: fmtDate(sum.lastBackupAt) }) : t("Non hai ancora un backup: se rimuovi l'estensione l'archivio va perso."), " ", h("a", { href: "#", onClick: (e) => { e.preventDefault(); openDash("backup"); } }, t("Fai un backup"))));
  app.append(h("div", { class: "tiles" },
    h("div", { class: "tile" }, h("b", null, sum.mine), h("span", { class: "muted small" }, t("Miei annunci"))),
    h("div", { class: "tile" }, h("b", null, sum.others), h("span", { class: "muted small" }, t("Non miei"))),
    h("div", { class: "tile" }, h("b", null, sum.lastBackupAt ? fmtDate(sum.lastBackupAt).replace(/ \d{4}$/, "") : "—"), h("span", { class: "muted small" }, t("Ultimo backup")))));
  if (sum.recent.length) {
    const list = h("div", { class: "recent" });
    for (const r of sum.recent) {
      const img = h("img", { alt: "" });
      thumbUrl(r.coverImageId).then((u) => { if (u) img.src = u; else img.classList.add("empty"); });
      list.append(h("button", { type: "button", onClick: () => openDash(`archive?item=${r.id}`) }, img, h("span", { class: "grow" }, r.title || t("Senza titolo")), h("span", { class: "muted small" }, fmtPrice(r.price, r.currency))));
    }
    app.append(h("section", null, h("h3", { style: { marginBottom: "6px" } }, t("Ultimi salvati")), list));
  }
  app.removeAttribute("aria-busy");
}

async function renderLinks() {
  const links = await rpc("links.get");
  const nav = clear(document.getElementById("links"));
  for (const k of ["kofi", "discord", "github"]) {
    const url = safeUrl(links[k]?.url);
    if (url) nav.append(h("a", { href: url, target: "_blank", rel: "noopener" }, links[k].label));
  }
}

document.getElementById("open").addEventListener("click", () => openDash("archive"));
document.getElementById("update").addEventListener("click", async (e) => {
  const b = e.currentTarget;
  b.disabled = true;
  try { showUpdate(await rpc("update.check")); renderLinks(); } catch (err) { toast(err.message, "bad"); } finally { b.disabled = false; }
});

(async () => {
  applyTheme((await getSettings()).theme);
  await render();
  renderLinks();
})().catch((e) => { clear(app).append(h("div", { class: "note bad" }, e.message), h("div", { class: "muted small" }, icon("refresh", 14), " ", t("Chiudi e riapri il popup."))); app.removeAttribute("aria-busy"); });
