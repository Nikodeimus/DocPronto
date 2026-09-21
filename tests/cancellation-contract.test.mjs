import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../public/docpronto/app.js", import.meta.url), "utf8");

test("mantém os controles de cancelamento disponíveis durante processamento", () => {
  assert.match(source, /processingAbortController\s*=\s*new AbortController\(\)/);
  assert.doesNotMatch(source, /\[data-cancel\][^\n]+disabled\s*=\s*true/);
  assert.match(source, /Processamento cancelado\. Nenhum arquivo incompleto foi baixado/);
});

test("verifica cancelamento nos principais motores paginados e no OCR", () => {
  const checks = (source.match(/throwIfProcessingCancelled\(\)/g) || []).length;
  assert.ok(checks >= 14, `esperadas ao menos 14 verificações, encontradas ${checks}`);
  assert.match(source, /logger:\s*message\s*=>\s*\{\s*throwIfProcessingCancelled\(\)/);
});
