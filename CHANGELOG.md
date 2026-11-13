# Novità

Il formato segue [Keep a Changelog](https://keepachangelog.com/it/1.1.0/) e le versioni seguono [Semantic Versioning](https://semver.org/lang/it/).

## [1.1.0] - 2026-11-13

### Nuovo
- **«Installa l'aggiornamento» compare da solo**: quando estrai una nuova versione sopra la cartella di Vintory, il popup e la barra laterale mostrano un riquadro con il pulsante, senza dover controllare GitHub. Vintory confronta il `manifest.json` della cartella con la versione in uso. Il pulsante resta anche in Impostazioni › Aggiornamenti. Se un'importazione è in corso chiede prima conferma, e dopo il riavvio riapre l'archivio dicendo da che versione arrivi.
- **Più annunci insieme per Vinted_Relist**: «Per Vinted_Relist» nella barra di selezione crea un solo ZIP con tutti gli annunci tuoi selezionati.
- **Formato del ponte con Vinted_Relist** (`vintory-relist`, schema 2), descritto in `docs/RELIST_BRIDGE.md`: un file `vintory-relist.json` con l'elenco degli annunci e le foto in `photos/<id Vinted>/01.jpg…`. Contiene la copia di Vintory, gli id del modulo di vendita, i campi modificati a mano, lo stato online e l'impronta di ogni foto. Sostituisce lo schema 1 (`relist.json`, un annuncio per file).

### Corretto
- L'esportazione per Vinted_Relist usava i dati del modulo di vendita del primo salvataggio anche dopo «Aggiorna da Vinted»: ora usa l'ultima lettura.

## [1.0.2] - 2026-11-13

Correzioni dei dati, viste sul primo archivio reale (41 annunci importati con la 1.0.1).

### Corretto
- **Categoria vuota** negli annunci importati: Vinted dà solo il numero. Ora Vintory legge il nome dalla pagina di un annuncio, una sola volta per categoria, e lo usa per tutti gli altri. Il percorso si riconosce dai link `/catalog/<numero>` della pagina e deve finire con la categoria dell'annuncio, così il menu del sito non viene scambiato per una categoria.
- **Taglia e marca** perse nell'importazione: la riga dell'armadio le dà come testo (`size`, `brand`) e non venivano lette.
- **Condizioni** lette anche da `item_attributes` del modulo di vendita, dove le mette Vinted per libri e simili.

### Nuovo
- Libri, elettronica e simili: autore, titolo del libro, ISBN, produttore, modello e misure nella scheda, nella ricerca e nell'esportazione CSV/Excel (autore e ISBN).
- **«Completa i dati mancanti»** (avviso nell'archivio e pagina Salute): completa gli annunci già salvati prima con i dati che Vintory ha già, poi leggendo una pagina per ogni categoria senza nome. Si ferma davanti a CAPTCHA o 429. Dopo l'aggiornamento la parte che non richiede Vinted parte da sola.
- Pulsante **«Per Vinted_Relist»** nella scheda dei tuoi annunci (prima era solo dentro «Prepara»). L'esportazione include anche i dati dei libri.

## [1.0.1] - 2026-11-13

### Corretto
- Salvataggio e importazione si fermavano subito con «Vinted ha rifiutato la richiesta (403)». Le cause: il token CSRF non veniva trovato nelle pagine di Vinted, nessun nuovo tentativo dopo un 403, e la prima lettura era un indirizzo che su Vinted non esiste.
- Il token CSRF si cerca come in Vinted_Relist: dalle richieste del sito, dagli script della pagina (anche con le virgolette protette) e, se serve, dalla pagina «Vendi». Dopo un 403 si rinnova il token e si riprova una sola volta.
- Per i tuoi annunci si legge prima il modulo di vendita (`/item_upload/items/<id>`), poi la scheda. Un 403 su una fonte fa passare alla successiva; se le API non rispondono, si legge la pagina dell'annuncio.
- CAPTCHA, 429 e sessione scaduta fermano tutto come prima. Un 403 ferma la lettura solo se lo danno tutte le fonti, e il messaggio dice quali.

### Nuovo
- Il report diagnostico mostra l'esito di ogni lettura da Vinted (codice, tipo, secondo tentativo) e da dove arriva il token, senza id, titoli o token.

## [1.0.0] - 2026-11-13

Prima versione.

### Salvataggio
- Pulsante «Salva in Vintory» nella pagina dell'annuncio e nel popup.
- Badge sull'icona: da salvare (`+`), salvato (`✓`), modificato su Vinted dopo il salvataggio (`!`).
- Scheda completa: ID Vinted, titolo, descrizione, prezzo, marca, categoria, taglia, colore, condizioni, link, date, più i dati tecnici originali.
- Tutte le foto alla massima risoluzione disponibile, con miniature generate in locale.
- Nessun doppione: l'ID Vinted identifica l'annuncio.
- Annunci non tuoi: avviso, conferma e sezione separata «Annunci non miei».

### Importazione
- Dall'armadio, con anteprima e scelta degli annunci; «solo i nuovi» e «solo attivi».
- Ripresa dopo un'interruzione senza perdere il già salvato; cronologia con l'esito di ogni annuncio.
- Da un backup JSON o ZIP di un'altra installazione, unendo senza doppioni.

### Archivio
- Griglia e lista, ricerca, filtri per marca, categoria, taglia, colore, condizioni e prezzo, filtri salvati, ordinamento.
- Selezione multipla con azioni di gruppo, preferiti, collezioni, «Aggiunti di recente».
- Modifica della copia archiviata senza toccare l'originale, note private, campi personalizzati.
- Cronologia delle versioni (ultime 30) e ritorno ai dati originali.
- Cestino con ripristino entro 30 giorni.

### Controlli
- «Aggiorna da Vinted»: differenze campo per campo, si applica solo ciò che spunti.
- «Il link funziona ancora?» con l'etichetta «Non più online».
- Integrità delle foto, con riscaricamento di quelle mancanti o rovinate.
- Annunci simili: stessa foto o stesso titolo con ID diverso.

### Riutilizzo
- «Prepara»: copia modificabile, modelli di descrizione con segnaposto, copia rapida, ZIP delle foto.
- Esportazione nel formato `vintory-relist` per Vinted_Relist.

### Backup
- Backup completo in ZIP e ripristino su una nuova installazione.
- Promemoria, backup automatico (cartella Download o cartella scelta), esportazione CSV ed Excel.
- Indicatore dello spazio occupato e archiviazione permanente.

### Progetto
- «Cerca aggiornamento» con download dello zip, verifica dell'impronta e ricarica.
- Collegamenti Ko-fi e Discord aggiornabili da `links.json`, senza nuova versione.
- Statistiche, tema chiaro e scuro, pagina Salute con report diagnostico senza dati personali.
- Sola lettura garantita da una lista chiusa di richieste ammesse verso Vinted.
