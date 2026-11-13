/**
 * Controlli prima dei test e della release: versioni allineate, domini allineati,
 * file del manifest presenti, sintassi di tutti i file JS, JSON validi, nessun
 * segreto nel repository, sola lettura (nessuna richiesta di scrittura verso Vinted),
 * impronta dello zip dichiarata in version.json.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const errors = [];
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const json = (p) => { try { return JSON.parse(read(p)); } catch (e) { errors.push(`${p}: JSON non valido (${e.message})`); return {}; } };

const manifest = json("manifest.json");
const pkg = json("package.json");
const versionJson = json("version.json");
const links = json("links.json");
const constants = read("src/shared/constants.js");
const constVersion = constants.match(/export const VERSION = "([^"]+)"/)?.[1];
const versions = { manifest: manifest.version, "package.json": pkg.version, "version.json": versionJson.version, "constants.js": constVersion };
if (new Set(Object.values(versions)).size !== 1) errors.push(`Versioni non allineate: ${JSON.stringify(versions)}`);
if (!/^\d+\.\d+\.\d+$/.test(manifest.version || "")) errors.push(`Versione del manifest non semver: ${manifest.version}`);
const tag = process.env.RELEASE_TAG;
if (tag && tag.replace(/^v/, "") !== manifest.version) errors.push(`Il tag ${tag} non corrisponde alla versione ${manifest.version}`);
if (!read("CHANGELOG.md").includes(`[${manifest.version}]`)) errors.push(`CHANGELOG.md non ha la sezione [${manifest.version}]`);
if (!read("README.md").includes(manifest.version)) errors.push(`README.md non cita la versione ${manifest.version}`);
if (versionJson.zip !== `Vintory-${manifest.version}.zip`) errors.push(`version.json: zip deve essere Vintory-${manifest.version}.zip`);
const rootZip = path.join(ROOT, `Vintory-${manifest.version}.zip`);
if (fs.existsSync(rootZip) && versionJson.sha256) {
  const hash = crypto.createHash("sha256").update(fs.readFileSync(rootZip)).digest("hex");
  if (hash !== versionJson.sha256) errors.push("version.json: sha256 non corrisponde allo zip nella radice (rilancia npm run package)");
}
for (const k of ["kofi", "discord", "github"]) if (!/^https:\/\//.test(links.links?.[k]?.url || "")) errors.push(`links.json: manca il link ${k}`);

const domains = [...constants.matchAll(/"(vinted\.[a-z.]+)"/g)].map((m) => `https://www.${m[1]}/*`).sort();
const csMatches = [...(manifest.content_scripts?.[0]?.matches || [])].sort();
if (JSON.stringify(domains) !== JSON.stringify(csMatches)) errors.push("I domini di constants.js e del manifest (content_scripts) non coincidono");
for (const d of csMatches) if (!manifest.host_permissions.includes(d)) errors.push(`host_permissions senza ${d}`);

const refs = [manifest.background?.service_worker, manifest.action?.default_popup, manifest.options_page?.split("#")[0],
  ...Object.values(manifest.icons || {}), ...(manifest.content_scripts || []).flatMap((c) => [...(c.js || []), ...(c.css || [])])];
for (const r of refs.filter(Boolean)) if (!fs.existsSync(path.join(ROOT, r))) errors.push(`File del manifest mancante: ${r}`);

function walk(dir, out = []) {
  for (const f of fs.readdirSync(dir)) {
    if (["node_modules", ".git", "dist"].includes(f)) continue;
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}
const all = walk(ROOT);
const src = all.filter((x) => x.endsWith(".js") && x.includes(`${path.sep}src${path.sep}`));
for (const f of src) {
  const code = fs.readFileSync(f, "utf8");
  const isModule = /^\s*(import|export)\s/m.test(code);
  try { execFileSync(process.execPath, isModule ? ["--input-type=module", "--check"] : ["--check", f], { input: isModule ? code : undefined, stdio: ["pipe", "pipe", "pipe"] }); }
  catch (e) { errors.push(`Sintassi: ${path.relative(ROOT, f)}\n${String(e.stderr).split("\n").slice(0, 5).join("\n")}`); }
  // Import relativi: il file deve esistere (un percorso sbagliato si scopre solo aprendo la pagina).
  for (const m of code.matchAll(/(?:from|import)\s*\(?\s*"(\.{1,2}\/[^"]+)"/g)) {
    if (!fs.existsSync(path.resolve(path.dirname(f), m[1]))) errors.push(`Import mancante in ${path.relative(ROOT, f)}: ${m[1]}`);
  }
  // Sola lettura: nessun file dell'estensione può fare richieste di scrittura.
  if (/method:\s*["'](POST|PUT|PATCH|DELETE)["']/i.test(code)) errors.push(`Richiesta di scrittura in ${path.relative(ROOT, f)}: Vintory è in sola lettura`);
  if (/\binnerHTML\b|\bouterHTML\b|insertAdjacentHTML|document\.write\b|\beval\(/.test(code)) errors.push(`HTML o codice da stringa in ${path.relative(ROOT, f)}: usare il DOM`);
}
for (const f of all.filter((x) => x.endsWith(".html") && x.includes(`${path.sep}src${path.sep}`))) {
  const html = fs.readFileSync(f, "utf8");
  for (const m of html.matchAll(/(?:src|href)="([^"#:]+)"/g)) if (!fs.existsSync(path.resolve(path.dirname(f), m[1]))) errors.push(`Risorsa mancante in ${path.relative(ROOT, f)}: ${m[1]}`);
}
const SECRETS = [/discord(?:app)?\.com\/api\/webhooks\/\d{6,}\/[\w-]{20,}/, /\bghp_[A-Za-z0-9]{30,}/, /\bsk-[A-Za-z0-9]{32,}/, /access_token_web=eyJ[A-Za-z0-9_-]{40,}/];
for (const f of all.filter((x) => /\.(js|mjs|json|md|yml|yaml|html|txt|py)$/.test(x) && !x.endsWith("check.mjs"))) {
  const s = fs.readFileSync(f, "utf8");
  for (const re of SECRETS) if (re.test(s)) errors.push(`Possibile segreto in ${path.relative(ROOT, f)} (${re})`);
}

if (errors.length) { console.error(`✖ ${errors.length} problemi:\n- ${errors.join("\n- ")}`); process.exit(1); }
console.log(`✔ check: versione ${manifest.version}, ${csMatches.length} domini, ${refs.length} file del manifest, ${src.length} sorgenti, ${all.length} file controllati`);
