import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  HarnessError,
  assessOfxReview,
  parseHarnessArguments,
  registerHarnessIpc,
  runWithTimeout,
  validateOutput,
} from "../../scripts/homologate-desktop.mjs";

test("registers the preload IPC surface and removes it during cleanup", async () => {
  const handlers = new Map();
  const ipcMain = {
    handle(channel, handler) { handlers.set(channel, handler); },
    removeHandler(channel) { handlers.delete(channel); },
  };

  const dispose = registerHarnessIpc(ipcMain);
  assert.deepEqual(await handlers.get("docpronto:get-app-info")(), {
    channel: "lab",
    productName: "DOCPronto Homologação",
    laboratory: false,
  });
  assert.equal(await handlers.get("docpronto:window-painted")(), true);
  assert.deepEqual(await handlers.get("docpronto:diagnostics:list")(), []);
  dispose();
  assert.equal(handlers.size, 0);
});

test("parses a PDF to Word homologation without embedding machine-specific paths", () => {
  const options = parseHarnessArguments([
    "--tool", "pdf-word",
    "--input", "fixtures/statement.pdf",
    "--output", "artifacts/homologation",
    "--mode", "fast",
    "--timeout-ms", "45000",
  ], { cwd: "C:/workspace/docpronto" });

  assert.equal(options.tool, "pdf-word");
  assert.deepEqual(options.inputs, ["C:\\workspace\\docpronto\\fixtures\\statement.pdf"]);
  assert.equal(options.outputDirectory, "C:\\workspace\\docpronto\\artifacts\\homologation");
  assert.equal(options.mode, "fast");
  assert.equal(options.timeoutMs, 45_000);
});

test("accepts PDF to ABRASF XML homologation", () => {
  const options = parseHarnessArguments([
    "--tool", "pdf-xml-abrasf",
    "--input", "invoice.pdf",
    "--output", "out",
  ], { cwd: "C:/work" });

  assert.equal(options.tool, "pdf-xml-abrasf");
  assert.deepEqual(options.inputs, ["C:\\work\\invoice.pdf"]);
});

test("requires explicit signer text for visual signatures and never accepts PFX options", () => {
  assert.throws(
    () => parseHarnessArguments([
      "--tool", "visual-sign",
      "--input", "document.pdf",
      "--output", "out",
    ], { cwd: "C:/work" }),
    error => error instanceof HarnessError && error.code === "SIGNER_REQUIRED",
  );
  assert.throws(
    () => parseHarnessArguments([
      "--tool", "visual-sign",
      "--input", "document.pdf",
      "--output", "out",
      "--signer", "Pessoa de Teste",
      "--pfx", "certificate.pfx",
    ], { cwd: "C:/work" }),
    error => error instanceof HarnessError && error.code === "UNKNOWN_ARGUMENT",
  );
});

test("accepts repeated logical copies for the OFX queue without copying source files", () => {
  const options = parseHarnessArguments([
    "--tool", "pdf-ofx",
    "--input", "statement.pdf",
    "--output", "out",
    "--copies", "3",
  ], { cwd: "C:/work" });

  assert.deepEqual(options.inputs, [
    "C:\\work\\statement.pdf",
    "C:\\work\\statement.pdf",
    "C:\\work\\statement.pdf",
  ]);
  assert.equal(options.logicalCopies, 3);
});

test("OFX auto-review is allowed only with real metadata, transactions and no blocking error", () => {
  assert.deepEqual(assessOfxReview({
    open: true,
    confirmDisabled: false,
    bankId: "237",
    accountId: "12345-6",
    transactionCount: 8,
    errorText: "",
  }), { safe: true, reason: "OFX_REVIEW_READY" });

  assert.deepEqual(assessOfxReview({
    open: true,
    confirmDisabled: true,
    bankId: "PDF",
    accountId: "PDF-IMPORT",
    transactionCount: 0,
    errorText: "2 erros",
  }), { safe: false, reason: "OFX_REVIEW_REQUIRES_HUMAN" });
});

test("timeout invokes cleanup before rejecting", async () => {
  let cleaned = false;
  await assert.rejects(
    runWithTimeout(() => new Promise(() => {}), 20, async () => { cleaned = true; }),
    error => error instanceof HarnessError && error.code === "HARNESS_TIMEOUT",
  );
  assert.equal(cleaned, true);
});

test("validates DOCX, PDF and ABRASF XML download signatures", async () => {
  const root = await mkdtemp(join(tmpdir(), "docpronto-harness-test-"));
  const docx = join(root, "result.docx");
  const pdf = join(root, "signed.pdf");
  const xml = join(root, "invoice.xml");
  await writeFile(docx, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x01]));
  await writeFile(pdf, Buffer.from("%PDF-1.7\nfixture"));
  await writeFile(xml, '<?xml version="1.0"?><CompNfse xmlns="http://www.abrasf.org.br/nfse.xsd"><Nfse versao="2.04"/></CompNfse>');

  assert.equal((await validateOutput(docx, "pdf-word")).kind, "docx");
  assert.equal((await validateOutput(pdf, "visual-sign")).kind, "pdf");
  assert.equal((await validateOutput(xml, "pdf-xml-abrasf")).kind, "xml");
});
