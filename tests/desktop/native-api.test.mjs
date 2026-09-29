import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { startDocProntoService } from "../../desktop/service/server.mjs";

const TOKEN = "a".repeat(64);
const THUMBPRINT = "0123456789ABCDEF0123456789ABCDEF01234567";

async function createFixture(t, capabilities = {}) {
  const assetsRoot = await mkdtemp(join(tmpdir(), "docpronto-native-assets-"));
  const temporaryParent = await mkdtemp(join(tmpdir(), "docpronto-native-private-"));
  await writeFile(join(assetsRoot, "index.html"), "<!doctype html><title>DOCPronto</title>");
  const service = await startDocProntoService({
    assetsRoot,
    sessionToken: TOKEN,
    temporaryParent,
    capabilities: {
      listWindowsCertificates: async () => [],
      convertOfficeDocument: async () => ({ filename: "saida.pdf", contentBase64: "JVBERi0=" }),
      signWithWindowsCertificate: async () => "c2lnbmF0dXJl",
      signPdfWithWindowsCertificate: async () => ({
        filename: "assinado.pdf",
        contentBase64: "JVBERi0=",
      }),
      ...capabilities,
    },
  });
  t.after(async () => {
    await service.close();
    await rm(assetsRoot, { recursive: true, force: true });
    await rm(temporaryParent, { recursive: true, force: true });
  });
  return { service, temporaryParent };
}

