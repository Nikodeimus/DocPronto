import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("../public/docpronto/app.js", import.meta.url), "utf8");

test("PDF para OFX aceita fila e empacota múltiplas saídas", () => {
  assert.match(source, /id: "pdf-ofx"[\s\S]*?multiple: true/);
  assert.match(source, /MAX_OFX_QUEUE_FILES = 30/);
  assert.match(source, /for \(let index = 0; index < files\.length; index \+= 1\)/);
  assert.match(source, /zip\.file\(output\.filename, output\.data\)/);
  assert.match(source, /"ofx-convertidos\.zip"/);
});

test("falha ou cancelamento de um PDF não elimina os OFXs concluídos", () => {
  assert.match(source, /updateOfxQueueItem\(index, "error"/);
  assert.match(source, /updateOfxQueueItem\(index, "skipped"/);
  assert.match(source, /if \(error\?\.name === "AbortError"[\s\S]*?throw error/);
});
