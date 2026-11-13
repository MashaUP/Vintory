/** Dashboard: barra laterale, navigazione e avvio. */
import { h, t, clear, icon, toast, modal, rpc, applyTheme, safeUrl, setLang, forgetThumbs } from "./lib.js";
import { S, reload, loadSettings, parseRoute, setRenderer, live, mine, others, trashed, go, lastOwnChange } from "./state.js";
import * as archive from "../shared/archive.js";
import { getState, setState } from "../shared/store.js";
import { VERSION } from "../shared/constants.js";
import { backupDue } from "../shared/model.js";
import { renderList } from "./pages/list.js";
import { openDetail } from "./pages/detail.js";
import { renderImport, recoverJobs } from "./pages/import.js";
import { renderBackup, maybeAutoBackup } from "./pages/backup.js";
import { renderSettings, renderHealth } from "./pages/settings.js";
import { renderCollections, renderTemplates, renderStats, renderDuplicates } from "./pages/more.js";
import { showUpdate } from "./update-ui.js";

const app = document.getElementById("app");
const NAV = [
  ["archive", "archive", "Il mio archivio", () => mine().length],
  ["others", "users", "Annunci non miei", () => others().length],
  ["recent", "clock", "Aggiunti di recente", null],
  ["favorites", "star", "Preferiti", () => live().filter((l) => l.favorite).length],
  ["collections", "folder", "Collezioni", () => S.collections.length],
  ["duplicates", "copy", "Annunci simili", null],
  null,
  ["import", "download", "Importa", null],
  ["templates", "doc", "Modelli", null],
  ["stats", "chart", "Statistiche", null],
  null,
  ["backup", "shield", "Backup", null],
  ["trash", "trash", "Cestino", () => trashed().length],
  ["settings", "gear", "Impostazioni", null],
];
const ALIAS = { collection: "collections", health: "settings", welcome: "archive" };

function drawNav(current) {
  const nav = clear(document.getElementById("nav"));
  const due = live().length > 0 && backupDue(S.settings.backup.lastAt, S.settings.backup.remindDays);
  for (const item of NAV) {
    if (!item) { nav.append(h("hr")); continue; }
    const [name, ic, label, counter] = item;
    const n = counter ? counter() : null;
    nav.append(h("a", { href: `#${name}`, class: (ALIAS[current] || current) === name ? "on" : "", "aria-current": (ALIAS[current] || current) === name ? "page" : null },
      icon(ic), h("span", { class: "grow" }, t(label)), n ? h("span", { class: "n" }, n) : null, name === "backup" && due ? h("span", { class: "dot", title: t("Backup da fare") }) : null));
  }
}

async function drawLinks() {
  S.links = await rpc("links.get").catch(() => ({}));
  const box = clear(document.getElementById("links"));
  for (const k of ["kofi", "discord", "github"]) {
    const url = safeUrl(S.links[k]?.url);
    if (url) box.append(h("a", { href: url, target: "_blank", rel: "noopener", dataset: { link: k } }, S.links[k].label));
  }
}

let seq = 0;
async function render() {
  const mySeq = ++seq;
  const r = parseRoute();
  drawNav(r.name);
  app.setAttribute("aria-busy", "true");
  try {
    switch (r.name) {
      case "archive": case "welcome": await renderList(app, "archive"); break;
      case "others": await renderList(app, "others"); break;
      case "recent": await renderList(app, "recent"); break;
      case "favorites": await renderList(app, "favorites"); break;
      case "trash": await renderList(app, "trash"); break;
      case "collection": await renderList(app, "collection", r.arg); break;
      case "collections": renderCollections(app); break;
      case "duplicates": await renderDuplicates(app); break;
      case "import": await renderImport(app); break;
      case "templates": await renderTemplates(app); break;
      case "stats": renderStats(app); break;
      case "backup": await renderBackup(app); break;
      case "settings": await renderSettings(app); break;
      case "health": await renderHealth(app); break;
      default: go("archive"); return;
    }
  } catch (e) {
    clear(app).append(h("div", { class: "note bad" }, t("Questa sezione non si è aperta: {e}", { e: e.message })));
  }
  if (mySeq !== seq) return;
  app.removeAttribute("aria-busy");
  document.title = `Vintory — ${t(NAV.find((n) => n && n[0] === (ALIAS[r.name] || r.name))?.[2] || "Archivio")}`;
  if (r.params.item) {
    const { item, update } = r.params;
    history.replaceState(null, "", `#${r.name}${r.arg ? `/${r.arg}` : ""}`);
    openDetail(item, { update: update === "1" });
  }
}

function welcome() {
  modal({
    title: t("Benvenuto in Vintory"),
    body: h("div", { class: "stack" },
      h("p", null, t("Vintory conserva una copia completa dei tuoi annunci Vinted, con tutte le foto, dentro questo browser. La copia resta anche se l'annuncio sparisce da Vinted.")),
      h("ol", { style: { paddingLeft: "18px", margin: 0 } },
        h("li", null, t("Apri un tuo annuncio su Vinted e premi «Salva in Vintory» (in basso a sinistra o dall'icona dell'estensione).")),
        h("li", null, t("Per salvarne tanti insieme: apri il tuo armadio e usa «Importa».")),
        h("li", null, t("Fai un backup ogni tanto: se rimuovi l'estensione, l'archivio che sta nel browser viene cancellato."))),
      h("div", { class: "note" }, t("Vintory è in sola lettura: non pubblica, non modifica e non elimina nulla su Vinted."))),
    actions: [{ label: t("Vai al backup"), onClick: (c) => { c(); go("backup"); } }, { label: t("Ho capito"), kind: "primary", onClick: (c) => c() }],
  });
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== "vy:changed") return;
  if (msg.reason === "ui" && Date.now() - lastOwnChange() < 1500) return;      // l'eco della nostra stessa modifica
  reload().then(() => { if (!document.querySelector(".overlay") && parseRoute().name !== "import") render(); else drawNav(parseRoute().name); });
});

window.addEventListener("hashchange", render);
window.addEventListener("pagehide", forgetThumbs);
document.getElementById("update").addEventListener("click", async (e) => {
  const b = e.currentTarget;
  b.disabled = true;
  try { const st = await rpc("update.check"); await drawLinks(); showUpdate(st); } catch (err) { toast(err.message, "bad"); } finally { b.disabled = false; }
});

(async () => {
  await loadSettings();
  applyTheme(S.settings.theme);
  setLang(S.settings.lang);
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => applyTheme(S.settings.theme));
  document.getElementById("version").textContent = `${t("Versione")} ${VERSION}`;
  S.account = await rpc("account.get").catch(() => S.account);
  await archive.purgeExpired().catch(() => 0);
  await recoverJobs();
  await reload();
  setRenderer(render);
  await render();
  drawLinks();
  if (parseRoute().name === "welcome" || !(await getState("welcomed", false))) { await setState("welcomed", true); if (!S.listings.length) welcome(); }
  maybeAutoBackup();
  const up = await getState("update", null);
  if (up?.available) toast(t("È disponibile Vintory {v}: Impostazioni › Aggiornamenti.", { v: up.latest }), "good", 8000);
})().catch((e) => { clear(app).append(h("div", { class: "note bad" }, t("Vintory non è riuscito ad aprire l'archivio: {e}", { e: e.message }))); app.removeAttribute("aria-busy"); });
