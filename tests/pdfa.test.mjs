import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

import {
  assertPdfARasterBudget,
  createDocProntoRgbProfile,
  markDocumentAsPdfA2b,
  validatePdfA2b,
} from "../public/docpronto/pdfa.mjs";

let pdfLibrary;

async function loadPdfLibrary() {
  if (pdfLibrary) return pdfLibrary;
  const code = await readFile(new URL("../public/docpronto/vendor/pdf-lib.min.js", import.meta.url), "utf8");
  const sandbox = {
    exports: {}, module: { exports: {} }, console,
    setTimeout, clearTimeout, Uint8Array, ArrayBuffer, TextEncoder, TextDecoder, Date,
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  vm.runInNewContext(code, sandbox, { filename: "pdf-lib.min.js" });
  pdfLibrary = sandbox.exports;
  return pdfLibrary;
}

test("creates a self-contained RGB ICC profile", () => {
  const profile = createDocProntoRgbProfile();
  const view = new DataView(profile.buffer, profile.byteOffset, profile.byteLength);
  const ascii = (offset, length) => Buffer.from(profile.subarray(offset, offset + length)).toString("ascii");

  assert.equal(view.getUint32(0), profile.length);
  assert.equal(ascii(12, 4), "mntr");
  assert.equal(ascii(16, 4), "RGB ");
  assert.equal(ascii(20, 4), "XYZ ");
  assert.equal(ascii(36, 4), "acsp");
  assert.ok(view.getUint32(128) >= 9);
  const tagCount = view.getUint32(128);
  const trcEntry = Array.from({ length: tagCount }, (_, index) => 132 + index * 12)
    .find(offset => ascii(offset, 4) === "rTRC");
  assert.ok(trcEntry);
  const trcOffset = view.getUint32(trcEntry + 4);
  assert.equal(ascii(trcOffset, 4), "curv");
  assert.equal(view.getUint32(trcOffset + 8), 256);
  assert.equal(view.getUint16(trcOffset + 12), 0);
  assert.equal(view.getUint16(trcOffset + 12 + 255 * 2), 65535);
});

test("bounds PDF/A rasterization before memory use becomes unsafe", () => {
  assert.doesNotThrow(() => assertPdfARasterBudget({ pageCount: 40, pagePixels: 2_000_000, totalPixels: 80_000_000 }));
  assert.throws(
    () => assertPdfARasterBudget({ pageCount: 101, pagePixels: 2_000_000, totalPixels: 2_000_000 }),
    error => error.code === "PDFA_PAGE_LIMIT",
  );
  assert.throws(
    () => assertPdfARasterBudget({ pageCount: 1, pagePixels: 41_000_000, totalPixels: 41_000_000 }),
    error => error.code === "PDFA_PAGE_TOO_LARGE",
  );
  assert.throws(
    () => assertPdfARasterBudget({ pageCount: 60, pagePixels: 3_000_000, totalPixels: 121_000_000 }),
    error => error.code === "PDFA_MEMORY_LIMIT",
  );
});

test("marks a reopenable PDF as PDF/A-2b and validates its archival structure", async () => {
  const PDFLib = await loadPdfLibrary();
  const document = await PDFLib.PDFDocument.create();
  document.addPage();

  markDocumentAsPdfA2b(document, PDFLib, {
    title: "Documento de teste",
    createdAt: new Date("2026-11-19T12:00:00.000Z"),
  });
  const bytes = await document.save({ useObjectStreams: false });
  const report = await validatePdfA2b(bytes, PDFLib, { expectedPageCount: 1 });

  assert.equal(report.valid, true);
  assert.equal(report.part, "2");
  assert.equal(report.conformance, "B");
  assert.equal(report.pageCount, 1);
  assert.equal(report.outputCondition, "DOCPronto RGB");
  assert.match(report.fileIdentifier, /^[A-F0-9]{32}$/);
  assert.match(Buffer.from(bytes).toString("latin1", 0, 8), /^%PDF-1\.7/);
  assert.match(Buffer.from(bytes).toString("latin1"), /\/ID\s*\[/);
});

test("rejects an ordinary PDF that does not declare PDF/A conformance", async () => {
  const PDFLib = await loadPdfLibrary();
  const document = await PDFLib.PDFDocument.create();
  document.addPage();
  const bytes = await document.save({ useObjectStreams: false });

  await assert.rejects(
    validatePdfA2b(bytes, PDFLib),
    error => error.code === "INVALID_PDFA" && /metadados XMP/i.test(error.message),
  );
});
