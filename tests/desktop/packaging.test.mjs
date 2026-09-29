import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const projectDir = join(import.meta.dirname, "..", "..");
const { resolveBuilderConfig } = require("../../electron-builder.config.cjs");

const EXPECTED_RUNTIME_INCLUDES = [
  "desktop/**/*",
  "public/docpronto/**/*",
  "package.json",
];

const REQUIRED_EXCLUSIONS = [
  "!**/.env*",
  "!tests{,/**/*}",
  "!docs{,/**/*}",
  "!app{,/**/*}",
  "!worker{,/**/*}",
  "!db{,/**/*}",
  "!drizzle{,/**/*}",
  "!examples{,/**/*}",
  "!scripts{,/**/*}",
  "!**/*.{bak,backup,log}",
  "!**/*.map",
];

test("configura_identidades_e_artefatos_distintos_por_canal", () => {
  const lab = resolveBuilderConfig("lab", projectDir);
  const stable = resolveBuilderConfig("stable", projectDir);

  assert.equal(lab.appId, "br.com.docpronto.desktop.lab");
  assert.equal(lab.productName, "DOCPronto Laboratorio");
  assert.equal(lab.win.icon, join(projectDir, "build", "icon-lab.ico"));
  assert.equal(lab.nsis.artifactName, "DOCPronto-Laboratorio-Setup-${version}-${arch}.${ext}");
  assert.equal(lab.portable.artifactName, "DOCPronto-Laboratorio-Portable-${version}-${arch}.${ext}");
  assert.equal(lab.directories.output, join(projectDir, "release", "lab"));
  assert.equal(lab.extraMetadata.docprontoChannel, "lab");
  assert.deepEqual(lab.publish, [{
    provider: "github",
    owner: "nikodeimus",
    repo: "DocPronto",
    channel: "lab",
    releaseType: "prerelease",
  }]);

  assert.equal(stable.appId, "br.com.docpronto.desktop");
  assert.equal(stable.productName, "DOCPronto");
  assert.equal(stable.win.icon, join(projectDir, "build", "icon.ico"));
  assert.equal(stable.nsis.artifactName, "DOCPronto-Setup-${version}-${arch}.${ext}");
  assert.equal(stable.portable.artifactName, "DOCPronto-Portable-${version}-${arch}.${ext}");
  assert.equal(stable.directories.output, join(projectDir, "release", "stable"));
  assert.equal(stable.extraMetadata.docprontoChannel, "stable");
  assert.equal(stable.publish[0].channel, "latest");
  assert.equal(stable.publish[0].releaseType, "release");
});

test("executavel_empacotado_descobre_o_canal_sem_argumento_ou_ambiente", async () => {
  const main = await readFile(join(projectDir, "desktop", "main.mjs"), "utf8");
  assert.match(main, /packageMetadata\.docprontoChannel/);
});

test("empacota_asar_alvos_windows_e_atalhos_do_instalador", () => {
  const config = resolveBuilderConfig("stable", projectDir);

  assert.deepEqual(config.asar, { smartUnpack: false });
  assert.equal("asarUnpack" in config, false);
  assert.deepEqual(config.win.target, [
    { target: "nsis", arch: ["x64"] },
    { target: "portable", arch: ["x64"] },
  ]);
  assert.equal(config.nsis.createDesktopShortcut, "always");
  assert.equal(config.nsis.createStartMenuShortcut, true);
  assert.equal(config.nsis.oneClick, false);
  assert.equal(config.nsis.perMachine, false);
});

