import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  convertOfficeDocument,
  listWindowsCertificates,
  signPdfWithWindowsCertificate,
  signWithWindowsCertificate,
} from "../../desktop/service/windows-capabilities.mjs";

const VALID_THUMBPRINT = "0123456789ABCDEF0123456789ABCDEF01234567";

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

test("bounds_injected_PowerShell_operations_with_a_stable_timeout_code", async () => {
  await assert.rejects(
    listWindowsCertificates({
      runPowerShell: () => new Promise(() => {}),
      timeoutMs: 10,
    }),
    hasCode("LOCAL_OPERATION_TIMEOUT"),
  );
});