async function openSession(service) {
  const response = await fetch(`${service.origin}/api/session`, {
    method: "POST",
    headers: {
      Origin: service.origin,
      "Sec-Fetch-Site": "same-origin",
    },
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.token, TOKEN);
  return body.token;
}

function authorizedHeaders(service, token = TOKEN) {
  return { Origin: service.origin, "X-DocPronto-Token": token };
}

test("issues_the_process_session_only_to_the_same_origin_renderer", async t => {
  const { service } = await createFixture(t);

  const wrongMethod = await fetch(`${service.origin}/api/session`, {
    headers: { Origin: service.origin, "Sec-Fetch-Site": "same-origin" },
  });
  assert.equal(wrongMethod.status, 405);

  for (const headers of [
    {},
    { Origin: service.origin },
    { Origin: "https://evil.example", "Sec-Fetch-Site": "same-origin" },
    { Origin: service.origin, "Sec-Fetch-Site": "cross-site" },
  ]) {
    const response = await fetch(`${service.origin}/api/session`, { method: "POST", headers });
    assert.equal(response.status, 403);
  }

  assert.equal(await openSession(service), TOKEN);
  const unauthenticated = await fetch(`${service.origin}/api/certificates`, {
    headers: { Origin: service.origin },
  });
  assert.equal(unauthenticated.status, 401);
});

test("exposes_only_the_native_routes_used_by_the_renderer", async t => {
  const calls = [];
  const { service } = await createFixture(t, {
    listWindowsCertificates: async dependencies => {
      calls.push(["certificates", dependencies]);
      return [{
        subject: "CN=Pessoa 12345678901",
        label: "Pessoa 12345678901 - vence 01/01/2030",
        thumbprint: THUMBPRINT,
        notAfter: "2030-01-01 00:00:00",
      }];
    },
    convertOfficeDocument: async (input, target, dependencies) => {
      calls.push(["word-to-pdf", input, target, dependencies]);
      return { filename: "relatorio.pdf", contentBase64: "JVBERi0=" };
    },
    signWithWindowsCertificate: async (input, dependencies) => {
      calls.push(["sign-installed", input, dependencies]);
      return "c2lnbmF0dXJl";
    },
    signPdfWithWindowsCertificate: async (input, dependencies) => {
      calls.push(["sign-pdf-installed", input, dependencies]);
      return { filename: "contrato-assinado.pdf", contentBase64: "JVBERi0=" };
    },
  });
  await openSession(service);

  const certificates = await fetch(`${service.origin}/api/certificates`, {
    headers: authorizedHeaders(service),
  });
  assert.equal(certificates.status, 200);
  assert.deepEqual(await certificates.json(), {
    certificates: [{
      label: "Pessoa 123•••••01 - vence 01/01/2030",
      thumbprint: THUMBPRINT,
      notAfter: "2030-01-01 00:00:00",
    }],
  });

  const word = await fetch(`${service.origin}/api/word-to-pdf`, {
    method: "POST",
    headers: { ...authorizedHeaders(service), "Content-Type": "application/json" },
    body: JSON.stringify({ filename: "relatorio.docx", contentBase64: "ZG9jeA==" }),
  });
  assert.equal(word.status, 200);
  assert.equal((await word.json()).filename, "relatorio.pdf");

  const detached = await fetch(`${service.origin}/api/sign-installed`, {
    method: "POST",
    headers: { ...authorizedHeaders(service), "Content-Type": "application/json" },
    body: JSON.stringify({ filename: "dados.txt", thumbprint: THUMBPRINT, contentBase64: "ZGFkb3M=" }),
  });
  assert.equal(detached.status, 200);
  assert.deepEqual(await detached.json(), { signatureBase64: "c2lnbmF0dXJl" });

  const embedded = await fetch(`${service.origin}/api/sign-pdf-installed`, {
    method: "POST",
    headers: { ...authorizedHeaders(service), "Content-Type": "application/json" },
    body: JSON.stringify({
      filename: "contrato.pdf",
      thumbprint: THUMBPRINT,
      contentBase64: "JVBERi0=",
      signerName: "Pessoa",
      placement: {
        coordinateSystem: "pdf-points-v2",
        page: 1,
        x: 10,
        y: 20,
        width: 200,
        height: 60,
      },
    }),
  });
  assert.equal(embedded.status, 200);
  assert.equal((await embedded.json()).filename, "contrato-assinado.pdf");

  const unused = await fetch(`${service.origin}/api/pdf-to-word`, {
    method: "POST",
    headers: { ...authorizedHeaders(service), "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(unused.status, 404);
  assert.deepEqual(calls.map(([name]) => name), [
    "certificates",
    "word-to-pdf",
    "sign-installed",
    "sign-pdf-installed",
  ]);
  for (const call of calls) {
    const dependencies = call.at(-1);
    assert.match(dependencies.tempRoot, /docpronto-native-/);
  }
});

test("keeps_native_capabilities_closed_when_no_process_session_is_configured", async t => {
  const assetsRoot = await mkdtemp(join(tmpdir(), "docpronto-native-no-session-"));
  await writeFile(join(assetsRoot, "index.html"), "<!doctype html>");
  const service = await startDocProntoService({ assetsRoot });
  t.after(async () => {
    await service.close();
    await rm(assetsRoot, { recursive: true, force: true });
  });

  const health = await fetch(`${service.origin}/api/health`);
  assert.equal(health.status, 200);
  const certificates = await fetch(`${service.origin}/api/certificates`);
  assert.equal(certificates.status, 503);
  assert.equal((await certificates.json()).code, "SESSION_UNAVAILABLE");
});

test("rejects_invalid_methods_content_types_and_schemas_before_native_execution", async t => {
  let executions = 0;
  const operation = async () => { executions += 1; };
  const { service } = await createFixture(t, {
    convertOfficeDocument: operation,
    signWithWindowsCertificate: operation,
    signPdfWithWindowsCertificate: operation,
  });
  await openSession(service);

  const requests = [
    ["/api/certificates", { method: "POST", headers: authorizedHeaders(service) }, 405],
    ["/api/word-to-pdf", {
      method: "POST",
      headers: authorizedHeaders(service),
      body: JSON.stringify({ filename: "a.docx", contentBase64: "YQ==" }),
    }, 415],
    ["/api/word-to-pdf", {
      method: "POST",
      headers: { ...authorizedHeaders(service), "Content-Type": "application/json" },
      body: JSON.stringify({ filename: "a.docx", contentBase64: "YQ==", unexpected: true }),
    }, 400],
    ["/api/sign-installed", {
      method: "POST",
      headers: { ...authorizedHeaders(service), "Content-Type": "application/json" },
      body: JSON.stringify({ filename: "a.txt", thumbprint: "bad", contentBase64: "YQ==" }),
    }, 400],
    ["/api/sign-pdf-installed", {
      method: "POST",
      headers: { ...authorizedHeaders(service), "Content-Type": "application/json" },
      body: JSON.stringify({ filename: "a.pdf", thumbprint: THUMBPRINT, contentBase64: "JVBERi0=", placement: { page: 1 } }),
    }, 400],
  ];

  for (const [path, options, expectedStatus] of requests) {
    const response = await fetch(`${service.origin}${path}`, options);
    assert.equal(response.status, expectedStatus, path);
    const payload = await response.json();
    assert.match(payload.code, /^INVALID_|METHOD_NOT_ALLOWED|UNSUPPORTED_MEDIA_TYPE$/);
  }
  assert.equal(executions, 0);
});

test("enforces_streamed_body_limits_and_returns_typed_native_errors", async t => {
  const { service } = await createFixture(t, {
    convertOfficeDocument: async () => {
      throw Object.assign(new Error("Microsoft Word nao esta instalado."), { code: "WORD_UNAVAILABLE" });
    },
  });
  await openSession(service);

  const oversized = await new Promise((resolve, reject) => {
    const url = new URL(`${service.origin}/api/word-to-pdf`);
    const currentRequest = request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: "POST",
      headers: {
        ...authorizedHeaders(service),
        "Content-Type": "application/json",
        "Content-Length": String((56 * 1024 * 1024) + 1),
        Connection: "close",
      },
    }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode,
        json: () => JSON.parse(Buffer.concat(chunks).toString("utf8")),
      }));
    });
    currentRequest.on("error", reject);
    currentRequest.end();
  });
  assert.equal(oversized.status, 413);
  assert.equal(oversized.json().code, "REQUEST_TOO_LARGE");

  const word = await fetch(`${service.origin}/api/word-to-pdf`, {
    method: "POST",
    headers: { ...authorizedHeaders(service), "Content-Type": "application/json" },
    body: JSON.stringify({ filename: "relatorio.docx", contentBase64: "ZG9jeA==" }),
  });
  assert.equal(word.status, 503);
  assert.deepEqual(await word.json(), {
    error: "Microsoft Word nao esta instalado.",
    code: "WORD_UNAVAILABLE",
  });
});

