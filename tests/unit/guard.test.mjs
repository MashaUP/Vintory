import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import "../../src/content/guard.js";

const { assertAllowed } = globalThis.VYGuard;
const ROOT = path.resolve(import.meta.dirname, "../..");

test("sola lettura: passano solo le GET previste", () => {
  for (const p of ["/items/123", "/items/123/details", "/item_upload/items/123", "/wardrobe/77/items?page=2&per_page=96&order=newest_first"]) assert.equal(assertAllowed("GET", p), true, p);
  assert.equal(assertAllowed("get", "/items/1"), true);
  assert.equal(assertAllowed("GET", "/items/123", "page"), true);
  for (const p of ["/items/123/edit", "/items/new", "/member/1", "/inbox", "/checkout", "/items/123/details", "/"]) assert.throws(() => assertAllowed("GET", p, "page"), /rifiutata/, p);
  assert.throws(() => assertAllowed("POST", "/items/123", "page"), /sola lettura/);
  assert.throws(() => assertAllowed("GET", "/items/123", "altro"), /rifiutata/);
});

test("qualsiasi scrittura viene rifiutata", () => {
  for (const m of ["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) assert.throws(() => assertAllowed(m, "/items/123"), /sola lettura/, m);
});

test("percorsi non previsti rifiutati: like, offerte, messaggi, acquisti, modifica, eliminazione", () => {
  const bad = ["/items/123/delete", "/items/123/favourite", "/item_upload/items", "/item_upload/items/123/edit", "/transactions/1/checkout", "/conversations", "/users/1", "/offers",
    "/user_favourites/toggle", "/items/123?x=1", "/items/abc", "/wardrobe/77/items?page=1&per_page=96&order=newest_first&x=1", "/items/1/../../users", "//evil.example/items/1", "", null, undefined, 5];
  for (const p of bad) assert.throws(() => assertAllowed("GET", p), /rifiutata/, String(p));
});

test("nel codice dell'estensione ogni richiesta a Vinted passa dalla guardia", () => {
  const vinted = fs.readFileSync(path.join(ROOT, "src/content/vinted.js"), "utf8");
  assert.equal((vinted.match(/\bfetch\(/g) || []).length, 1, "un solo fetch in vinted.js");
  const getFn = vinted.slice(vinted.indexOf("async function request("), vinted.indexOf("const MESSAGES"));
  assert.ok(getFn.indexOf("VYGuard.assertAllowed") < getFn.indexOf("fetch("), "la guardia viene prima del fetch");
  assert.ok(!/\bfetch\(/.test(fs.readFileSync(path.join(ROOT, "src/content/content.js"), "utf8")), "nessun fetch in content.js");
  const sw = fs.readFileSync(path.join(ROOT, "src/background/sw.js"), "utf8");
  assert.ok(!/\bfetch\(/.test(sw), "il service worker non chiama Vinted direttamente");
});

test("i content script del manifest caricano la guardia per prima", () => {
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
  assert.equal(m.content_scripts[0].js[0], "src/content/guard.js");
  assert.ok(!m.permissions.includes("declarativeNetRequest"));
});
