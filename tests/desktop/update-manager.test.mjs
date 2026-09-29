import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { getChannelConfig } from "../../desktop/config/channel.mjs";
import { createUpdateManager } from "../../desktop/update/manager.mjs";

const VALID_SHA512 = Buffer.alloc(64, 7).toString("base64");

function updateInfo(version, channel, sha512 = VALID_SHA512) {
  return {
    version,
    channel,
    files: [{ url: `DOCPronto-Setup-${version}-x64.exe`, sha512, size: 100 }],
  };
}

class FakeUpdater extends EventEmitter {
  constructor({ checkResult, checkError, downloadError } = {}) {
    super();
    this.checkResult = checkResult;
    this.checkError = checkError;
    this.downloadError = downloadError;
    this.checkCalls = 0;
    this.downloadCalls = 0;
    this.quitAndInstallCalls = 0;
  }

  async checkForUpdates() {
    this.checkCalls += 1;
    if (this.checkError) throw this.checkError;
    if (this.checkResult?.updateInfo) this.emit("update-available", this.checkResult.updateInfo);
    return this.checkResult;
  }

  async downloadUpdate() {
    this.downloadCalls += 1;
    if (this.downloadError) throw this.downloadError;
    return ["C:\\Temp\\docpronto-update.exe"];
  }

  quitAndInstall() {
    this.quitAndInstallCalls += 1;
  }
}

function createHarness(channel, updaterOptions = {}) {
  const events = [];
  const autoUpdater = new FakeUpdater(updaterOptions);
  const manager = createUpdateManager({
    autoUpdater,
    channelConfig: getChannelConfig(channel),
    diagnostics: { append: async event => { events.push(event); } },
    appVersion: "0.1.0",
    integrityPolicy: updaterOptions.integrityPolicy,
  });
  return { autoUpdater, events, manager };
}

test("modo offline registra warning redigido e nao rejeita start", async () => {
  const harness = createHarness("stable", {
    checkError: Object.assign(new Error("connect C:\\Users\\Maria\\segredo.txt"), { code: "ENETUNREACH" }),
  });

  await assert.doesNotReject(harness.manager.start());

  assert.equal(harness.autoUpdater.checkCalls, 1);
  const warning = harness.events.find(event => event.code === "UPDATE_CHECK_UNAVAILABLE");
  assert.equal(warning.level, "warning");
  assert.doesNotMatch(JSON.stringify(warning), /Maria|segredo\.txt/);
});

test("canal laboratorio rejeita release latest", async () => {
  const harness = createHarness("lab", {
    checkResult: { updateInfo: updateInfo("1.0.0", "latest") },
  });

  await harness.manager.start();

  assert.equal(await harness.manager.download(), false);
  assert.equal(harness.autoUpdater.downloadCalls, 0);
  assert.ok(harness.events.some(event => event.code === "UPDATE_CHANNEL_REJECTED"));
});

test("canal estavel rejeita prerelease laboratorio", async () => {
  const harness = createHarness("stable", {
    checkResult: { updateInfo: updateInfo("1.0.0-lab.2", "lab") },
  });

  await harness.manager.start();

  assert.equal(await harness.manager.download(), false);
  assert.equal(harness.autoUpdater.downloadCalls, 0);
  assert.ok(harness.events.some(event => event.code === "UPDATE_CHANNEL_REJECTED"));
});

test("falha de hash ou assinatura gera diagnostico de integridade", async () => {
  const harness = createHarness("stable", {
    checkResult: { updateInfo: updateInfo("1.0.1", "latest") },
    downloadError: Object.assign(new Error("sha512 checksum mismatch"), { code: "ERR_UPDATER_INVALID_SIGNATURE" }),
  });
  await harness.manager.start();

  assert.equal(await harness.manager.download(), false);

  assert.ok(harness.events.some(event => event.code === "UPDATE_INTEGRITY_FAILED"));
});

