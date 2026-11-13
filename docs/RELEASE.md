# Rilascio

## Prima di rilasciare

1. Aggiorna la versione (`x.y.z`) in **quattro** posti: `manifest.json`, `package.json`, `version.json`, `src/shared/constants.js` (`VERSION`).
2. Aggiorna `CHANGELOG.md` (sezione `## [x.y.z] - data`), il numero di versione nel `README.md`, e `date`, `zip` e `notes` in `version.json`.
3. `npm test` e `npm run test:e2e`.
4. `npm run package`: crea `dist/Vintory-x.y.z.zip`, lo copia nella radice del repository al posto del precedente, scrive la sua impronta in `version.json` e crea `dist/Vintory_GitHub.zip`.

`scripts/check.mjs` blocca tutto se le versioni non coincidono, se manca la sezione del changelog, se l'impronta in `version.json` non corrisponde allo zip o se nel codice compare una richiesta di scrittura verso Vinted.

## Pubblicare

1. Carica su `main` il contenuto di `Vintory_GitHub/`. Su GitHub cancella a mano lo zip della versione precedente dalla radice.
2. **Releases › Draft a new release**: tag `vx.y.z` su `main`, titolo `Vintory x.y.z`, descrizione con le novità.
3. **Publish release**: GitHub Actions esegue i test, allega lo zip e il suo `.sha256` e, se esiste il secret `DISCORD_WEBHOOK_URL`, annuncia la release su Discord.

«Cerca aggiornamento» legge `version.json` da `main` e scarica lo zip dalla radice del repository: funziona appena i file sono caricati, anche senza release.

## Cambiare un collegamento senza rilasciare

Modifica `links.json` su `main` (per esempio l'invito Discord) e aumenta `revision`. Le estensioni installate lo rileggono entro 12 ore, o subito con «Cerca aggiornamento».

## Segreti

| Nome | Obbligatorio | Uso |
|---|---|---|
| `GITHUB_TOKEN` | automatico | allegare i file alla release |
| `DISCORD_WEBHOOK_URL` | no | annuncio delle release su Discord |

Nessun segreto va nel repository: `scripts/check.mjs` lo controlla.

## Consegna

`Vintory_GitHub.zip` → cartella `Vintory_GitHub/` con tutti i file del repository e, nella radice, `Vintory-x.y.z.zip` → cartella `Vintory/` pronta per «Carica estensione non pacchettizzata».
