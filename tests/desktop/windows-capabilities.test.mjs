import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";

import {
  convertOfficeDocument,
  listWindowsCertificates,
  signPdfWithWindowsCertificate,
  signWithWindowsCertificate,
} from "../../desktop/service/windows-capabilities.mjs";

const VALID_THUMBPRINT = "0123456789ABCDEF0123456789ABCDEF01234567";
const VALID_PLACEMENT = {
  coordinateSystem: "pdf-points-v2",
  page: 1,
  x: 72,
  y: 72,
  width: 220,
  height: 60,
};

let testPdfLibrary;
async function loadTestPdfLibrary() {
  if (!testPdfLibrary) {
    const code = await readFile(new URL("../../public/docpronto/vendor/pdf-lib.min.js", import.meta.url), "utf8");
    const sandbox = {
      exports: {}, module: { exports: {} }, console,
      setTimeout, clearTimeout, Uint8Array, ArrayBuffer, TextEncoder, TextDecoder,
    };
    sandbox.globalThis = sandbox;
    sandbox.window = sandbox;
    sandbox.self = sandbox;
    vm.runInNewContext(code, sandbox, { filename: "pdf-lib.min.js" });
    testPdfLibrary = sandbox.exports;
  }
  return testPdfLibrary;
}

async function createPdfFixture() {
  const PDFLib = await loadTestPdfLibrary();
  const document = await PDFLib.PDFDocument.create();
  document.addPage();
  return Buffer.from(await document.save({ useObjectStreams: false }));
}

function createPdfSigningRunner({ onVerify } = {}) {
  return async script => {
    if (script.includes("Get-ChildItem Cert:")) {
      return JSON.stringify({
        subject: "CN=Test Signer",
        thumbprint: VALID_THUMBPRINT,
        notAfter: "2030-01-01 00:00:00",
        label: "Test Signer - vence 01/01/2030",
      });
    }
    if (script.includes("$cms.CheckSignature")) {
      onVerify?.();
      return "";
    }
    if (script.includes("$signedCms.ComputeSignature")) {
      return Buffer.from("detached-test-signature").toString("base64");
    }
    assert.fail("Unexpected PowerShell operation");
  };
}

function hasCode(code) {
  return error => {
    assert.equal(error.code, code);
    return true;
  };
}

test("rejects_an_incorrect_source_extension_before_launching_Word", async () => {
  let launched = false;
  await assert.rejects(
    convertOfficeDocument(
      { filename: "relatorio.pdf", contentBase64: Buffer.from("document").toString("base64") },
      "pdf",
      { runPowerShell: async () => { launched = true; } },
    ),
    /\.docx/,
  );
  assert.equal(launched, false);
});

test("rejects_input_larger_than_the_40_MiB_application_limit", async () => {
  const oversizedBase64 = "A".repeat(Math.ceil(((40 * 1024 * 1024) + 1) * 4 / 3));
  await assert.rejects(
    convertOfficeDocument(
      { filename: "relatorio.docx", contentBase64: oversizedBase64 },
      "pdf",
      { runPowerShell: async () => assert.fail("PowerShell must not run") },
    ),
    error => error.code === "INPUT_TOO_LARGE",
  );
});

test("rejects_invalid_thumbprints_with_a_stable_code", async () => {
  const deps = { runPowerShell: async () => assert.fail("PowerShell must not run") };
  await assert.rejects(
    signWithWindowsCertificate({ thumbprint: "not-a-thumbprint", contentBase64: "YQ==" }, deps),
    hasCode("INVALID_CERTIFICATE"),
  );
  await assert.rejects(
    signPdfWithWindowsCertificate({ thumbprint: "bad", contentBase64: "JVBERi0=" }, deps),
    hasCode("INVALID_CERTIFICATE"),
  );
});

test("rejects_missing_or_stale_PDF_placement_coordinate_systems", async () => {
  for (const coordinateSystem of [undefined, "pdf-points-v1"]) {
    await assert.rejects(
      signPdfWithWindowsCertificate({
        filename: "contrato.pdf",
        thumbprint: VALID_THUMBPRINT,
        contentBase64: Buffer.from("%PDF-invalid-test-fixture").toString("base64"),
        placement: { coordinateSystem, page: 1, x: 72, y: 72, width: 220, height: 60 },
      }, {
        runPowerShell: async () => assert.fail("PowerShell must not run"),
      }),
      hasCode("INVALID_SIGNATURE_PLACEMENT"),
    );
  }
});