test("falha Authenticode em build configurado impede instalacao", async () => {
  const harness = createHarness("stable", {
    checkResult: { updateInfo: updateInfo("1.0.1", "latest") },
    downloadError: Object.assign(new Error("publisher signature mismatch"), {
      code: "ERR_UPDATER_INVALID_SIGNATURE",
    }),
    integrityPolicy: {
      mode: "checksum+authenticode",
      publisherNames: ["DOCPronto Software Ltda"],
    },
  });

  await harness.manager.start();

  assert.equal(harness.manager.installOnQuit(), false);
  assert.equal(harness.autoUpdater.quitAndInstallCalls, 0);
  assert.ok(harness.events.some(event => event.code === "UPDATE_INTEGRITY_FAILED"));
});

test("start baixa automaticamente uma atualizacao compativel sem instalar durante o uso", async () => {
  const harness = createHarness("lab", {
    checkResult: { updateInfo: updateInfo("0.2.0-lab.1", "lab") },
  });
  await harness.manager.start();

  assert.equal(harness.autoUpdater.downloadCalls, 1);
  harness.autoUpdater.emit("update-downloaded", updateInfo("0.2.0-lab.1", "lab"));

  assert.equal(harness.autoUpdater.quitAndInstallCalls, 0);
  assert.equal(harness.autoUpdater.autoDownload, false);
  assert.equal(harness.autoUpdater.autoInstallOnAppQuit, true);
  assert.equal(harness.manager.installOnQuit(), true);
  assert.equal(harness.autoUpdater.quitAndInstallCalls, 0);
});

test("download chamado antes do check nao impede o download automatico posterior", async () => {
  const harness = createHarness("lab", {
    checkResult: { updateInfo: updateInfo("0.2.0-lab.1", "lab") },
  });

  assert.equal(await harness.manager.download(), false);
  await harness.manager.start();

  assert.equal(harness.autoUpdater.downloadCalls, 1);
});

test("manifesto sem SHA-512 valido e rejeitado antes do download", async () => {
  const harness = createHarness("lab", {
    checkResult: { updateInfo: updateInfo("0.2.0-lab.1", "lab", "nao-e-sha512") },
  });

  await harness.manager.start();

  assert.equal(harness.autoUpdater.downloadCalls, 0);
  assert.equal(harness.manager.installOnQuit(), false);
  assert.ok(harness.events.some(event => event.code === "UPDATE_INTEGRITY_FAILED"));
});

test("LAB unsigned declara checksum-only sem simular Authenticode", async () => {
  const harness = createHarness("lab", {
    checkResult: { updateInfo: null },
    integrityPolicy: { mode: "checksum-only", publisherNames: [] },
  });

  await harness.manager.start();

  const policy = harness.events.find(event => event.code === "UPDATE_INTEGRITY_POLICY");
  assert.equal(policy.metadata.integrityMode, "checksum-only");
  assert.equal(policy.metadata.authenticodeVerified, false);
  assert.doesNotMatch(JSON.stringify(policy), /assinado|signed/i);
});

test("politica Authenticode exige publisherName configurado", () => {
  assert.throws(
    () => createUpdateManager({
      autoUpdater: new FakeUpdater(),
      channelConfig: getChannelConfig("stable"),
      diagnostics: { append: async () => {} },
      appVersion: "1.0.0",
      integrityPolicy: { mode: "checksum+authenticode", publisherNames: [] },
    }),
    error => error.code === "INVALID_UPDATE_INTEGRITY_POLICY",
  );
});

test("dispose remove listeners e start e idempotente", async () => {
  const harness = createHarness("stable", { checkResult: { updateInfo: null } });
  await Promise.all([harness.manager.start(), harness.manager.start()]);
  assert.equal(harness.autoUpdater.checkCalls, 1);

  harness.manager.dispose();
  assert.equal(harness.autoUpdater.listenerCount("error"), 0);
  assert.equal(harness.autoUpdater.listenerCount("update-downloaded"), 0);
});

