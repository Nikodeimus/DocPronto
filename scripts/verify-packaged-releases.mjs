import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { inspectPackagedOutput } from "./inspect-desktop-package.mjs";

const projectDir = resolve(fileURLToPath(new URL("..", import.meta.url)));

export async function verifyPackagedReleases({ root = projectDir } = {}) {
  const channels = [
    { channel: "lab", productName: "DOCPronto Laboratorio" },
    { channel: "stable", productName: "DOCPronto" },
  ];
  const results = [];
  for (const identity of channels) {
    const resources = join(root, "release", identity.channel, "win-unpacked", "resources");
    const result = await inspectPackagedOutput(resources, {
      expectedChannel: identity.channel,
      expectedProductName: identity.productName,
    });
    assert.deepEqual(result.unpackedFiles, [], `${identity.channel}: app.asar.unpacked must be empty`);
    assert.deepEqual(result.forbiddenFiles, [], `${identity.channel}: forbidden archive files`);
    assert.deepEqual(result.outsideAllowlist, [], `${identity.channel}: files outside allowlist`);
    assert.deepEqual(result.sensitiveContentFiles, [], `${identity.channel}: personal paths in packaged text`);
    assert.deepEqual(result.identityErrors, [], `${identity.channel}: package identity mismatch`);
    results.push({ channel: identity.channel, files: result.archiveFiles.length });
  }
  return results;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const results = await verifyPackagedReleases();
  console.log(`Packaged releases verified: ${results.map(item => `${item.channel} (${item.files} files)`).join(", ")}.`);
}
