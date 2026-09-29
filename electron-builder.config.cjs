"use strict";

/* eslint-disable @typescript-eslint/no-require-imports -- electron-builder loads this file as CommonJS. */

const { join, resolve } = require("node:path");
const { getChannelConfig } = require("./desktop/config/channel-data.cjs");

const RUNTIME_FILES = Object.freeze([
  "desktop/**/*",
  "public/docpronto/**/*",
  "package.json",
  "!public/docpronto/downloads{,/**/*}",
  "!**/.env*",
  "!tests{,/**/*}",
  "!docs{,/**/*}",
  "!app{,/**/*}",
  "!worker{,/**/*}",
  "!db{,/**/*}",
  "!drizzle{,/**/*}",
  "!examples{,/**/*}",
  "!scripts{,/**/*}",
  "!release{,/**/*}",
  "!coverage{,/**/*}",
  "!**/*.{bak,backup,log}",
  "!**/*.map",
]);

function resolveBuilderConfig(channel, projectDir = __dirname) {
  const root = resolve(projectDir);
  const identity = getChannelConfig(channel);
  const artifactPrefix = identity.isLab ? "DOCPronto-Laboratorio" : "DOCPronto";
  return {
    appId: identity.appId,
    productName: identity.productName,
    asar: true,
    asarUnpack: [],
    npmRebuild: false,
    electronVersion: "44.4.5",
    directories: {
      app: root,
      buildResources: join(root, "build"),
      output: join(root, "release", identity.channel),
    },
    files: [...RUNTIME_FILES],
    extraMetadata: {
      name: identity.isLab ? "docpronto-laboratorio" : "docpronto",
      productName: identity.productName,
      main: "desktop/main.mjs",
      docprontoChannel: identity.channel,
    },
    win: {
      icon: join(root, "build", identity.isLab ? "icon-lab.ico" : "icon.ico"),
      target: [
        { target: "nsis", arch: ["x64"] },
        { target: "portable", arch: ["x64"] },
      ],
    },
    nsis: {
      artifactName: `${artifactPrefix}-Setup-\${version}-\${arch}.\${ext}`,
      oneClick: false,
      perMachine: false,
      allowToChangeInstallationDirectory: true,
      createDesktopShortcut: "always",
      createStartMenuShortcut: true,
      shortcutName: identity.productName,
      uninstallDisplayName: identity.productName,
    },
    portable: {
      artifactName: `${artifactPrefix}-Portable-\${version}-\${arch}.\${ext}`,
      requestExecutionLevel: "user",
    },
  };
}

module.exports = { RUNTIME_FILES, resolveBuilderConfig };