test("returns_a_stable_413_when_the_native_output_exceeds_the_limit", async t => {
  const { service } = await createFixture(t, {
    convertOfficeDocument: async () => {
      throw Object.assign(new Error("Arquivo convertido excede o limite local."), { code: "OUTPUT_TOO_LARGE" });
    },
  });
  await openSession(service);

  const response = await fetch(`${service.origin}/api/word-to-pdf`, {
    method: "POST",
    headers: { ...authorizedHeaders(service), "Content-Type": "application/json" },
    body: JSON.stringify({ filename: "relatorio.docx", contentBase64: "ZG9jeA==" }),
  });
  assert.equal(response.status, 413);
  assert.equal((await response.json()).code, "OUTPUT_TOO_LARGE");
});

test("does_not_expose_unexpected_native_error_details_to_the_renderer_or_diagnostics", async t => {
  const diagnostics = [];
  const assetsRoot = await mkdtemp(join(tmpdir(), "docpronto-native-redaction-"));
  await writeFile(join(assetsRoot, "index.html"), "<!doctype html>");
  const service = await startDocProntoService({
    assetsRoot,
    sessionToken: TOKEN,
    onDiagnostic: event => diagnostics.push(event),
    capabilities: {
      listWindowsCertificates: async () => {
        const error = new Error("Falha em C:\\Users\\Pessoa\\documento-secreto.pdf");
        error.code = "ENOENT";
        throw error;
      },
      convertOfficeDocument: async () => assert.fail("not called"),
      signWithWindowsCertificate: async () => assert.fail("not called"),
      signPdfWithWindowsCertificate: async () => assert.fail("not called"),
    },
  });
  t.after(async () => {
    await service.close();
    await rm(assetsRoot, { recursive: true, force: true });
  });
  await openSession(service);

  const response = await fetch(`${service.origin}/api/certificates`, {
    headers: authorizedHeaders(service),
  });
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), {
    error: "Nao foi possivel concluir a operacao local.",
    code: "NATIVE_OPERATION_FAILED",
  });
  const serialized = JSON.stringify(diagnostics);
  assert.doesNotMatch(serialized, /Pessoa|documento-secreto|ENOENT/);
});

test("uses_a_service_private_temporary_root_and_removes_it_on_close", async t => {
  let operationRoot;
  const { service, temporaryParent } = await createFixture(t, {
    convertOfficeDocument: async (_input, _target, dependencies) => {
      operationRoot = dependencies.tempRoot;
      await writeFile(join(operationRoot, "proof.txt"), "temporary");
      return { filename: "saida.pdf", contentBase64: "JVBERi0=" };
    },
  });
  await openSession(service);
  const response = await fetch(`${service.origin}/api/word-to-pdf`, {
    method: "POST",
    headers: { ...authorizedHeaders(service), "Content-Type": "application/json" },
    body: JSON.stringify({ filename: "relatorio.docx", contentBase64: "ZG9jeA==" }),
  });
  assert.equal(response.status, 200);
  assert.ok(operationRoot.startsWith(temporaryParent));
  assert.equal((await readdir(temporaryParent)).length, 1);

  await service.close();
  assert.deepEqual(await readdir(temporaryParent), []);
});

test("renderer_requests_a_same_origin_POST_session_and_preserves_typed_errors", async () => {
  const source = await readFile(new URL("../../public/docpronto/app.js", import.meta.url), "utf8");
  assert.match(source, /fetch\(`\$\{apiBase\}\/api\/session`,\s*\{[^}]*method:\s*"POST"/s);
  assert.match(source, /Object\.assign\(new Error\(payload\.error[^)]*\),\s*\{\s*code:\s*payload\.code/s);
  assert.match(source, /\.\.\.\(pdfMode\s*\?\s*\{\s*placement\s*\}\s*:\s*\{\s*\}\)/s);
  assert.doesNotMatch(source, /127\.0\.0\.1:4174|DOCPronto-Conector-Windows/);
  assert.doesNotMatch(source, /Baixe o conector|execute o atualizador|conector local/i);
  assert.match(source, /Abra o aplicativo|Atualize o DOCPronto/);
});

test("landing_page_describes_the_desktop_app_instead_of_a_separate_connector", async () => {
  const source = await readFile(new URL("../../public/docpronto/index.html", import.meta.url), "utf8");
  assert.doesNotMatch(source, /conector local/i);
  assert.match(source, /aplicativo local/i);
});
