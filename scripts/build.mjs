/**
 * Pacchetti.
 *   npm run build    → dist/Vintory-<versione>.zip (cartella «Vintory/» pronta per
 *                      «Carica estensione non pacchettizzata») + .sha256
 *   npm run package  → in più: copia lo zip nella radice del repository, scrive la sua
 *                      impronta in version.json e crea dist/Vintory_GitHub.zip
 *                      (cartella «Vintory_GitHub/» con tutti i file del repository).
 * Lo zip installabile contiene solo ciò che il browser carica, più licenza e istruzioni.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const github = process.argv.includes("--github");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
const version = manifest.version;
const INCLUDE = ["manifest.json", "icons", "src", "LICENSE", "README.md", "CHANGELOG.md"];
const SKIP = /(\.DS_Store|Thumbs\.db|\.map|\.log)$/;
const dist = path.join(ROOT, "dist");
const stage = path.join(dist, "Vintory");
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
for (const item of INCLUDE) {
  const from = path.join(ROOT, item);
  if (!fs.existsSync(from)) throw new Error(`Manca ${item}`);
  fs.cpSync(from, path.join(stage, item), { recursive: true, filter: (p) => !SKIP.test(p) });
}
const zipName = `Vintory-${version}.zip`;
const zipPath = path.join(dist, zipName);
execFileSync("zip", ["-r", "-X", "-q", zipPath, "Vintory"], { cwd: dist });
const listing = execFileSync("unzip", ["-Z1", zipPath], { encoding: "utf8" });
for (const must of ["Vintory/manifest.json", "Vintory/src/background/sw.js", "Vintory/src/content/guard.js", "Vintory/src/ui/dashboard.html", "Vintory/icons/icon128.png"]) {
  if (!listing.split("\n").includes(must)) throw new Error(`Lo zip non contiene ${must}`);
}
for (const mustNot of ["tests/", "node_modules", ".github", "scripts/", "docs/"]) if (listing.includes(`Vintory/${mustNot}`)) throw new Error(`Lo zip contiene ${mustNot}`);
const hash = crypto.createHash("sha256").update(fs.readFileSync(zipPath)).digest("hex");
fs.writeFileSync(`${zipPath}.sha256`, `${hash}  ${zipName}\n`);
const files = listing.split("\n").filter((l) => l && !l.endsWith("/")).length;
console.log(`✔ ${zipName} · ${files} file · ${(fs.statSync(zipPath).size / 1024).toFixed(0)} KB\n  SHA-256 ${hash}`);

if (github) {
  for (const f of fs.readdirSync(ROOT)) if (/^Vintory-\d+\.\d+\.\d+\.zip$/.test(f)) fs.rmSync(path.join(ROOT, f));
  fs.copyFileSync(zipPath, path.join(ROOT, zipName));
  const vPath = path.join(ROOT, "version.json");
  const v = JSON.parse(fs.readFileSync(vPath, "utf8"));
  v.sha256 = hash;
  fs.writeFileSync(vPath, `${JSON.stringify(v, null, 2)}\n`);
  const gh = path.join(dist, "Vintory_GitHub");
  fs.mkdirSync(gh, { recursive: true });
  const EXCLUDE = new Set(["node_modules", "dist", ".git"]);
  for (const f of fs.readdirSync(ROOT)) {
    if (EXCLUDE.has(f)) continue;
    fs.cpSync(path.join(ROOT, f), path.join(gh, f), { recursive: true, filter: (p) => !SKIP.test(p) && !/__pycache__|[\\/]artifacts([\\/]|$)/.test(p) });
  }
  const ghZip = path.join(dist, "Vintory_GitHub.zip");
  execFileSync("zip", ["-r", "-X", "-q", ghZip, "Vintory_GitHub"], { cwd: dist });
  const ghList = execFileSync("unzip", ["-Z1", ghZip], { encoding: "utf8" }).split("\n");
  for (const must of [`Vintory_GitHub/${zipName}`, "Vintory_GitHub/manifest.json", "Vintory_GitHub/version.json", "Vintory_GitHub/links.json", "Vintory_GitHub/README.md"]) {
    if (!ghList.includes(must)) throw new Error(`Vintory_GitHub.zip non contiene ${must}`);
  }
  console.log(`✔ Vintory_GitHub.zip · ${ghList.filter((l) => l && !l.endsWith("/")).length} file · ${(fs.statSync(ghZip).size / 1024).toFixed(0)} KB`);
}
