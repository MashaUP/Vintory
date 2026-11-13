import test from "node:test";
import assert from "node:assert/strict";

globalThis.chrome = { storage: { local: { get: async () => ({}), set: async () => {} } } };
const U = await import("../../src/shared/updates.js");

test("version.json: versione più recente, uguale, più vecchia, non valida", () => {
  const a = U.parseVersionFile({ version: "1.2.0", zip: "Vintory-1.2.0.zip", sha256: "A".repeat(64), notes: ["uno", 2], date: "2026-12-01T10:00" }, "1.0.0");
  assert.equal(a.ok, true);
  assert.equal(a.available, true);
  assert.equal(a.zip, "Vintory-1.2.0.zip");
  assert.equal(a.sha256, "a".repeat(64));
  assert.deepEqual(a.notes, ["uno", "2"]);
  assert.equal(a.date, "2026-12-01");
  assert.equal(U.parseVersionFile({ version: "1.0.0" }, "1.0.0").available, false);
  assert.equal(U.parseVersionFile({ version: "0.9.0" }, "1.0.0").available, false);
  assert.equal(U.parseVersionFile({ version: "abc" }, "1.0.0").ok, false);
  assert.equal(U.parseVersionFile({}, "1.0.0").ok, false);
});

test("version.json: un nome di zip sospetto o un'impronta non valida vengono ignorati", () => {
  const a = U.parseVersionFile({ version: "2.0.0", zip: "../../evil.zip", sha256: "xyz" }, "1.0.0");
  assert.equal(a.zip, null);
  assert.equal(a.sha256, null);
  assert.equal(U.parseVersionFile({ version: "2.0.0", zip: "https://evil.example/a.zip" }, "1.0.0").zip, null);
});

test("links.json: solo https verso domini noti; il resto resta quello di serie", () => {
  const l = U.parseLinks({ links: {
    discord: { url: "https://discord.gg/NUOVO", label: "Discord" },
    kofi: { url: "http://ko-fi.com/mashaup" },
    github: { url: "javascript:alert(1)" },
    documentation: { url: "https://evil.example/guida" },
    changelog: { url: "https://github.com/MashaUP/Vintory/releases", enabled: false },
    "bad key!": { url: "https://github.com/x" },
    nuovo: { url: "https://www.ko-fi.com/altro", label: "X".repeat(80) },
  } });
  assert.equal(l.discord.url, "https://discord.gg/NUOVO");
  assert.equal(l.kofi.url, "https://ko-fi.com/mashaup");
  assert.equal(l.github.url, "https://github.com/MashaUP/Vintory");
  assert.equal(l.documentation.url, "https://github.com/MashaUP/Vintory#readme");
  assert.equal(l.changelog, undefined);
  assert.equal(l["bad key!"], undefined);
  assert.equal(l.nuovo.label.length, 40);
  assert.deepEqual(Object.keys(U.parseLinks(null)).sort(), ["bugReport", "changelog", "discord", "documentation", "github", "kofi"]);
});

test("i link obbligatori ci sono di serie", () => {
  const l = U.parseLinks({});
  assert.equal(l.kofi.url, "https://ko-fi.com/mashaup");
  assert.equal(l.discord.url, "https://discord.gg/EPsbQCuAkx");
  assert.match(U.githubError(404), /version\.json non trovato/);
  assert.match(U.githubError(0), /non è raggiungibile/);
});
