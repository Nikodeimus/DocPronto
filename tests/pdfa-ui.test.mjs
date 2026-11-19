import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const app = await readFile(new URL("../public/docpronto/app.js", import.meta.url), "utf8");
const startup = await readFile(new URL("../public/docpronto/startup.js", import.meta.url), "utf8");
const service = await readFile(new URL("../desktop/service/server.mjs", import.meta.url), "utf8");

test("exposes PDF to PDF/A as tool 22 in both catalogs", () => {
  for (const source of [app, startup]) {
    assert.match(source, /"pdf-pdfa"[\s\S]{0,120}"22"[\s\S]{0,180}"PDF para PDF\/A"/);
  }
  assert.match(app, /id:\s*"pdf-pdfa"[\s\S]{0,300}accept:\s*"\.pdf"[\s\S]{0,200}action:\s*pdfToPdfA/);
});

test("offers archival resolution and explains visual preservation", () => {
  assert.match(app, /id="pdfaResolution"/);
  assert.match(app, /PDF\/A-2b/);
  assert.match(app, /texto pesquisável/i);
  assert.match(app, /assinaturas digitais existentes serão invalidadas/i);
});

test("renders every source page into a fresh archival PDF and validates before download", () => {
  assert.match(app, /async function pdfToPdfA\(\[file\]\)/);
  assert.match(app, /markDocumentAsPdfA2b\(/);
  assert.match(app, /validatePdfA2b\(/);
  assert.match(app, /assertPdfARasterBudget\(/);
  assert.match(app, /renderTask\.cancel\(\)/);
  assert.match(app, /PDFA_OUTPUT_TOO_LARGE/);
  assert.doesNotMatch(app, /const maxPixels = 5000/);
  assert.match(app, /-pdfa-2b\.pdf/);
});

test("desktop static server allows the PDF/A module", () => {
  assert.match(service, /"pdfa\.mjs"/);
});
