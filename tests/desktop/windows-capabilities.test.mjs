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

async function createPdfFixture({ pageCount = 1, unsignedSignatureName } = {}) {
  const PDFLib = await loadTestPdfLibrary();
  const document = await PDFLib.PDFDocument.create();
  for (let index = 0; index < pageCount; index += 1) document.addPage();
  if (unsignedSignatureName) {
    const { PDFArray, PDFDict, PDFName, PDFString } = PDFLib;
    const page = document.getPage(0);
    document.getForm();
    const acroForm = document.catalog.lookup(PDFName.of("AcroForm"), PDFDict);
    let fields = acroForm.lookupMaybe(PDFName.of("Fields"), PDFArray);
    if (!fields) {
      fields = document.context.obj([]);
      acroForm.set(PDFName.of("Fields"), fields);
    }
    const widget = document.context.register(document.context.obj({
      Type: "Annot",
      Subtype: "Widget",
      FT: "Sig",
      Rect: [12, 12, 112, 42],
      T: PDFString.of(unsignedSignatureName),
      P: page.ref,
      F: 4,
    }));
    fields.push(widget);
    let annotations = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
    if (!annotations) {
      annotations = document.context.obj([]);
      page.node.set(PDFName.of("Annots"), annotations);
    }
    annotations.push(widget);
  }
  return Buffer.from(await document.save({ useObjectStreams: false }));
}

