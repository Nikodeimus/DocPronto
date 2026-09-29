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
  assert.match(gate, /build-desktop\.mjs --channel stable --dir --skip-tests/);
  assert.match(gate, /verify-packaged-releases\.mjs/);
  assert.match(gate, /smoke-desktop\.mjs/);
});

test("smoke_empacotado_tem_um_protocolo_observavel_e_limites_fixos", async () => {
  const smoke = await import("../../scripts/smoke-desktop.mjs");

  assert.equal(smoke.UI_TIMEOUT_MS, 3_000);
  assert.equal(smoke.HEALTH_TIMEOUT_MS, 15_000);
  assert.equal(smoke.PREPARATION_LAUNCHES, 2);
  assert.equal(typeof smoke.runPackagedSmoke, "function");
  assert.equal(typeof smoke.runPackagedSmokes, "function");
  assert.throws(
    () => smoke.assertLaunchDuration(3_001),
    error => error.code === "SMOKE_UI_SLOW",
  );
  assert.doesNotThrow(() => smoke.assertLaunchDuration(3_000));
  assert.deepEqual(smoke.REQUIRED_EVENTS, [
    "service-ready",
    "window-painted",
    "certificate-capability",
    "word-capability",
    "second-instance",
    "stopping",
  ]);
  const smokeSource = await readFile(join(projectDir, "scripts", "smoke-desktop.mjs"), "utf8");
  assert.doesNotMatch(smokeSource, /--disable-gpu/);
  assert.doesNotMatch(smokeSource, /spawn\(executable[\s\S]{0,220}windowsHide:\s*true/);
  assert.match(smokeSource, /DOCPronto Laboratorio\.exe/);
  assert.match(smokeSource, /DOCPronto\.exe/);
  assert.equal(smoke.acceptsCertificateCapability({ capability: "certificate", status: "unavailable", code: "CERTIFICATE_PROVIDER_UNAVAILABLE" }), true);
  assert.equal(smoke.acceptsCertificateCapability({ capability: "certificate", status: "unavailable", code: "RANDOM_PROVIDER_FAILURE" }), false);
  assert.equal(smoke.acceptsWordCapability({ capability: "word", status: "unavailable", code: "WORD_UNAVAILABLE" }), true);
  assert.equal(smoke.acceptsWordCapability({ capability: "word", status: "unavailable", code: "RANDOM_WORD_FAILURE" }), false);
});

test("smoke_nao_fabrica_indisponibilidade_de_Word_ou_certificado", async () => {
  const smoke = await readFile(join(projectDir, "scripts", "smoke-desktop.mjs"), "utf8");
  const main = await readFile(join(projectDir, "desktop", "main.mjs"), "utf8");
  assert.doesNotMatch(smoke, /SMOKE_MISSING_OPTIONALS|WORD_UNAVAILABLE/);
  assert.doesNotMatch(main, /SMOKE_MISSING_OPTIONALS/);
  assert.doesNotMatch(main, /smokeControlTimer\.unref/);
  assert.match(main, /listWindowsCertificates\(\)/);
  assert.match(main, /certificate-capability/);
});

test("renderer_sinaliza_frame_pintado_somente_apos_janela_visivel", async () => {
  const app = await readFile(join(projectDir, "public", "docpronto", "app.js"), "utf8");
  const html = await readFile(join(projectDir, "public", "docpronto", "index.html"), "utf8");
  const main = await readFile(join(projectDir, "desktop", "runtime.mjs"), "utf8");
  const smoke = await readFile(join(projectDir, "scripts", "smoke-desktop.mjs"), "utf8");
  const desktopMain = await readFile(join(projectDir, "desktop", "main.mjs"), "utf8");
  assert.match(app, /requestAnimationFrame[\s\S]*requestAnimationFrame[\s\S]*signalPainted/);
  assert.match(app, /signalPainted[\s\S]*import\("\.\/lab-ui\.mjs/);
  assert.match(main, /isVisible\(\)/);
  assert.match(app, /await loadToolLibraries\(\)[\s\S]*activeTool\.action/);
  assert.doesNotMatch(html, /<script\s+src="vendor\//);
  assert.doesNotMatch(html, /<script[^>]+src="lab-ui\.mjs/);
  assert.match(smoke, /waitForEvent\(reportPath, event => event\.type === "stopping"/);
  assert.doesNotMatch(desktopMain, /^import electronUpdater/m);
  assert.match(desktopMain, /await import\("electron-updater"\)/);
  assert.doesNotMatch(desktopMain, /^import \{ exportDiagnosticBundle \}/m);
  assert.match(desktopMain, /await import\("\.\/diagnostics\/export\.mjs"\)/);
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
    "motor visual próprio",
    "reconstrução/OCR local",
  ]) assert.match(readme, new RegExp(term, "i"), term);
});
