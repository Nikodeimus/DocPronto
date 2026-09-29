import assert from "node:assert/strict";
import test from "node:test";

import { inspectPackagedOutput } from "../../scripts/inspect-desktop-package.mjs";

const resourcesDirectory = process.env.DOCPRONTO_PACKAGED_RESOURCES;

test("pacote_real_mantem_runtime_no_ASAR_e_remove_arquivos_de_desenvolvimento", {
  skip: resourcesDirectory ? false : "Executado pelo build Desktop contra o pacote produzido.",
}, async () => {
  const result = await inspectPackagedOutput(resourcesDirectory);
  assert.equal(result.unpackedFiles.length, 0);
  assert.deepEqual(result.forbiddenFiles, []);
  assert.ok(result.archiveFiles.includes("/node_modules/jszip/package.json"));
  assert.ok(result.archiveFiles.includes("/node_modules/jszip/LICENSE.markdown"));
  assert.ok(result.archiveFiles.includes("/node_modules/electron-updater/package.json"));
  assert.ok(result.archiveFiles.includes("/node_modules/electron-updater/LICENSE"));
});
