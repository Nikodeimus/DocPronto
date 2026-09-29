import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { startDocProntoService } from "../../desktop/service/server.mjs";

async function createAssets(t) {
  const assetsRoot = await mkdtemp(join(tmpdir(), "docpronto-service-test-"));
  await writeFile(join(assetsRoot, "index.html"), "<!doctype html><title>DOCPronto</title>");
  await writeFile(join(assetsRoot, "app.js"), "globalThis.docpronto = true;");
  await writeFile(join(assetsRoot, "lab-ui.mjs"), "export const laboratory = true;");
  await writeFile(join(assetsRoot, "secret.txt"), "not public");
  t.after(() => rm(assetsRoot, { recursive: true, force: true }));
  return assetsRoot;
}

function rawRequest({ port, path = "/", headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, path, headers }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function getAvailablePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const { port } = probe.address();
  await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  return port;
}

test("binds_only_to_loopback_with_an_ephemeral_port", async t => {
  const assetsRoot = await createAssets(t);
  await assert.rejects(
    startDocProntoService({ assetsRoot, host: "0.0.0.0" }),
    /loopback/i,
  );
  await assert.rejects(
    startDocProntoService({ assetsRoot, port: await getAvailablePort() }).then(async service => {
      await service.close();
      return service;
    }),
    error => error.code === "INVALID_SERVICE_PORT",
  );
  const service = await startDocProntoService({ assetsRoot });
  t.after(() => service.close());

  assert.match(service.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(new URL(service.origin).port, String(service.port));
  assert.notEqual(service.port, 0);
});

test("serves_health_and_static_assets", async t => {
  const assetsRoot = await createAssets(t);
  const service = await startDocProntoService({ assetsRoot });
  t.after(() => service.close());

  const health = await fetch(`${service.origin}/api/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, service: "DocPronto Desktop" });

  const asset = await fetch(`${service.origin}/app.js`);
  assert.equal(asset.status, 200);
  assert.equal(asset.headers.get("content-type"), "text/javascript; charset=utf-8");
  assert.equal(asset.headers.get("x-content-type-options"), "nosniff");
  assert.equal(await asset.text(), "globalThis.docpronto = true;");

  const laboratoryModule = await fetch(`${service.origin}/lab-ui.mjs`);
  assert.equal(laboratoryModule.status, 200);
  assert.equal(laboratoryModule.headers.get("content-type"), "text/javascript; charset=utf-8");
  assert.equal(await laboratoryModule.text(), "export const laboratory = true;");
});

test("health_expõe_versao_e_canal_do_executavel_quando_fornecidos", async t => {
  const assetsRoot = await createAssets(t);
  const service = await startDocProntoService({
    assetsRoot,
    appInfo: { version: "0.1.0-lab.0", channel: "lab" },
  });
  t.after(() => service.close());

  const response = await fetch(`${service.origin}/api/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    service: "DocPronto Desktop",
    version: "0.1.0-lab.0",
    channel: "lab",
  });
});

test("rejects_wrong_host_and_path_traversal", async t => {
  const assetsRoot = await createAssets(t);
  const service = await startDocProntoService({ assetsRoot });
  t.after(() => service.close());

  const wrongHost = await rawRequest({
    port: service.port,
    path: "/api/health",
    headers: { Host: "evil.example" },
  });
  assert.equal(wrongHost.status, 403);

  const wrongOrigin = await rawRequest({
    port: service.port,
    path: "/api/health",
    headers: { Host: `127.0.0.1:${service.port}`, Origin: "https://evil.example" },
  });
  assert.equal(wrongOrigin.status, 403);
  assert.equal(wrongOrigin.headers["access-control-allow-origin"], undefined);

  const traversal = await rawRequest({
    port: service.port,
    path: "/%2e%2e/secret.txt",
    headers: { Host: `127.0.0.1:${service.port}` },
  });
  assert.equal(traversal.status, 404);
});

test("closes_without_leaking_the_listener", async t => {
  const assetsRoot = await createAssets(t);
  const service = await startDocProntoService({ assetsRoot });

  await service.close();
  await service.close();

  const replacement = createServer();
  await new Promise((resolve, reject) => {
    replacement.once("error", reject);
    replacement.listen(service.port, "127.0.0.1", resolve);
  });
  await new Promise((resolve, reject) => replacement.close(error => error ? reject(error) : resolve()));
});
