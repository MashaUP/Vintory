import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { crc32, ZipWriter, readZip, buildXlsx } from "../../src/shared/zip.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "vy-zip-"));
const bytes = async (blob) => new Uint8Array(await blob.arrayBuffer());

test("crc32 corrisponde al valore di riferimento", () => {
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
  assert.equal(crc32(new Uint8Array(0)), 0);
});

test("scrittura e rilettura: testo, binario, nomi con accenti", async () => {
  const z = new ZipWriter();
  const bin = new Uint8Array(70000).map((_, i) => (i * 31) % 251);
  await z.add("vintory.json", JSON.stringify({ ok: true, testo: "perché" }));
  await z.add("images/foto è.jpg", new Blob([bin], { type: "image/jpeg" }));
  await z.add("vuoto.txt", "");
  const blob = z.finish();
  const files = await readZip(blob);
  assert.deepEqual([...files.keys()], ["vintory.json", "images/foto è.jpg", "vuoto.txt"]);
  assert.deepEqual(JSON.parse(await files.get("vintory.json").text()), { ok: true, testo: "perché" });
  const back = await files.get("images/foto è.jpg").blob("image/jpeg");
  assert.equal(back.type, "image/jpeg");
  assert.deepEqual(await bytes(back), bin);
  assert.equal(files.get("vuoto.txt").size, 0);
});

test("lo ZIP scritto è valido per unzip", async () => {
  const z = new ZipWriter();
  await z.add("a/b.txt", "ciao");
  await z.add("c.bin", new Uint8Array([1, 2, 3]));
  const dir = tmp();
  const f = path.join(dir, "t.zip");
  fs.writeFileSync(f, await bytes(z.finish()));
  const out = execFileSync("unzip", ["-t", f], { encoding: "utf8" });
  assert.match(out, /No errors detected/);
  execFileSync("unzip", ["-q", f, "-d", dir]);
  assert.equal(fs.readFileSync(path.join(dir, "a/b.txt"), "utf8"), "ciao");
});

test("legge anche ZIP compressi (deflate) creati da altri programmi", async () => {
  const dir = tmp();
  const text = "riga ripetuta\n".repeat(500);
  fs.writeFileSync(path.join(dir, "vintory.json"), text);
  execFileSync("zip", ["-q", "-9", "x.zip", "vintory.json"], { cwd: dir });
  const files = await readZip(new Blob([fs.readFileSync(path.join(dir, "x.zip"))]));
  assert.equal(files.get("vintory.json").method, 8);
  assert.equal(await files.get("vintory.json").text(), text);
});

test("un file che non è uno ZIP viene rifiutato con un messaggio chiaro", async () => {
  await assert.rejects(readZip(new Blob(["non sono uno zip"])), /non è uno ZIP valido/);
});

test("foglio Excel: ZIP valido con numeri e testo protetto", async () => {
  const blob = await buildXlsx([["Titolo", "Prezzo"], ["A & B <x>", 12.5], ["", null]], "Annunci");
  const files = await readZip(blob);
  for (const f of ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/worksheets/sheet1.xml"]) assert.ok(files.has(f), f);
  const sheet = await files.get("xl/worksheets/sheet1.xml").text();
  assert.ok(sheet.includes("A &amp; B &lt;x&gt;"));
  assert.ok(sheet.includes('<c r="B2"><v>12.5</v></c>'));
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "t.xlsx"), await bytes(blob));
  assert.match(execFileSync("unzip", ["-t", path.join(dir, "t.xlsx")], { encoding: "utf8" }), /No errors detected/);
});
