import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyArchiveEntries,
  inspectPackagedOutput,
} from "../../scripts/inspect-desktop-package.mjs";

const resourcesDirectory = process.env.DOCPRONTO_PACKAGED_RESOURCES;
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

test("pacote_real_mantem_runtime_no_ASAR_e_remove_arquivos_de_desenvolvimento", {
  skip: resourcesDirectory ? false : "Executado pelo build Desktop contra o pacote produzido.",
}, async () => {
  const result = await inspectPackagedOutput(resourcesDirectory, { expectedChannel, expectedProductName });
  assert.equal(result.unpackedFiles.length, 0);
  assert.deepEqual(result.forbiddenFiles, []);
  assert.deepEqual(result.outsideAllowlist, []);
  assert.deepEqual(result.sensitiveContentFiles, []);
  assert.deepEqual(result.identityErrors, []);
  assert.ok(result.archiveFiles.includes("/node_modules/jszip/package.json"));
  assert.ok(result.archiveFiles.includes("/node_modules/jszip/LICENSE.markdown"));
  assert.ok(result.archiveFiles.includes("/node_modules/electron-updater/package.json"));
  assert.ok(result.archiveFiles.includes("/node_modules/electron-updater/LICENSE"));
});
