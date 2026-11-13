/**
 * Pulsante di Vintory nelle pagine di Vinted (annuncio e armadio) e ponte con il service worker.
 * Il pulsante vive in uno shadow DOM agganciato a <html>: non entra nell'albero React di
 * Vinted e non compare in pannelli o finestre del sito.
 */
(() => {
  "use strict";
  const VY = globalThis.VY;
  VY.version = chrome.runtime.getManifest().version;
  const HOST_ID = "vintory-host";
  document.getElementById(HOST_ID)?.remove();            // resto di una versione precedente dell'estensione
  if (globalThis.__vintoryTimer) clearInterval(globalThis.__vintoryTimer);

  const alive = () => { try { return Boolean(chrome.runtime?.id); } catch { return false; } };
  async function rpc(method, params = {}) {
    if (!alive()) throw Object.assign(new Error("Vintory è stato aggiornato: ricarica la pagina (F5)."), { stale: true });
    let r;
    try { r = await chrome.runtime.sendMessage({ type: "vy:rpc", method, params }); } catch (e) {
      throw Object.assign(new Error(alive() ? `Vintory non risponde: ${e.message}` : "Vintory è stato aggiornato: ricarica la pagina (F5)."), { stale: !alive() });
    }
    if (r?.__error) throw new Error(r.error);
    return r;
  }

  // ---------------------------------------------------------------- interfaccia

  const host = document.createElement("div");
  host.id = HOST_ID;
  // In basso a sinistra: a destra ci sono già i pulsanti di Vinted_Relist e Vintastic.
  host.style.cssText = "position:fixed;left:18px;bottom:18px;z-index:2147483000;";
  const root = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: Inter, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif; }
    .wrap { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; }
    button { font-size: 14px; cursor: pointer; border: 0; }
    .main { display: inline-flex; align-items: center; gap: 8px; padding: 10px 16px; border-radius: 999px; background: #3b2a7a; color: #fff; font-weight: 600; box-shadow: 0 6px 20px rgba(30, 15, 80, .35); }
    .main:hover { background: #4b37a0; }
    .main:focus-visible, .ghost:focus-visible, .ok:focus-visible { outline: 3px solid #b69cff; outline-offset: 2px; }
    .main[disabled] { opacity: .75; cursor: progress; }
    .main.saved { background: #1f7a4c; }
    .main.changed { background: #a85d07; }
    .dot { width: 18px; height: 18px; border-radius: 5px; background: #fff; color: #3b2a7a; font-weight: 800; font-size: 12px; display: inline-flex; align-items: center; justify-content: center; }
    .panel { width: 300px; background: #fff; color: #1a1527; border: 1px solid #e0d9ef; border-radius: 14px; padding: 14px; box-shadow: 0 10px 30px rgba(40, 20, 90, .2); font-size: 13px; line-height: 1.45; }
    .panel b { display: block; font-size: 14px; margin-bottom: 4px; }
    .row { display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; }
    .ok { padding: 8px 14px; border-radius: 9px; background: #6a47e8; color: #fff; font-weight: 600; }
    .ghost { padding: 8px 14px; border-radius: 9px; background: #eee9f8; color: #1a1527; }
    .toast { max-width: 320px; background: #1a1527; color: #fff; border-radius: 10px; padding: 10px 12px; font-size: 13px; line-height: 1.4; box-shadow: 0 6px 20px rgba(0, 0, 0, .3); }
    .toast.bad { background: #8f1d1d; }
    @media (prefers-reduced-motion: no-preference) { .main { transition: background .15s; } }
  `;
  const wrap = document.createElement("div");
  wrap.className = "wrap";
  root.append(style, wrap);

  const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
  let toastTimer = null;
  function toast(message, bad = false) {
    wrap.querySelector(".toast")?.remove();
    const t = el("div", `toast${bad ? " bad" : ""}`, message);
    t.setAttribute("role", "status");
    wrap.prepend(t);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.remove(), bad ? 9000 : 5000);
  }
  function closePanel() { wrap.querySelector(".panel")?.remove(); }

  let ctx = { kind: "other" };
  let info = null;
  let busy = false;

  function render() {
    wrap.querySelector(".main")?.remove();
    closePanel();
    if (ctx.kind === "other" || !info || !info.pageButton) { host.remove(); return; }
    if (!host.isConnected) document.documentElement.append(host);
    const b = el("button", "main");
    b.type = "button";
    const dot = el("span", "dot", "V");
    let label;
    if (ctx.kind === "wardrobe") label = info.mine ? "Importa il mio armadio" : "Importa questo armadio";
    else if (info.saved && info.remoteChanged) { label = "Modificato su Vinted · Rivedi"; b.classList.add("changed"); }
    else if (info.saved) { label = "Salvato in Vintory"; b.classList.add("saved"); dot.textContent = "✓"; }
    else label = "Salva in Vintory";
    b.append(dot, el("span", null, label));
    b.title = ctx.kind === "wardrobe" ? "Apre Vintory con l'elenco degli annunci di questo armadio" : info.saved ? "Apre la scheda archiviata" : "Salva una copia completa di questo annuncio";
    b.addEventListener("click", onClick);
    wrap.append(b);
  }

  function setBusy(on, label) {
    busy = on;
    const b = wrap.querySelector(".main");
    if (!b) return;
    b.disabled = on;
    if (on && label) b.lastChild.textContent = label;
  }

  async function onClick() {
    if (busy) return;
    try {
      if (ctx.kind === "wardrobe") { await rpc("open.dashboard", { hash: `import?origin=${encodeURIComponent(ctx.origin)}&user=${ctx.id}&fromTab=1` }); return; }
      if (info.saved) { await rpc("open.dashboard", { hash: `archive?item=${info.listingId}${info.remoteChanged ? "&update=1" : ""}` }); return; }
      await save(false);
    } catch (e) {
      toast(e.message, true);
    }
  }

  async function save(confirmOther) {
    setBusy(true, "Salvo…");
    try {
      const r = await rpc("save.tab", { confirmOther });
      if (r.status === "needsConfirm") {
        setBusy(false);
        render();
        const p = el("div", "panel");
        p.setAttribute("role", "dialog");
        p.setAttribute("aria-label", "Annuncio non tuo");
        p.append(el("b", null, "Questo annuncio non è tuo"), el("div", null, `${r.seller ? `È di ${r.seller}. ` : ""}Verrà salvato nella sezione «Annunci non miei», separata dal tuo archivio.`));
        const row = el("div", "row");
        const no = el("button", "ghost", "Annulla");
        const yes = el("button", "ok", "Salva comunque");
        no.type = yes.type = "button";
        no.addEventListener("click", closePanel);
        yes.addEventListener("click", () => { closePanel(); save(true).catch((e) => toast(e.message, true)); });
        row.append(no, yes);
        p.append(row);
        wrap.prepend(p);
        yes.focus();
        return;
      }
      info = { ...info, saved: true, listingId: r.listingId, remoteChanged: false };
      render();
      if (r.status === "saved") {
        const parts = [`Salvato: ${r.photoCount} foto`];
        if (r.photoMissing) parts.push(`${r.photoMissing} non scaricate`);
        if (r.similar) parts.push("somiglia a un annuncio già in archivio");
        toast(`${parts.join(" · ")}.`, Boolean(r.photoMissing));
      } else if (r.status === "restored") toast("Era nel cestino di Vintory: ripristinato.");
      else toast("Già in archivio: nessun doppione creato.");
    } finally {
      setBusy(false);
    }
  }

  // ---------------------------------------------------------------- contesto della pagina

  let seq = 0;
  async function refresh() {
    const mine = ++seq;
    ctx = VY.pageKind();
    if (ctx.kind === "other") { info = null; render(); return; }
    try {
      info = await rpc("page.visit", ctx);
    } catch (e) {
      info = null;
      if (e.stale) { host.remove(); clearInterval(globalThis.__vintoryTimer); }
      return;
    }
    if (mine !== seq) return;
    render();
    if (ctx.kind === "item" && info.check) {
      const r = await VY.read({ id: ctx.id, accountId: info.accountId });
      if (mine !== seq || !r.ok) return;
      try {
        const c = await rpc("page.compare", { bundle: r.bundle, origin: ctx.origin });
        if (mine === seq && c && c.changed !== info.remoteChanged) { info.remoteChanged = c.changed; render(); }
      } catch { /* il confronto è facoltativo */ }
    }
  }

  let lastPath = null;
  globalThis.__vintoryTimer = setInterval(() => {
    if (!alive()) { host.remove(); clearInterval(globalThis.__vintoryTimer); return; }
    if (location.pathname !== lastPath) { lastPath = location.pathname; refresh(); }
  }, 700);

  if (globalThis.__vintoryListener) { try { chrome.runtime.onMessage.removeListener(globalThis.__vintoryListener); } catch { /* contesto precedente */ } }
  globalThis.__vintoryListener = (msg, _sender, send) => {
    if (!msg || typeof msg.type !== "string" || !msg.type.startsWith("vy:")) return false;
    const run = { "vy:read": VY.read, "vy:status": VY.status, "vy:wardrobe": VY.wardrobe, "vy:page": VY.page }[msg.type];
    if (msg.type === "vy:ping") { send({ ok: true, version: VY.version, page: VY.pageKind() }); return false; }
    if (msg.type === "vy:refresh") { refresh(); send({ ok: true }); return false; }
    if (!run) return false;
    run(msg).then(send, (e) => send({ ok: false, kind: e?.name === "ReadOnlyGuardError" ? "guard" : "error", message: e.message, version: VY.version }));
    return true;
  };
  chrome.runtime.onMessage.addListener(globalThis.__vintoryListener);
})();
