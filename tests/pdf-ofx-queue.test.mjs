import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

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

test("resumo da fila distingue sucesso total, parcial e falha total", () => {
  const start = source.indexOf("function createOfxQueueOutcome(");
  assert.notEqual(start, -1, "função de resumo da fila OFX não encontrada");
  let depth = 0;
  let opened = false;
  let end = -1;
  for (let index = start; index < source.length; index += 1) {
    if (source[index] === "{") { depth += 1; opened = true; }
    if (source[index] === "}") depth -= 1;
    if (opened && depth === 0) { end = index + 1; break; }
  }
  const context = vm.createContext({});
  vm.runInContext(`${source.slice(start, end)}; this.summarize = createOfxQueueOutcome;`, context);

  const summarize = options => JSON.parse(JSON.stringify(context.summarize(options)));
  assert.deepEqual(summarize({ outputCount: 2, failed: 0, skipped: 0, queueCancelled: false }), {
    message: "2 OFXs gerados.",
    diagnostic: { level: "info", code: "TOOL_RUN_COMPLETED", message: "2 OFXs gerados sem falhas." },
  });
  assert.deepEqual(summarize({ outputCount: 1, failed: 1, skipped: 0, queueCancelled: false }), {
    message: "1 OFX gerado · 1 com erro.",
    diagnostic: { level: "warning", code: "TOOL_RUN_COMPLETED_WITH_ERRORS", message: "Fila concluída: 1 OFX gerado e 1 PDF com erro." },
  });
  assert.deepEqual(summarize({ outputCount: 0, failed: 2, skipped: 0, queueCancelled: false }), {
    message: "Fila concluída sem OFXs · 2 com erro.",
    diagnostic: { level: "error", code: "TOOL_RUN_FAILED", message: "Fila concluída sem OFXs: 2 PDFs com erro." },
  });
});

test("falha da fila recebe codigo especifico e contexto da execucao", () => {
  assert.match(source, /code:\s*"OFX_TRANSACTIONS_NOT_FOUND"/);
  assert.match(source, /executionId:\s*context\.executionId/);
  assert.match(source, /queuePosition:\s*index \+ 1/);
  assert.match(source, /activeTool\.action\(selectedFiles, \{ executionId \}\)/);
});
