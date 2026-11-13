# Ponte Vintory → Vinted_Relist

Formato con cui Vintory passa a Vinted_Relist gli annunci archiviati, perché Vinted_Relist possa ripubblicarli anche quando su Vinted non esistono più. Vintory resta in sola lettura: scrive solo questo file, e la pubblicazione la fa Vinted_Relist.

- Nome del formato: `vintory-relist`
- Versione dello schema: **2** (da Vintory 1.1.0)
- Dove si crea in Vintory: scheda di un annuncio › **Per Vinted_Relist**, «Prepara» › **Esporta per Vinted_Relist**, oppure barra di selezione › **Per Vinted_Relist**. Si esportano solo i propri annunci.

## Lo ZIP

```
<titolo>-<id>-relist.zip            (un annuncio)
Vintory-per-Vinted_Relist-<data>.zip (più annunci)
├── vintory-relist.json
└── photos/
    └── <vintedId>/
        ├── 01.jpg
        ├── 02.jpg
        └── …
```

- File «stored» (non compressi), nomi in UTF-8, niente ZIP64: al massimo 4 GB e 65 535 file.
- Le foto sono gli originali scaricati da Vinted alla risoluzione più alta disponibile (`full_size_url`), nell'ordine dell'annuncio. Le foto mancanti o rovinate nell'archivio non sono incluse: vedi `photosMissing`.
- L'estensione segue il tipo (`jpg`, `png`, `webp`).

## `vintory-relist.json`

```json
{
  "format": "vintory-relist",
  "schema": 2,
  "app": "Vintory 1.1.0",
  "exportedAt": "2026-11-13T22:40:00.000Z",
  "count": 1,
  "listings": [
    {
      "vintedId": "5123456789",
      "url": "https://www.vinted.it/items/5123456789-the-atlas-six",
      "origin": "https://www.vinted.it",
      "sellerId": "129315368",
      "online": "offline",
      "onlineCheckedAt": 1794607081275,
      "savedAt": 1794606976720,
      "publishedAt": 1793000000000,

      "title": "The Atlas Six - Olivie Blake (Lingua Inglese, Edizione UK)",
      "description": "…",
      "price": 4,
      "currency": "EUR",
      "brand": null,
      "category": "Intrattenimento › Libri",
      "size": null,
      "colors": [],
      "condition": "Ottime",
      "ids": { "brandId": null, "catalogId": "2319", "sizeId": null, "statusId": "2", "colorIds": [] },
      "extra": { "author": "Olivie Blake", "isbn": "9781529095258" },
      "editedFields": ["price"],

      "photos": [
        { "file": "photos/5123456789/01.jpg", "type": "image/jpeg", "width": 1205, "height": 1600, "sha256": "3f…64 caratteri" }
      ],
      "photosMissing": 0,

      "uploadDraft": { "id": 5123456789, "title": "…", "catalog_id": 2319, "brand_id": null, "item_attributes": [{ "code": "condition", "ids": [2] }], "isbn": "9781529095258", "package_size_id": 1, "photos": [ … ], "…": "…" },
      "uploadDraftAt": 1794606976720
    }
  ]
}
```

### Campi

| Campo | Significato |
|---|---|
| `vintedId`, `url`, `origin` | annuncio originale. `origin` è il dominio di Vinted (`https://www.vinted.it`, …). |
| `sellerId` | id dell'utente Vinted proprietario, letto dal cookie al salvataggio. Vinted_Relist deve confrontarlo con l'account collegato e rifiutare se diverso. |
| `online` | ultimo stato noto: `online`, `sold`, `offline` (pagina non più esistente), `unknown` o `null`. **È solo un'indicazione**: va ricontrollato su Vinted prima di pubblicare. |
| `onlineCheckedAt`, `savedAt`, `publishedAt` | millisecondi Unix, o `null`. |
| `title`, `description`, `price`, `currency` | **la copia di Vintory**, eventualmente modificata a mano dall'utente (anche da «Prepara» senza salvare). Questi valori vincono su `uploadDraft`. |
| `brand`, `category`, `size`, `colors`, `condition` | nomi leggibili, per mostrarli. Per pubblicare servono gli id in `ids` o in `uploadDraft`. |
| `ids` | `brandId`, `catalogId`, `sizeId`, `statusId` (stringhe o `null`), `colorIds` (stringhe). Ricavati da `uploadDraft` o dalle altre letture. |
| `extra` | solo se presenti: `author`, `bookTitle`, `isbn`, `manufacturer`, `model`, `measures`. |
| `editedFields` | campi cambiati a mano in Vintory (`title`, `description`, `price`, `brand`, `category`, `size`, `colors`, `condition`). |
| `photos` | in ordine. `file` è il percorso nello ZIP; `sha256` permette di verificare che il file non sia rovinato. |
| `photosMissing` | foto dell'annuncio che non sono nello ZIP. |
| `uploadDraft` | risposta di Vinted a `GET /api/v2/item_upload/items/:id`, così com'è: l'ultima letta (dopo «Aggiorna da Vinted»), altrimenti quella del salvataggio. `null` se Vintory non l'ha mai letta. |
| `uploadDraftAt` | quando è stata letta `uploadDraft`. |

### Come costruire l'annuncio nuovo

1. Partire da `uploadDraft` (ha già gli id di categoria, marca, taglia, colori, `item_attributes`, `package_size_id`, ISBN…).
2. Sovrascrivere `title`, `description` e `price` con i valori in cima all'annuncio.
3. Se `editedFields` contiene `brand`, `size`, `colors`, `condition` o `category`, il nome è cambiato ma l'id in `uploadDraft` no: avvisare l'utente invece di indovinare l'id.
4. Caricare le foto dai file dello ZIP, nell'ordine di `photos`, controllando `sha256`.
5. Togliere da `uploadDraft` i campi che appartengono all'annuncio vecchio (`id`, `photos`, contatori, stato) come già fa Vinted_Relist con la propria bozza.

### Compatibilità

- Un lettore deve rifiutare `format` diverso e `schema` maggiore di quello che conosce, con un messaggio che inviti ad aggiornare.
- Campi sconosciuti vanno ignorati: le versioni future di Vintory potranno aggiungerne senza cambiare `schema`.
- Lo schema 1 (Vintory 1.0.x: `relist.json`, un annuncio, `listing` + `photos` come elenco di nomi) non è più prodotto.

## Alternativa: il backup completo

Anche il backup ZIP di Vintory (`Vintory-backup-<data>.zip`, formato `vintory-backup` schema 1) contiene tutto: `vintory.json` con `listings`, `raw[].bundle.upload` (e `raw[].latest.bundle.upload`), `images[]` con `file` → `images/<id>.<ext>` e l'ordine in `listings[].imageIds`. È un formato interno di Vintory e può cambiare: per Vinted_Relist conviene `vintory-relist`.