function createPdfSigningRunner({ onVerify } = {}) {
  return async script => {
    if (script.includes("X509Store")) {
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

function inspectSignatureWidget(PDFLib, document, pageIndex, fieldName = "Signature1") {
  const { PDFArray, PDFDict, PDFName } = PDFLib;
  const page = document.getPage(pageIndex);
  const annotations = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
  assert.ok(annotations, "signed page must contain annotations");
  for (let index = 0; index < annotations.size(); index += 1) {
    const reference = annotations.get(index);
    const widget = document.context.lookup(reference, PDFDict);
    if (String(widget?.get(PDFName.of("Subtype"))) === "/Widget"
      && String(widget?.get(PDFName.of("FT"))) === "/Sig"
      && widget.get(PDFName.of("T"))?.decodeText?.() === fieldName) {
      return { page, reference, widget };
    }
  }
  assert.fail("signed page must contain a signature widget");
}

async function withSerializedMutation(search, replacement, operation) {
  assert.equal(search.length, replacement.length, "serialized mutation must preserve PDF offsets");
  const originalWrite = Buffer.prototype.write;
  let mutated = false;
  Buffer.prototype.write = function writeAndMutatePdf(value, ...args) {
    const written = Reflect.apply(originalWrite, this, [value, ...args]);
    if (!mutated && typeof value === "string" && value.length === 65_536) {
      const mutationOffset = this.indexOf(search, 0, "ascii");
      assert.notEqual(mutationOffset, -1, `serialized PDF must contain ${search} before mutation`);
      Reflect.apply(originalWrite, this, [replacement, mutationOffset, "ascii"]);
      mutated = true;
    }
    return written;
  };
  try {
    return await operation();
  } finally {
    Buffer.prototype.write = originalWrite;
    assert.equal(mutated, true, "test must mutate the serialized PDF widget");
  }
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
  const { PDFArray, PDFDict, PDFName } = PDFLib;
  const { page, widget } = inspectSignatureWidget(PDFLib, reopened, 0);
  assert.equal(String(widget.get(PDFName.of("P"))), String(page.ref));
  const rectangle = widget.lookup(PDFName.of("Rect"), PDFArray);
  assert.deepEqual(
    Array.from({ length: rectangle.size() }, (_, index) => rectangle.lookup(index).asNumber()),
    [72, 72, 292, 132],
  );
  const signature = widget.lookup(PDFName.of("V"), PDFDict);
  assert.equal(String(signature.get(PDFName.of("Type"))), "/Sig");
  const appearanceDictionary = widget.lookup(PDFName.of("AP"), PDFDict);
  const normalAppearance = reopened.context.lookup(appearanceDictionary.get(PDFName.of("N")));
  assert.equal(String(normalAppearance.dict.get(PDFName.of("Type"))), "/XObject");
  assert.equal(String(normalAppearance.dict.get(PDFName.of("Subtype"))), "/Form");
  const appearanceBounds = normalAppearance.dict.lookup(PDFName.of("BBox"), PDFArray);
  assert.deepEqual(
    Array.from({ length: appearanceBounds.size() }, (_, index) => appearanceBounds.lookup(index).asNumber()),
    [0, 0, 220, 60],
  );
  const appearanceContent = Buffer.from(PDFLib.decodePDFRawStream(normalAppearance).decode()).toString("latin1");
  assert.match(appearanceContent, /\b(?:Tj|S|f)\b/);
  assert.deepEqual(await readdir(tempRoot), []);
});

test("rejects_missing_displaced_or_invisible_serialized_signature_widgets", async () => {
  const sourcePdf = await createPdfFixture();
  const mutations = [
    ["/AP", "/XX"],
    ["/Rect [ 72 72 292 132 ]", "/Rect [ 82 72 302 132 ]"],
    ["/Subtype /Form", "/Subtype /Fake"],
  ];

  for (const [search, replacement] of mutations) {
    await assert.rejects(
      withSerializedMutation(search, replacement, () => signPdfWithWindowsCertificate({
        filename: "contrato.pdf",
        thumbprint: VALID_THUMBPRINT,
        contentBase64: sourcePdf.toString("base64"),
        signerName: "Test Signer",
        placement: { ...VALID_PLACEMENT },
      }, {
        runPowerShell: createPdfSigningRunner(),
      })),
      hasCode("INVALID_SIGNED_PDF"),
    );
  }
});

test("rejects_a_serialized_signature_widget_associated_with_the_wrong_page", async () => {
  const sourcePdf = await createPdfFixture({ pageCount: 2 });

  await assert.rejects(
    withSerializedMutation("/P 4 0 R", "/P 5 0 R", () => signPdfWithWindowsCertificate({
      filename: "contrato.pdf",
      thumbprint: VALID_THUMBPRINT,
      contentBase64: sourcePdf.toString("base64"),
      signerName: "Test Signer",
      placement: { ...VALID_PLACEMENT },
    }, {
      runPowerShell: createPdfSigningRunner(),
    })),
    hasCode("INVALID_SIGNED_PDF"),
  );
});

test("accepts_an_existing_unsigned_signature_widget_and_validates_the_generated_widget", async () => {
  const PDFLib = await loadTestPdfLibrary();
  const sourcePdf = await createPdfFixture({ unsignedSignatureName: "Signature1" });

  const result = await signPdfWithWindowsCertificate({
    filename: "contrato.pdf",
    thumbprint: VALID_THUMBPRINT,
    contentBase64: sourcePdf.toString("base64"),
    signerName: "Test Signer",
    placement: { ...VALID_PLACEMENT },
  }, {
    runPowerShell: createPdfSigningRunner(),
  });

  const reopened = await PDFLib.PDFDocument.load(Buffer.from(result.contentBase64, "base64"), {
    ignoreEncryption: false,
    throwOnInvalidObject: true,
    updateMetadata: false,
  });
  const { PDFDict, PDFName } = PDFLib;
  const existing = inspectSignatureWidget(PDFLib, reopened, 0, "Signature1").widget;
  assert.equal(existing.has(PDFName.of("V")), false);
  const generated = inspectSignatureWidget(PDFLib, reopened, 0, "Signature2").widget;
  assert.equal(String(generated.lookup(PDFName.of("V"), PDFDict).get(PDFName.of("Type"))), "/Sig");
  assert.ok(generated.has(PDFName.of("AP")));
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

test("enumerates_certificates_through_X509Store_without_the_optional_Cert_drive", async () => {
  const certificates = await listWindowsCertificates({
    runPowerShell: async script => {
      assert.match(script, /X509Store/);
      assert.match(script, /\.Close\(\)/);
      assert.doesNotMatch(script, /Cert:\\/);
      return "[]";
    },
  });
  assert.deepEqual(certificates, []);
});
