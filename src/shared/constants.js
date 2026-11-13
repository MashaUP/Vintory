/** Costanti condivise. La versione qui deve coincidere con manifest, package e version.json (scripts/check.mjs). */
export const VERSION = "1.1.0";
export const REPO = "MashaUP/Vintory";
export const APP = "Vintory";

export const VINTED_DOMAINS = [
  "vinted.it", "vinted.fr", "vinted.es", "vinted.de", "vinted.co.uk", "vinted.com", "vinted.be", "vinted.nl",
  "vinted.at", "vinted.pt", "vinted.pl", "vinted.cz", "vinted.sk", "vinted.lt", "vinted.lu", "vinted.ro", "vinted.hu",
];
export const isVintedOrigin = (origin) => VINTED_DOMAINS.some((d) => origin === `https://www.${d}`);

export const DB_NAME = "vintory";
export const DB_VERSION = 1;
export const BACKUP_FORMAT = "vintory-backup";
export const BACKUP_SCHEMA = 1;
export const RELIST_FORMAT = "vintory-relist";
export const TRASH_DAYS = 30;
export const MAX_VERSIONS = 30;
export const THUMB_SIDE = 360;
export const PHOTO_TIMEOUT_MS = 60_000;
export const UPDATE_EVERY_MIN = 12 * 60;

export const DEFAULT_LINKS = {
  github: { url: "https://github.com/MashaUP/Vintory", label: "GitHub" },
  discord: { url: "https://discord.gg/EPsbQCuAkx", label: "Discord" },
  kofi: { url: "https://ko-fi.com/mashaup", label: "Ko-fi" },
  documentation: { url: "https://github.com/MashaUP/Vintory#readme", label: "Guida" },
  changelog: { url: "https://github.com/MashaUP/Vintory/blob/main/CHANGELOG.md", label: "Novità" },
  bugReport: { url: "https://github.com/MashaUP/Vintory/issues/new", label: "Segnala un problema" },
};
/** Domini ammessi per i link che arrivano da links.json. */
export const LINK_HOSTS = ["github.com", "discord.gg", "discord.com", "ko-fi.com"];

export const DEFAULT_SETTINGS = {
  schema: 1,
  theme: "auto",                 // auto | light | dark
  lang: "it",
  view: "grid",                  // grid | list
  sort: "savedAt:desc",
  pageButton: true,              // pulsante nella pagina dell'annuncio
  checkChanges: true,            // confronto con l'archivio quando apri un annuncio salvato
  importDelay: { min: 1200, max: 2500 },   // pausa tra un annuncio e l'altro nell'importazione (ms)
  onlyActive: true,              // importa solo gli annunci attivi
  customFields: ["Costo d'acquisto", "Misure", "Peso del pacco"],
  backup: {
    remindDays: 7,               // 0 = mai
    auto: "off",                 // off | downloads | folder
    autoDays: 7,
    keep: 5,
    lastAt: null,
    lastAutoAt: null,
    lastName: null,
    lastRemindedAt: null,
    downloadIds: [],
  },
  updates: { auto: true, repo: REPO, lastNotified: null },
  links: { autoRefresh: true },
};

export const CONDITION_BY_STATUS_ID = {
  6: "Nuovo con cartellino",
  1: "Nuovo senza cartellino",
  2: "Ottime",
  3: "Buone",
  4: "Soddisfacenti",
};

export const FIELD_LABELS = {
  title: "Titolo", description: "Descrizione", price: "Prezzo", brand: "Marca", category: "Categoria",
  size: "Taglia", colors: "Colore", condition: "Condizioni", photos: "Foto", state: "Stato su Vinted",
};
