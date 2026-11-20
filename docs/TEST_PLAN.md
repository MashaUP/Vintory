# Piano di prova

## Automatico

| Comando | Cosa prova |
|---|---|
| `npm test` | controlli (`scripts/check.mjs`) e 50 test unitari: modello, controllo dell'armadio, cifratura dei backup, ZIP ed Excel, guardia di sola lettura, aggiornamenti e link, archivio e backup su IndexedDB simulato |
| `npm run test:e2e` | 27 scenari in Chrome reale con l'estensione caricata, contro un Vinted simulato (`tests/e2e/fake_vinted.py`) e un Google Drive simulato (`tests/e2e/fake_google.py`) |

Scenari end-to-end: salvataggio dalla pagina · nessun duplicato · annuncio non mio · CAPTCHA e foto non scaricabili · importazione dall'armadio · importazione fermata da Vinted e ripresa · importazione interrotta dalla chiusura · ricerca, filtri, ordinamento, viste · selezione, preferiti, collezioni, cestino · scheda, modifica, note, versioni · aggiornamento da Vinted · annuncio non più online · modelli, Prepara, Vinted_Relist · CSV ed Excel · integrità delle foto · backup e ripristino su una nuova installazione · aggiornamenti e collegamenti · simili, statistiche, impostazioni, tema · cestino scaduto, backup automatico, spazio · cartella sovrascritta e «Installa l'aggiornamento» · Vinted reale: token CSRF e 403 · dati reali e completamento · controllo dell'armadio · backup su Google Drive e ripristino su un'altra installazione · domanda dopo la pubblicazione · persistenza dopo il riavvio del browser · sola lettura e assenza di errori.

Risultato alla 1.2.1: 50/50 e 27/27 (tre giri di fila).

## Non coperto dalle prove automatiche

- **Vinted reale**: formati delle risposte, struttura della pagina, limiti del sito.
- Edge e Brave (le prove girano in Chrome).
- Backup automatico in una cartella scelta (richiede la finestra di scelta del sistema).
- Notifiche di sistema (promemoria del backup, nuova versione).
- GitHub Actions.
- **Google vero**: la finestra di accesso, il tuo Client ID e l'indirizzo di ritorno (nelle prove l'accesso è simulato e il Drive è finto).
- La vera pagina di Vinted dopo la pubblicazione (nelle prove: da `/items/new` alla pagina dell'annuncio).
- Archivi molto grandi (migliaia di annunci).

## Prova a mano su Vinted reale

Da fare con un solo annuncio alla volta.

1. Apri un tuo annuncio: compare «Salva in Vintory» in basso a sinistra e il badge `+`.
2. Salva: il pulsante diventa «Salvato in Vintory», il badge `✓`.
3. Apri la scheda in Vintory: controlla titolo, descrizione, prezzo, marca, taglia, colore, condizioni, categoria e il numero di foto.
4. In «Dati tecnici» guarda le «Fonti lette»: per un tuo annuncio dovrebbero esserci «modulo di vendita» e «scheda».
5. Chiudi del tutto il browser, riaprilo: l'annuncio c'è ancora con tutte le foto.
6. Apri un annuncio non tuo e salvalo: deve chiedere conferma e finire in «Annunci non miei».
7. Dal tuo armadio premi «Importa il mio armadio», scegli 3 annunci e importali.
8. Modifica il prezzo di un annuncio su Vinted, riaprilo: il badge diventa `!`; «Rivedi» mostra la differenza.
9. Fai un backup, poi importalo in un altro profilo del browser con «Sostituisci».
10. Premi «Cerca aggiornamento».

Se un passo non va, copia il report da **Impostazioni › Salute › Copia il report diagnostico**.
