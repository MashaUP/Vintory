# Novità

Il formato segue [Keep a Changelog](https://keepachangelog.com/it/1.1.0/) e le versioni seguono [Semantic Versioning](https://semver.org/lang/it/).

## [1.2.2] - 2026-11-20

PATCH: allineamento agli standard comuni dei progetti, senza funzioni nuove per l'archivio.

### Nuovo
- In Impostazioni, accanto agli altri collegamenti: **«Segnala un problema»** e **«Proponi un'idea»**. Aprono su GitHub un modulo guidato che chiede versione, browser e report diagnostico (`.github/ISSUE_TEMPLATE/bug.yml` e `idea.yml`).

### Cambiato
- `links.json`: la chiave `bugReport` diventa `bugs` (modello `bug.yml`) e si aggiunge `ideas` (modello `idea.yml`). `bugReport` resta accettato come vecchio nome di `bugs`; se ci sono tutti e due vince `bugs`. Le versioni già installate continuano a mostrare il loro link di serie.
- Sviluppo: ESLint (`npm run lint`, con `no-undef` e `no-unused-vars`) fa parte di `npm test` e quindi della CI e della release. `scripts/check.mjs` controlla anche che le chiavi di `links.json` siano in minuscolo e che `bugs` e `ideas` aprano modelli esistenti.

### Corretto
- Codice morto trovato da ESLint, senza effetti visibili: un import e una costante inutilizzati nel controllo dell'armadio, un parametro inutilizzato nel service worker e nella cronologia delle importazioni. Il segno BOM all'inizio dei CSV ora è scritto come `\uFEFF` invece che come carattere invisibile (stesso file in uscita).

## [1.2.1] - 2026-11-20

### Corretto
- «Scarica e installa l'aggiornamento» salvava il file come `download.zip`. Ora lo zip, dopo il controllo dell'impronta, si scarica dall'indirizzo di GitHub come fa Vinted_Relist e si chiama `Vintory-x.y.z.zip` (in Download/Vintory).

## [1.2.0] - 2026-11-20

### Nuovo
- **«Controlla il mio armadio»** (barra laterale, archivio e popup): legge l'elenco del tuo armadio da Vinted, in sola lettura e solo quando lo chiedi, e lo confronta con l'archivio.
  - **Nuovi da salvare:** annunci attivi che non sono in archivio. Si salvano con «Salva i selezionati», che usa la solita importazione riprendibile.
  - **Venduti:** segnati così nell'archivio.
  - **Spariti:** verificati uno alla volta, con le pause dell'importazione, e segnati «venduti» o «non più online».
  - **Modificati su Vinted:** titolo, prezzo o prima foto cambiati rispetto all'ultima lettura, non rispetto alle tue modifiche in Vintory. Hanno il segnale «modificato» e il pulsante «Rivedi».
  - **Tornati:** annunci segnati come spariti che sono di nuovo nell'armadio tornano «online».
  - Se Vinted dà solo gli annunci visibili nella pagina e non l'elenco completo, il controllo si ferma invece di segnare per sbaglio annunci come spariti.
- **Backup su Google Drive** (Backup › Google Drive): backup completo, **cifrato con una tua password** (AES-GCM, chiave PBKDF2-SHA256 da 600 000 iterazioni, a blocchi da 4 MiB), nella cartella nascosta di Vintory sul tuo Drive (permesso `drive.appdata`: Vintory vede solo i propri file). Caricamento a pezzi da 8 MiB che si riprovano da soli. Tiene gli ultimi N backup.
  - Stesso metodo di BingeMap: Client ID OAuth di tipo «Applicazione web», con la guida e l'indirizzo di ritorno da copiare nella pagina.
  - La password si può ricordare solo su questo computer; non va mai a Google né nei backup. Il token di accesso resta solo nella sessione del browser.
  - Backup automatico anche su Drive, all'apertura della dashboard.
- **Ripristino da Google Drive** su un altro computer: elenco dei backup con data, computer di provenienza e numero di annunci; «Ripristina» scarica, chiede la password e poi offre «Unisci» o «Sostituisci».
- **Dopo la pubblicazione:** quando Vinted apre la pagina di un annuncio appena pubblicato, Vintory propone di salvarlo. In Impostazioni puoi scegliere «Salvalo da solo» o «Non fare niente». Dopo la modifica di un annuncio già salvato, propone di aggiornare la copia.

### Migliorato
- Report diagnostico: righe per Google Drive (mai token o Client ID) e per il controllo dell'armadio.
- Le schede di Vinted aperte da Vintory hanno un limite di tempo con un secondo tentativo: un browser che non risponde all'apertura di una scheda non blocca più il completamento delle categorie. Il riepilogo «Categorie» registra anche il passo in corso.

## [1.1.1] - 2026-11-13

### Corretto
- **«Completa i dati mancanti» non trovava nessuna categoria** sul Vinted vero (0 su 18). Nel testo della pagina scaricata il percorso della categoria non c'è: Vinted lo disegna con JavaScript dopo il caricamento. Ora, se nel testo non c'è, Vintory apre l'annuncio in **una sola scheda in secondo piano**, riusata per tutte le categorie e chiusa alla fine, e aspetta che la pagina disegni il percorso (fino a 12 secondi). Se la pagina aperta funziona e il testo no, il testo si salta per le categorie successive.
- Riconosciuti anche i link alla categoria nella forma `?catalog[]=<numero>`. Come ultima risorsa il nome si ricava dall'indirizzo della categoria scritto nella pagina (`/catalog/2319-libri` → «Libri»), solo per l'ultima voce del percorso.
- Le schede di Vinted aperte da Vintory nascono vuote e poi caricano l'indirizzo: il caricamento parte quando la scheda esiste già.
- Il completamento usa una sua scheda in secondo piano invece di quelle di Vinted aperte da te: una tua scheda bloccata poteva farlo restare in attesa per sempre.
- Ogni richiesta a una scheda di Vinted ha un limite di tempo (45–90 secondi, come in Vinted_Relist): una scheda che non risponde non ferma più Vintory.

### Migliorato
- **Barra di avanzamento** durante il completamento, con la categoria in corso.
- L'avviso nell'archivio si può nascondere con **«Non ora»**: ricompare solo se gli annunci senza categoria aumentano.
- Se nessuna categoria viene trovata, il messaggio lo dice e chiede il report diagnostico.
- Il report diagnostico ha la riga **«Categorie»**: quante trovate, dal testo o dalla pagina aperta, e quanti link e indirizzi di categoria c'erano (solo conteggi).

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
