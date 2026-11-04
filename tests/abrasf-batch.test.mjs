import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const app = await readFile(new URL("../public/docpronto/app.js", import.meta.url), "utf8");

test("PDF para XML ABRASF aceita várias notas e entrega um único ZIP", () => {
  assert.match(app, /id:\s*"pdf-xml-abrasf"[^\n]+multiple:\s*true/);
  assert.match(app, /async function pdfToAbrasfXml\(files/);
  assert.match(app, /for \(const \[index, file\] of files\.entries\(\)\)/);
  assert.match(app, /xml-abrasf-convertidos\.zip/);
});

test("a conferência aceita vários XMLs sem criar pastas no ZIP", () => {
  assert.match(app, /id:\s*"xml-abrasf-review"[^\n]+multiple:\s*true/);
  assert.match(app, /async function reviewAbrasfXmlForDominio\(files/);
  assert.match(app, /for \(const \[fileIndex, file\] of files\.entries\(\)\)/);
  assert.match(app, /xml-abrasf-conferidos\.zip/);
  assert.doesNotMatch(app, /zip\.folder\([^)]*abrasf/i);
});

test("o lote ABRASF possui limite explícito", () => {
  assert.match(app, /const MAX_ABRASF_BATCH_FILES = 30/);
  assert.match(app, /activeTool\.id === "pdf-xml-abrasf" \|\| activeTool\.id === "xml-abrasf-review"/);
});
