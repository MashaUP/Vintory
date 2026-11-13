# Novità

Il formato segue [Keep a Changelog](https://keepachangelog.com/it/1.1.0/) e le versioni seguono [Semantic Versioning](https://semver.org/lang/it/).

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
