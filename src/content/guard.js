/**
 * Guardia di sola lettura.
 * Vintory può chiedere a Vinted SOLO questi percorsi e SOLO con GET: tutto il resto
 * (pubblicare, modificare, eliminare, like, offerte, messaggi, acquisti) viene
 * rifiutato prima che la richiesta parta. La lista è chiusa: per aggiungere un
 * percorso bisogna cambiarla qui, e i test la controllano.
 */
(function (root) {
  "use strict";
  const ALLOWED = [
    /^\/items\/\d+$/,
    /^\/items\/\d+\/details$/,
    /^\/item_upload\/items\/\d+$/,
    /^\/wardrobe\/\d+\/items\?page=\d{1,4}&per_page=\d{1,3}&order=newest_first$/,
  ];
  /** Pagine del sito (non API): solo la pagina pubblica di un annuncio, per sapere se esiste ancora. */
  const ALLOWED_PAGES = [/^\/items\/\d+$/];

  class ReadOnlyGuardError extends Error {
    constructor(message) { super(message); this.name = "ReadOnlyGuardError"; }
  }

  function assertAllowed(method, path, kind = "api") {
    if (String(method).toUpperCase() !== "GET") throw new ReadOnlyGuardError(`Vintory è in sola lettura: richiesta ${method} rifiutata.`);
    const list = kind === "api" ? ALLOWED : kind === "page" ? ALLOWED_PAGES : [];
    if (typeof path !== "string" || !list.some((re) => re.test(path))) throw new ReadOnlyGuardError(`Percorso non previsto, richiesta rifiutata: ${String(path).slice(0, 80)}`);
    return true;
  }

  root.VYGuard = { assertAllowed, ALLOWED, ALLOWED_PAGES, ReadOnlyGuardError };
})(typeof globalThis !== "undefined" ? globalThis : this);