test("inclui_somente_o_runtime_e_exclui_fontes_segredos_testes_backups_e_logs", () => {
  const { files } = resolveBuilderConfig("lab", projectDir);

  for (const include of EXPECTED_RUNTIME_INCLUDES) assert.ok(files.includes(include), include);
  for (const exclusion of REQUIRED_EXCLUSIONS) assert.ok(files.includes(exclusion), exclusion);
  assert.equal(files.some(pattern => /^app\//.test(pattern)), false);
  assert.equal(files.some(pattern => /^tests\//.test(pattern)), false);
});

test("mantem_dependencias_web_fora_do_runtime_desktop", async () => {
  const packageJson = JSON.parse(await readFile(join(projectDir, "package.json"), "utf8"));
  assert.deepEqual(Object.keys(packageJson.dependencies).sort(), ["electron-updater", "jszip"]);
  for (const dependency of ["next", "react", "react-dom", "docx-preview", "html2canvas", "drizzle-orm"]) {
    assert.ok(packageJson.devDependencies[dependency], dependency);
  }
});

test("portatil_usa_appData_e_nunca_a_pasta_do_executavel", async () => {
  const runtime = await readFile(join(projectDir, "desktop", "runtime.mjs"), "utf8");
  assert.match(runtime, /app\.getPath\("appData"\)/);
  assert.doesNotMatch(runtime, /PORTABLE_EXECUTABLE_DIR|dirname\(process\.execPath\)/);
});

test("scripts_desktop_usam_node_sem_shell_PowerShell", async () => {
  const packageJson = JSON.parse(await readFile(join(projectDir, "package.json"), "utf8"));
  assert.equal(packageJson.scripts["desktop:lab"], "node scripts/desktop-command.mjs --channel lab");
  assert.equal(packageJson.scripts["desktop:stable"], "node scripts/desktop-command.mjs --channel stable");
  assert.equal(packageJson.scripts["desktop:package:lab"], "node scripts/build-desktop.mjs --channel lab");
  assert.equal(packageJson.scripts["desktop:package:stable"], "node scripts/build-desktop.mjs --channel stable");
  for (const command of Object.values(packageJson.scripts)) {
    if (!command.includes("desktop")) continue;
    assert.doesNotMatch(command, /powershell|pwsh|\.ps1/i);
  }
});

test("comando_de_build_exige_canal_explicito_e_rejeita_valor_desconhecido", async () => {
  const { parseBuildArguments } = await import("../../scripts/build-desktop.mjs");
  assert.throws(
    () => parseBuildArguments([]),
    error => error.code === "MISSING_RELEASE_CHANNEL",
  );
  assert.throws(
    () => parseBuildArguments(["--channel", "preview"]),
    error => error.code === "INVALID_RELEASE_CHANNEL",
  );
  assert.deepEqual(parseBuildArguments(["--channel", "stable", "--dir"]), {
    channel: "stable",
    directory: true,
    skipTests: false,
  });
});

test("comando_de_abertura_inicia_Electron_diretamente_sem_shell", async () => {
  const { createDesktopCommand } = await import("../../scripts/desktop-command.mjs");
  const command = createDesktopCommand(["--channel", "stable"]);
  assert.match(command.command, /electron(?:\.exe)?$/i);
  assert.deepEqual(command.arguments.slice(-1), ["--channel=stable"]);
  assert.equal(command.options.env.DOCPRONTO_CHANNEL, "stable");
  assert.equal(command.options.shell, false);
  assert.equal(command.options.windowsHide, true);
});

test("icones_ICO_contem_cinco_resolucoes_RGBA_e_variantes_distintas", async () => {
  const expectedSizes = [16, 32, 48, 128, 256];
  const icons = await Promise.all([
    readFile(join(projectDir, "build", "icon.ico")),
    readFile(join(projectDir, "build", "icon-lab.ico")),
  ]);

  for (const icon of icons) {
    assert.equal(icon.readUInt16LE(0), 0);
    assert.equal(icon.readUInt16LE(2), 1);
    assert.equal(icon.readUInt16LE(4), expectedSizes.length);
    const sizes = expectedSizes.map((_, index) => {
      const value = icon.readUInt8(6 + (index * 16));
      return value === 0 ? 256 : value;
    });
    assert.deepEqual(sizes, expectedSizes);
    for (let index = 0; index < expectedSizes.length; index += 1) {
      assert.equal(icon.readUInt16LE(6 + (index * 16) + 6), 32);
    }
  }

  assert.notDeepEqual(icons[0], icons[1]);
});
