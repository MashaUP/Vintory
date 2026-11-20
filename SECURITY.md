# Sicurezza e riservatezza

## Cosa fa Vintory con i tuoi dati

- **Dove stanno:** nel database del browser (IndexedDB) e in `chrome.storage`, sul tuo computer. Nessun server, nessun account, nessuna statistica d'uso.
- **Richieste verso l'esterno:**
  - Vinted, dalla tua scheda già aperta, **solo in lettura**;
  - il CDN delle foto di Vinted (`*.vinted.net`), per scaricare le foto degli annunci che salvi;
  - GitHub (`raw.githubusercontent.com`, `github.com`), per `version.json`, `links.json` e lo zip degli aggiornamenti.
- **Account Vinted:** Vintory legge solo l'id numerico dell'utente dal cookie, per distinguere i tuoi annunci da quelli di altri. Non legge né salva password, token o codici di verifica. I token che Vinted usa nelle sue richieste restano nella memoria di sessione del browser, mai su disco e mai nei backup.

## Sola lettura

Ogni richiesta a Vinted passa da `src/content/guard.js`: una lista chiusa (quattro percorsi delle API e la pagina pubblica dell'annuncio), solo con il metodo GET. Pubblicare, modificare, eliminare, mettere like, fare offerte, scrivere messaggi e comprare sono impossibili per costruzione. I test unitari controllano la lista e `scripts/check.mjs` blocca il rilascio se nel codice compare una richiesta di scrittura.

Vintory non aggira CAPTCHA, errori 403 o limiti 429: si ferma e lo dice.

## Permessi

| Permesso | Perché |
|---|---|
| `storage`, `unlimitedStorage` | impostazioni e archivio con le foto |
| `tabs`, `scripting` | riconoscere la pagina di Vinted aperta e parlarci |
| `cookies` | leggere l'id del tuo utente Vinted |
| `webRequest` | osservare (senza modificare) le intestazioni che Vinted usa per le sue richieste |
| `downloads` | salvare backup e aggiornamenti |
| `alarms`, `notifications` | controllo degli aggiornamenti, promemoria del backup |
| `identity` + `googleapis.com` | solo se attivi il backup su Google Drive: accesso con il tuo Client ID, permesso `drive.appdata` (Vintory vede solo i propri file nel tuo Drive) |

## Backup e file importati

I backup ZIP sul computer non sono cifrati: contengono i tuoi annunci e le foto, conservali come faresti con qualsiasi file personale.

I backup su **Google Drive** sono cifrati prima di partire: AES-GCM a 256 bit con una chiave ricavata dalla tua password (PBKDF2-SHA256, 600 000 iterazioni, sale casuale), a blocchi da 4 MiB autenticati uno per uno. La password non va mai a Google né nei backup; se scegli di ricordarla, resta solo in questo browser (`chrome.storage.local`). Il token di accesso a Google resta nella sessione del browser e sparisce chiudendolo. Né la password né il token né il Client ID finiscono nel report diagnostico. Un backup importato viene controllato: i dati sono trattati come testo, i link non `https` vengono scartati.

## Segnalare un problema

Usa «Segnala un problema» in Impostazioni (apre il modulo su https://github.com/MashaUP/Vintory/issues) oppure scrivi sul Discord del progetto. Per un problema di sicurezza, non pubblicare i dettagli: chiedi prima un contatto privato.