test("returns_a_reopenable_signed_PDF_with_complete_cryptographic_coverage", async t => {
  const tempRoot = await mkdtemp(join(tmpdir(), "docpronto-pdf-sign-test-"));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const sourcePdf = await createPdfFixture();

  const result = await signPdfWithWindowsCertificate({
    filename: "contrato.pdf",
    thumbprint: VALID_THUMBPRINT,
    contentBase64: sourcePdf.toString("base64"),
    signerName: "Test Signer",
    placement: { ...VALID_PLACEMENT },
  }, {
    tempRoot,
    runPowerShell: createPdfSigningRunner(),
  });

  const output = Buffer.from(result.contentBase64, "base64");
  const source = output.toString("latin1");
  assert.equal(result.filename, "contrato-assinado.pdf");
  assert.equal(output.subarray(0, 5).toString("latin1"), "%PDF-");
  assert.match(source, /%%EOF\s*$/);
  const range = [...source.matchAll(/\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g)]
    .at(-1).slice(1).map(Number);
  assert.equal(range[0], 0);
  assert.ok(range[1] < range[2]);
  assert.equal(range[2] + range[3], output.length);
  assert.match(output.subarray(range[1], range[2]).toString("ascii"), /^<([0-9A-F]{2})+0*>$/);
  const PDFLib = await loadTestPdfLibrary();
  const reopened = await PDFLib.PDFDocument.load(output, {
    ignoreEncryption: false,
    throwOnInvalidObject: true,
    updateMetadata: false,
  });
  assert.equal(reopened.getPageCount(), 1);
  assert.deepEqual(await readdir(tempRoot), []);
});

test("validates_final_visible_placement_before_returning_the_signed_PDF", async () => {
  const placement = { ...VALID_PLACEMENT };
  const sourcePdf = await createPdfFixture();

  await assert.rejects(
    signPdfWithWindowsCertificate({
      filename: "contrato.pdf",
      thumbprint: VALID_THUMBPRINT,
      contentBase64: sourcePdf.toString("base64"),
      signerName: "Test Signer",
      placement,
    }, {
      runPowerShell: createPdfSigningRunner({
        onVerify: () => { placement.x = 10_000; },
      }),
    }),
    hasCode("INVALID_SIGNED_PDF"),
  );
});

test("reports_Word_or_PowerShell_unavailability_and_removes_temporaries", async t => {
  const tempRoot = await mkdtemp(join(tmpdir(), "docpronto-capability-test-"));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));

  await assert.rejects(
    convertOfficeDocument(
      { filename: "relatorio.docx", contentBase64: Buffer.from("document").toString("base64") },
      "pdf",
      {
        tempRoot,
        runPowerShell: async () => {
          const error = new Error("powershell.exe was not found while creating Word.Application");
          error.code = "ENOENT";
          throw error;
        },
      },
    ),
    hasCode("WORD_UNAVAILABLE"),
  );
  assert.deepEqual(await readdir(tempRoot), []);
});

test("reports_a_missing_certificate_and_removes_signing_temporaries", async t => {
  const tempRoot = await mkdtemp(join(tmpdir(), "docpronto-sign-test-"));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));

  await assert.rejects(
    signWithWindowsCertificate(
      { thumbprint: VALID_THUMBPRINT, contentBase64: Buffer.from("document").toString("base64") },
      {
        tempRoot,
        runPowerShell: async () => {
          throw new Error("Certificado nao encontrado no repositorio do Windows.");
        },
      },
    ),
    hasCode("CERTIFICATE_NOT_FOUND"),
  );
  assert.deepEqual(await readdir(tempRoot), []);
});

test("maps_certificate_provider_failures_to_a_stable_code", async () => {
  const providerFailure = async () => {
    throw new Error("The smart card resource manager or cryptographic provider is unavailable.");
  };

  await assert.rejects(
    listWindowsCertificates({ runPowerShell: providerFailure }),
    hasCode("CERTIFICATE_PROVIDER_UNAVAILABLE"),
  );
  await assert.rejects(
    signWithWindowsCertificate(
      { thumbprint: VALID_THUMBPRINT, contentBase64: Buffer.from("document").toString("base64") },
      { runPowerShell: providerFailure },
    ),
    hasCode("CERTIFICATE_PROVIDER_UNAVAILABLE"),
  );
});

test("bounds_injected_PowerShell_operations_with_a_stable_timeout_code", async () => {
  await assert.rejects(
    listWindowsCertificates({
      runPowerShell: () => new Promise(() => {}),
      timeoutMs: 10,
    }),
    hasCode("LOCAL_OPERATION_TIMEOUT"),
  );
});
