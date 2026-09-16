import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import test from "node:test";

const read = path => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("site, manifesto, instalador e agente usam a mesma release", async () => {
  const [manifestText, server, installer, html, app] = await Promise.all([
    read("hub/agent-release.json"), read("server-cert-v8.mjs"), read("hub/instalar-agente.cmd"), read("hub/index.html"), read("hub/app.js")
  ]);
  const manifest = JSON.parse(manifestText);
  assert.match(server, new RegExp(`agentVersion = ["']${manifest.version.replaceAll(".", "\\.")}["']`));
  assert.match(installer, new RegExp(`set "RELEASE=${manifest.version.replaceAll(".", "\\.")}"`));
  assert.ok(installer.includes(manifest.server), "o instalador deve baixar exatamente a fonte declarada no manifesto");
  assert.match(html, new RegExp(`<script src="\\./app\\.js\\?v=${manifest.version.replaceAll(".", "\\.")}"></script>`));
  assert.doesNotMatch(html, /app-v\d+/);
  assert.match(app, /agent-release\.json/);
  assert.match(app, /\.\/instalar-agente\.cmd/);
});

test("hash publicado protege o arquivo do agente", async () => {
  const manifest = JSON.parse(await read("hub/agent-release.json"));
  const bytes = await readFile(new URL("../server-cert-v8.mjs", import.meta.url));
  const hash = createHash("sha256").update(bytes).digest("hex");
  assert.equal(hash, manifest.sha256);
  assert.match(await read("hub/instalar-agente.cmd"), new RegExp(hash));
});

test("o instalador migra agentes antigos sem encerrar processos alheios", async () => {
  const installer = await read("hub/instalar-agente.cmd");
  assert.match(installer, /Win32_Process/);
  assert.match(installer, /CommandLine/);
  assert.match(installer, /server-\(cert\|a3\)/);
  assert.match(installer, /--docpronto-agent/);
  assert.match(installer, /instalacao\.log/);
  assert.match(installer, /notepad\.exe/);
  const knownAgent = /(?:^|[\/"\s])server(?:-(?:cert|a3)(?:-v\d+)?)?\.mjs(?=$|["\s])/i;
  assert.ok(knownAgent.test("node server-cert-v20.mjs"));
  assert.ok(knownAgent.test("node server-a3-v5.mjs"));
  assert.ok(knownAgent.test("node server.mjs --docpronto-agent"));
  assert.equal(knownAgent.test("node sistema-de-terceiro.mjs"), false);
});

test("agente e Hub exigem pareamento local", async () => {
  const [server, app, installer] = await Promise.all([read("server-cert-v8.mjs"), read("hub/app.js"), read("hub/instalar-agente.cmd")]);
  assert.match(server, /DOCPRONTO_AGENT_TOKEN/);
  assert.match(server, /AGENT_PAIRING_REQUIRED/);
  assert.match(app, /X-DocPronto-Token/);
  assert.match(installer, /#agent=%AGENT_TOKEN%/);
});

test("o fluxo A3 possui gate local e fallback de arquitetura", async () => {
  const [server, app] = await Promise.all([read("server-cert-v8.mjs"), read("hub/app.js")]);
  assert.match(server, /SysWOW64/);
  assert.match(server, /A3_32BIT_FALLBACK/);
  assert.match(server, /stage: "PRIVATE_KEY"/);
  assert.match(app, /a3ReadyThumbprint/);
  assert.match(app, /Teste primeiro o leitor e o PIN/);
});
