# Architettura

Estensione Manifest V3, JavaScript puro a moduli ES, nessuna dipendenza a runtime e nessuna build. Tutto è locale.

## Le parti

| Parte | File | Compito |
|---|---|---|
| Service worker | `src/background/sw.js` | account dal cookie, lettura di Vinted tramite la scheda, salvataggio, badge, aggiornamenti, promemoria |
| Content script | `src/content/guard.js`, `vinted.js`, `content.js` | guardia di sola lettura, richieste a Vinted dentro la pagina, pulsante nella pagina |
| Popup | `src/ui/popup.*` | stato dell'annuncio aperto, salvataggio rapido, ultimi salvati |
| Dashboard | `src/ui/dashboard.*`, `src/ui/pages/*` | archivio, importazione, backup, impostazioni |
| Nucleo | `src/shared/*` | modello, database, archivio, backup, ZIP, aggiornamenti |

I moduli di `src/shared` non conoscono l'interfaccia: `model.js`, `zip.js` e `util.js` sono funzioni pure e si provano in Node; `archive.js` e `backup.js` usano solo IndexedDB.

## Lettura di Vinted

1. Il service worker chiede alla scheda di Vinted (`vy:read`) di leggere un annuncio.
2. `vinted.js` fa le richieste **dentro la pagina**, con i cookie dell'utente, e solo dopo `VYGuard.assertAllowed`:
   - `/item_upload/items/:id` → dati del modulo di vendita, prima di tutto e solo se l'annuncio può essere tuo (come Vinted_Relist);
   - `/items/:id` → scheda dell'annuncio; se rifiuta anche dopo il nuovo tentativo e il modulo di vendita ha risposto, per i tuoi annunci non si richiede più fino al ricaricamento della pagina;
   - etichette e percorso della categoria dalla pagina, se sei su quell'annuncio; se nessuna API ha risposto, la pagina dell'annuncio scaricata come testo (`DOMParser`, nessuno script eseguito).
   Ogni richiesta API porta `X-CSRF-Token`: intercettato dalle richieste del sito, altrimenti dagli script della pagina (anche nel payload di Next.js con le virgolette protette), altrimenti dalla pagina «Vendi» (`/items/new`). Un 403 senza CAPTCHA rinnova il token e riprova **una sola volta**.
3. Il risultato è un `bundle` (`details`, `upload`, `wardrobe`, `page`). `model.normalizeBundle` lo trasforma nella scheda; il bundle intero resta in `raw`.

Proprietario: «mio» solo se l'id del venditore coincide con l'id letto dal cookie `v_uid` (o dal `sub` del token). Nel dubbio «altri».

CAPTCHA, 401 e 429 fermano subito la lettura e, nell'importazione, tutto il lavoro. Un 403 confermato dopo il nuovo tentativo fa passare alla fonte successiva; se tutte rifiutano, la lettura si ferma.

Ogni esito (codice HTTP, tipo, secondo tentativo) e l'origine del token finiscono nel report diagnostico, senza id, titoli o token.

«Non più online» lo decide la pagina pubblica dell'annuncio (stato 404), non un 404 delle API: se Vinted cambiasse le sue API, gli annunci non devono sembrare eliminati.

## Database (IndexedDB `vintory`, schema 1)

| Archivio | Chiave | Contenuto |
|---|---|---|
| `listings` | `id` (indice unico `vintedId`) | scheda, proprietario, note, campi, preferito, collezioni, cestino, impronte delle foto |
| `raw` | `listingId` | bundle originale, dati normalizzati al primo salvataggio, ultima lettura |
| `versions` | autoincrementale | com'era la scheda prima di ogni modifica o aggiornamento (massimo 30) |
| `images` | `id` | foto originale (Blob), ordine, SHA-256, impronta visiva, stato |
| `thumbs` | `imageId` | miniatura JPEG |
| `collections`, `filters`, `templates`, `jobs` | `id` | collezioni, filtri salvati, modelli, importazioni |
| `meta` | `key` | etichette imparate (id → nome), cartella dei backup |

Le impostazioni stanno in `chrome.storage.local`. Le migrazioni future si aggiungono in `db.js` (`migrate`, per numero di versione).

Le foto si scaricano dal service worker o dalla dashboard (permesso `*.vinted.net`), con limite di 60 secondi. Una foto non scaricata resta registrata come «mancante»: il controllo di integrità la segnala e può riscaricarla.

## Importazione

La dashboard guida il lavoro e lo scrive in `jobs` dopo ogni annuncio. Se la pagina si chiude, alla riapertura il lavoro rimasto «in corso» diventa «interrotto» e si riprende dagli annunci in attesa. Tra un annuncio e l'altro c'è una pausa (1,2–2,5 s di serie).

## Backup

`Vintory-backup-<data>.zip` contiene `vintory.json` (formato `vintory-backup`, schema 1) e le cartelle `images/` e `thumbs/`. Lo ZIP è scritto senza compressione e senza librerie (`zip.js`); il lettore accetta anche ZIP compressi. L'importazione unisce (salta gli ID Vinted già presenti) oppure sostituisce.

## Aggiornamenti e collegamenti

`version.json` e `links.json` si leggono dal ramo `main` del repository. Lo zip dell'aggiornamento è quello nella radice del repository; se `version.json` ne dichiara lo SHA-256, viene verificato prima di salvarlo. I link accettati sono solo `https` verso `github.com`, `discord.gg`, `discord.com` e `ko-fi.com`.

## Formato per Vinted_Relist

`relist.json` (formato `vintory-relist`, schema 1): `source`, `listing` (testi, prezzo, etichette, id), `photos` (file nello stesso ZIP), `uploadDraft` (i dati del modulo di vendita così come Vinted li ha forniti, se disponibili).
