import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { createRequire } from "node:module";

const projectDir = join(import.meta.dirname, "..", "..");
const require = createRequire(import.meta.url);
const { resolveBuilderConfig } = require("../../electron-builder.config.cjs");

test("desktop_verify_e_o_unico_gate_de_release_local", async () => {
  const packageJson = JSON.parse(await readFile(join(projectDir, "package.json"), "utf8"));
  const gate = packageJson.scripts["desktop:verify"];

  assert.equal(typeof gate, "string");
  assert.match(gate, /tests\/\*\.test\.mjs/);
  assert.match(gate, /tests\/desktop\/\*\.test\.mjs/);
  assert.match(gate, /build-desktop\.mjs --channel lab --dir --skip-tests/);
  assert.match(gate, /smoke-desktop\.mjs/);
});

test("smoke_empacotado_tem_um_protocolo_observavel_e_limites_fixos", async () => {
  const smoke = await import("../../scripts/smoke-desktop.mjs");

  assert.equal(smoke.UI_TIMEOUT_MS, 3_000);
  assert.equal(smoke.HEALTH_TIMEOUT_MS, 15_000);
  assert.equal(typeof smoke.runPackagedSmoke, "function");
  assert.deepEqual(smoke.REQUIRED_EVENTS, [
    "service-ready",
    "ui-ready",
    "optional-capability-failed",
    "second-instance",
    "stopping",
  ]);
});

test("configuracao_estavel_nao_carrega_identidade_LAB", () => {
  const stable = resolveBuilderConfig("stable", projectDir, {});
  const serialized = JSON.stringify({
    appId: stable.appId,
    productName: stable.productName,
    metadata: stable.extraMetadata,
    output: stable.directories.output,
    artifacts: [stable.nsis.artifactName, stable.portable.artifactName],
  });

  assert.doesNotMatch(serialized, /laborat[oó]rio|\bLAB\b|docpronto-laboratorio/i);
  assert.equal(stable.extraMetadata.docprontoChannel, "stable");
});

test("contrato_de_empacotamento_bloqueia_dados_locais_e_fixtures_reais", () => {
  const { files } = resolveBuilderConfig("lab", projectDir, {});
  const required = [
    "!**/.env*",
    "!**/*.{bak,backup,log}",
    "!tests{,/**/*}",
    "!**/fixtures{,/**/*}",
    "!**/Downloads{,/**/*}",
    "!**/downloads{,/**/*}",
  ];

  for (const exclusion of required) assert.ok(files.includes(exclusion), exclusion);
});

test("README_desktop_declara_limites_e_operacao_dos_dois_canais", async () => {
  const readme = await readFile(join(projectDir, "README-DESKTOP.md"), "utf8");

  for (const term of [
    "DOCPronto Laboratorio",
    "DOCPronto Estavel",
    "SmartScreen",
    "Authenticode",
    "Microsoft Word",
    "certificado",
    "GitHub Releases",
    "desktop:verify",
  ]) assert.match(readme, new RegExp(term, "i"), term);
});