test("workflow separa tags, canais e publica hashes e metadados", async () => {
  const root = join(import.meta.dirname, "..", "..");
  const workflow = await readFile(join(root, ".github", "workflows", "desktop-release.yml"), "utf8");

  assert.match(workflow, /lab-v\*/);
  assert.match(workflow, /["']v\*["']/);
  assert.match(workflow, /startsWith\(github\.ref_name, 'lab-v'\)/);
  assert.match(workflow, /startsWith\(github\.ref_name, 'v'\)/);
  assert.match(workflow, /!contains\(github\.ref_name, '-'\)/);
  assert.equal((workflow.match(/prepare-desktop-release\.mjs/g) ?? []).length, 2);
  assert.match(workflow, /prepare-desktop-release\.mjs[^\n]+--channel lab/);
  assert.match(workflow, /prepare-desktop-release\.mjs[^\n]+--channel stable[^\n]+--require-signed/);
  assert.match(workflow, /WINDOWS_CSC_LINK/);
  assert.match(workflow, /WINDOWS_CSC_KEY_PASSWORD/);
  assert.match(workflow, /WINDOWS_PUBLISHER_NAME/);
  assert.doesNotMatch(workflow, /runs-on: windows-latest\r?\n\s+env:/);
  assert.match(workflow, /desktop:package:lab:ci/);
  assert.match(workflow, /desktop:package:stable:ci/);
  assert.match(workflow, /integrityMode = '\$\{\{ steps\.release\.outputs\.integrity_mode \}\}'/);
  assert.match(workflow, /signed = \[System\.Convert\]::ToBoolean\('\$\{\{ steps\.release\.outputs\.signed \}\}'\)/);
  assert.match(workflow, /desktop:package:lab/);
  assert.match(workflow, /desktop:package:stable/);
  assert.match(workflow, /Get-FileHash[^\n]+SHA256/);
  assert.match(workflow, /latest\.yml/);
  assert.match(workflow, /lab\.yml/);
  assert.match(workflow, /prerelease:/);
  assert.match(workflow, /GITHUB_TOKEN/);
});

function workflowJob(workflow, jobName) {
  const startMatch = new RegExp(`^  ${jobName}:\\r?$`, "m").exec(workflow);
  assert.ok(startMatch, `job ${jobName} ausente`);
  const remainder = workflow.slice(startMatch.index + startMatch[0].length);
  const nextJob = /^  [a-z][a-z0-9_-]*:\r?$/m.exec(remainder);
  return workflow.slice(startMatch.index, nextJob ? startMatch.index + startMatch[0].length + nextJob.index : undefined);
}

test("build e testes de release nao recebem contents write", async () => {
  const root = join(import.meta.dirname, "..", "..");
  const workflow = await readFile(join(root, ".github", "workflows", "desktop-release.yml"), "utf8");

  assert.match(workflow, /^permissions:\r?\n  contents: read$/m);

  for (const jobName of ["laboratory_build", "stable_build"]) {
    const job = workflowJob(workflow, jobName);
    assert.match(job, /permissions:\r?\n      contents: read/);
    assert.doesNotMatch(job, /contents: write/);
    assert.match(job, /npm (?:ci|test)|npm run desktop:test/);
    assert.match(job, /actions\/checkout@[0-9a-f]{40}/);
    assert.match(job, /persist-credentials: false/);
    assert.match(job, /actions\/upload-artifact@[0-9a-f]{40}/);
    assert.doesNotMatch(job, /action-gh-release/);
  }
});

test("publicacao e isolada em jobs sem checkout build ou testes", async () => {
  const root = join(import.meta.dirname, "..", "..");
  const workflow = await readFile(join(root, ".github", "workflows", "desktop-release.yml"), "utf8");

  for (const [jobName, buildJob] of [
    ["laboratory_publish", "laboratory_build"],
    ["stable_publish", "stable_build"],
  ]) {
    const job = workflowJob(workflow, jobName);
    assert.match(job, new RegExp(`needs: ${buildJob}`));
    assert.match(job, /permissions:\r?\n      contents: write/);
    assert.match(job, /actions\/download-artifact@[0-9a-f]{40}/);
    assert.match(job, /softprops\/action-gh-release@[0-9a-f]{40}/);
    assert.doesNotMatch(job, /actions\/checkout|actions\/setup-node|npm (?:ci|test)|desktop:package/);
  }
});

test("actions do workflow de release usam somente SHAs imutaveis", async () => {
  const root = join(import.meta.dirname, "..", "..");
  const workflow = await readFile(join(root, ".github", "workflows", "desktop-release.yml"), "utf8");
  const references = [...workflow.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)/gm)].map(match => match[1]);

  assert.ok(references.length >= 8);
  for (const reference of references) {
    assert.match(reference, /^[^@\s]+@[0-9a-f]{40}$/, reference);
  }
});
