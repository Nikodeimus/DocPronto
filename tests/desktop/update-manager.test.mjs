import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { getChannelConfig } from "../../desktop/config/channel.mjs";
import { createUpdateManager } from "../../desktop/update/manager.mjs";

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
    checkResult: { updateInfo: { version: "1.0.0", channel: "latest" } },
  });

  await harness.manager.start();

  assert.equal(await harness.manager.download(), false);
  assert.equal(harness.autoUpdater.downloadCalls, 0);
  assert.ok(harness.events.some(event => event.code === "UPDATE_CHANNEL_REJECTED"));
});

test("canal estavel rejeita prerelease laboratorio", async () => {
  const harness = createHarness("stable", {
    checkResult: { updateInfo: { version: "1.0.0-lab.2", channel: "lab" } },
  });

  await harness.manager.start();

  assert.equal(await harness.manager.download(), false);
  assert.equal(harness.autoUpdater.downloadCalls, 0);
  assert.ok(harness.events.some(event => event.code === "UPDATE_CHANNEL_REJECTED"));
});

test("falha de hash ou assinatura gera diagnostico de integridade", async () => {
  const harness = createHarness("stable", {
    checkResult: { updateInfo: { version: "1.0.1", channel: "latest" } },
    downloadError: Object.assign(new Error("sha512 checksum mismatch"), { code: "ERR_UPDATER_INVALID_SIGNATURE" }),
  });
  await harness.manager.start();

  assert.equal(await harness.manager.download(), false);

  assert.ok(harness.events.some(event => event.code === "UPDATE_INTEGRITY_FAILED"));
});

test("download concluido nao instala imediatamente", async () => {
  const harness = createHarness("lab", {
    checkResult: { updateInfo: { version: "0.2.0-lab.1", channel: "lab" } },
  });
  await harness.manager.start();

  assert.equal(await harness.manager.download(), true);
  harness.autoUpdater.emit("update-downloaded", { version: "0.2.0-lab.1", channel: "lab" });

  assert.equal(harness.autoUpdater.quitAndInstallCalls, 0);
  assert.equal(harness.autoUpdater.autoDownload, false);
  assert.equal(harness.autoUpdater.autoInstallOnAppQuit, true);
  assert.equal(harness.manager.installOnQuit(), true);
  assert.equal(harness.autoUpdater.quitAndInstallCalls, 0);
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
  assert.match(workflow, /!startsWith\(github\.ref_name, 'lab-v'\)/);
  assert.match(workflow, /desktop:package:lab/);
  assert.match(workflow, /desktop:package:stable/);
  assert.match(workflow, /Get-FileHash[^\n]+SHA256/);
  assert.match(workflow, /latest\.yml/);
  assert.match(workflow, /lab\.yml/);
  assert.match(workflow, /prerelease:/);
  assert.match(workflow, /GITHUB_TOKEN/);
});
