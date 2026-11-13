/** Esportazione per Vinted_Relist (formato «vintory-relist», schema 2): uno ZIP con uno o più annunci tuoi. */
import * as archive from "../shared/archive.js";
import { ZipWriter } from "../shared/zip.js";
import { relistEntry, relistPackage } from "../shared/model.js";
import { VERSION } from "../shared/constants.js";
import { safeName, extOf, dayStamp } from "../shared/util.js";
import { t, toast, saveBlob, progressDialog } from "./lib.js";

/**
 * listings: annunci dell'archivio. draft: copia modificata in «Prepara», non ancora salvata (stesso id).
 * Gli annunci di altri utenti non si esportano: Vinted_Relist ripubblica solo i tuoi.
 */
export async function exportForRelist(listings, { draft = null } = {}) {
  const mine = listings.filter((l) => l.owner === "mine" && !l.deletedAt);
  const skipped = listings.length - mine.length;
  if (!mine.length) { toast(t("Per Vinted_Relist si esportano solo i tuoi annunci."), "bad"); return null; }
  const p = mine.length > 1 ? progressDialog(t("Preparo l'esportazione per Vinted_Relist"), "") : null;
  try {
    const zip = new ZipWriter();
    const entries = [];
    for (const [k, l0] of mine.entries()) {
      const l = draft && draft.id === l0.id ? { ...l0, ...draft } : l0;
      const raw = await archive.getRaw(l.id);
      const photos = [];
      for (const img of await archive.getImages(l)) {
        if (!img.blob || img.status !== "ok") continue;
        const file = `photos/${l.vintedId}/${String(photos.length + 1).padStart(2, "0")}.${extOf(img.type)}`;
        await zip.add(file, img.blob);
        photos.push({ file, type: img.type, width: img.width, height: img.height, sha256: img.sha256 });
      }
      entries.push(relistEntry(l, raw, photos));
      p?.set(k + 1, mine.length, l.title);
    }
    await zip.add("vintory-relist.json", JSON.stringify(relistPackage(entries, VERSION), null, 2));
    const name = mine.length === 1 ? `${safeName(mine[0].title, 40)}-${mine[0].vintedId}-relist.zip` : `Vintory-per-Vinted_Relist-${dayStamp()}.zip`;
    saveBlob(zip.finish(), name);
    const noPhotos = entries.filter((e) => !e.photos.length).length;
    toast([t("Esportati {n} annunci per Vinted_Relist.", { n: entries.length }), skipped ? t("{n} non tuoi esclusi.", { n: skipped }) : "", noPhotos ? t("{n} senza foto.", { n: noPhotos }) : ""].filter(Boolean).join(" "), noPhotos ? "" : "good");
    return { count: entries.length, skipped };
  } catch (e) {
    toast(e.message, "bad");
    return null;
  } finally {
    p?.close();
  }
}
