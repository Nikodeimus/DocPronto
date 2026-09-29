import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  CHANNELS,
  getChannelConfig,
  normalizeChannel,
} from "../../desktop/config/channel.mjs";

const EXPECTED_SITES_SCRIPTS = {
  "install:ci": "bash scripts/install-ci.sh",
  dev: "WRANGLER_LOG_PATH=.wrangler/wrangler.log vite",
  build: "bash scripts/build-verified.sh",
  start: "WRANGLER_LOG_PATH=.wrangler/wrangler.log vinext start",
  test: "npm run build && node --test tests/*.test.mjs",
  "validate:artifact": "bash scripts/validate-artifact.sh",
  lint: "bash scripts/sites-env.sh -- eslint . --ignore-pattern dist --ignore-pattern .next",
  "db:generate": "bash scripts/sites-env.sh -- drizzle-kit generate",
};

test("defines_the_stable_channel_identity", () => {
  assert.equal(CHANNELS.STABLE, "stable");
  assert.deepEqual(getChannelConfig("stable"), {
    channel: "stable",
    productName: "DOCPronto",
    appId: "br.com.docpronto.desktop",
    userDataName: "DOCPronto",
    updateChannel: "latest",
    isLab: false,
  });
});

test("defines_the_lab_channel_identity", () => {
  assert.equal(CHANNELS.LAB, "lab");
  assert.deepEqual(getChannelConfig("lab"), {
    channel: "lab",
    productName: "DOCPronto Laboratorio",
    appId: "br.com.docpronto.desktop.lab",
    userDataName: "DOCPronto-Laboratorio",
    updateChannel: "lab",
    isLab: true,
  });
});

test("defaults_a_missing_channel_to_lab", () => {
  assert.equal(normalizeChannel(), "lab");
});

test("rejects_unknown_channels_with_a_stable_code", () => {
  assert.throws(
    () => normalizeChannel("preview"),
    error => error.code === "INVALID_RELEASE_CHANNEL",
  );
});

test("returns_immutable_channel_configuration", () => {
  assert.equal(Object.isFrozen(CHANNELS), true);

  for (const channel of ["lab", "stable"]) {
    const config = getChannelConfig(channel);
    assert.equal(Object.isFrozen(config), true);
    assert.throws(() => {
      config.productName = "Changed";
    }, TypeError);
  }
});

test("sets_the_Electron_entrypoint_without_replacing_Sites_scripts", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));

  assert.equal(packageJson.main, "desktop/main.mjs");
  for (const [name, command] of Object.entries(EXPECTED_SITES_SCRIPTS)) {
    assert.equal(packageJson.scripts[name], command);
  }
});
