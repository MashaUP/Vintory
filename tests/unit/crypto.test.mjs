import test from "node:test";
import assert from "node:assert/strict";
import { encryptBlob, decryptBlob, isEncrypted } from "../../src/shared/crypto.js";

const IT = 1000;      // poche iterazioni: le prove devono essere veloci (nell'estensione sono 600 000)
const bytes = (n) => { const b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = (i * 31 + (i >> 8)) & 255; return b; };
const same = async (a, b) => Buffer.compare(Buffer.from(await a.arrayBuffer()), Buffer.from(await b.arrayBuffer())) === 0;

test("cifratura: andata e ritorno su più blocchi, il contenuto non resta in chiaro", async () => {
  const plain = new Blob([bytes(9 * 1024 * 1024 + 123)]);          // 3 blocchi da 4 MiB
  const marker = new Blob([new TextEncoder().encode("vintory.json segreto")]);
  const enc = await encryptBlob(new Blob([marker, plain]), "una password lunga", { iterations: IT });
  assert.ok(await isEncrypted(enc));
  assert.ok(!Buffer.from(await enc.arrayBuffer()).includes("vintory.json"), "nessun testo in chiaro");
  const back = await decryptBlob(enc, "una password lunga");
  assert.ok(await same(back, new Blob([marker, plain])));
  const empty = await decryptBlob(await encryptBlob(new Blob([]), "password", { iterations: IT }), "password");
  assert.equal(empty.size, 0);
});

test("cifratura: password sbagliata, file troncato, manomesso o con blocchi scambiati non si aprono", async () => {
  const enc = await encryptBlob(new Blob([bytes(9 * 1024 * 1024)]), "giusta123", { iterations: IT });
  await assert.rejects(decryptBlob(enc, "sbagliata"), /Password sbagliata/);
  await assert.rejects(decryptBlob(enc.slice(0, enc.size - 100), "giusta123"), /troncato|danneggiato/);
  await assert.rejects(decryptBlob(enc.slice(0, 4 * 1024 * 1024), "giusta123"), /troncato|danneggiato|incompleto/);
  const buf = new Uint8Array(await enc.arrayBuffer());
  const bad = buf.slice(); bad[bad.length - 50] ^= 1;
  await assert.rejects(decryptBlob(new Blob([bad]), "giusta123"), /danneggiato/);
  // scambio del primo e del secondo blocco: stessa lunghezza, ordine diverso
  const view = new DataView(buf.buffer);
  const hlen = view.getUint32(6);
  let p = 10 + hlen;
  const blocks = [];
  while (p < buf.length) { const len = new DataView(buf.buffer, p, 4).getUint32(0); blocks.push(buf.slice(p, p + 4 + len)); p += 4 + len; }
  assert.equal(blocks.length, 3);
  const swapped = new Blob([buf.slice(0, 10 + hlen), blocks[1], blocks[0], blocks[2]]);
  await assert.rejects(decryptBlob(swapped, "giusta123"), /Password sbagliata|danneggiato/);
  // ultimo blocco tolto e il penultimo spacciato per ultimo: non passa
  await assert.rejects(decryptBlob(new Blob([buf.slice(0, 10 + hlen), blocks[0], blocks[1]]), "giusta123"), /troncato|danneggiato|incompleto/);
  await assert.rejects(decryptBlob(new Blob([new TextEncoder().encode("PK\u0003\u0004 non cifrato")]), "x"), /non è un backup cifrato/);
});
