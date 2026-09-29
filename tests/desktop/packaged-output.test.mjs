import assert from "node:assert/strict";
import test from "node:test";

import * as packageInspector from "../../scripts/inspect-desktop-package.mjs";

const { classifyArchiveEntries, inspectPackagedOutput } = packageInspector;

const packageDirectory = process.env.DOCPRONTO_PACKAGED_OUTPUT;
const expectedChannel = process.env.DOCPRONTO_PACKAGED_CHANNEL;
const expectedProductName = process.env.DOCPRONTO_PACKAGED_PRODUCT;

test("classificador_rejeita_arquivos_fora_da_allowlist_e_dados_de_desenvolvimento", () => {
  const result = classifyArchiveEntries([
    "/package.json",
    "/desktop/main.mjs",
    "/public/docpronto/index.html",
    "/node_modules/jszip/package.json",
    "/tests/real-fixture.pdf",
    "/docs/internal.md",
    "/C:/Users/Financeiro/Downloads/client.log",
    "/desktop/main.mjs.map",
    "/secrets/.env.production",
    "/unexpected.txt",
  ]);
  assert.deepEqual(result.outsideAllowlist, [
    "/tests/real-fixture.pdf",
    "/docs/internal.md",
    "/C:/Users/Financeiro/Downloads/client.log",
    "/secrets/.env.production",
    "/unexpected.txt",
  ]);
  assert.deepEqual(result.forbiddenFiles, [
    "/tests/real-fixture.pdf",
    "/docs/internal.md",
    "/C:/Users/Financeiro/Downloads/client.log",
    "/desktop/main.mjs.map",
    "/secrets/.env.production",
  ]);
});

test("classificador_rejeita_artefatos_proibidos_fora_do_ASAR", () => {
  assert.equal(typeof packageInspector.classifyExternalEntries, "function");
  const result = packageInspector.classifyExternalEntries([
    "DOCPronto.exe",
    "resources/app.asar",
    "resources/app-update.yml",
    "resources/.env.production",
    "resources/debug.log",
    "tests/smoke.spec.mjs",
    "Downloads/cliente.pdf",
    "locales/pt-BR.pak.map",
  ]);

  assert.deepEqual(result.forbiddenExternalFiles, [
    "resources/.env.production",
    "resources/debug.log",
    "tests/smoke.spec.mjs",
    "Downloads/cliente.pdf",
    "locales/pt-BR.pak.map",
  ]);
});

test("pacote_real_mantem_runtime_no_ASAR_e_remove_arquivos_de_desenvolvimento", {
  skip: packageDirectory ? false : "Executado pelo build Desktop contra o pacote produzido.",
}, async () => {
  const result = await inspectPackagedOutput(packageDirectory, { expectedChannel, expectedProductName });
  assert.equal(result.unpackedFiles.length, 0);
  assert.deepEqual(result.forbiddenFiles, []);
  assert.deepEqual(result.outsideAllowlist, []);
  assert.deepEqual(result.sensitiveContentFiles, []);
  assert.deepEqual(result.forbiddenExternalFiles, []);
  assert.deepEqual(result.sensitiveExternalContentFiles, []);
  assert.deepEqual(result.identityErrors, []);
  assert.ok(result.externalFiles.includes("resources/app.asar"));
  assert.ok(result.externalFiles.some(file => file.toLowerCase().endsWith(".exe")));
  assert.ok(result.archiveFiles.includes("/node_modules/jszip/package.json"));
  assert.ok(result.archiveFiles.includes("/node_modules/jszip/LICENSE.markdown"));
  assert.ok(result.archiveFiles.includes("/node_modules/electron-updater/package.json"));
  assert.ok(result.archiveFiles.includes("/node_modules/electron-updater/LICENSE"));
});
