import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import electronUpdater from "electron-updater";

import { DiagnosticStore } from "./diagnostics/store.mjs";
import { exportDiagnosticBundle } from "./diagnostics/export.mjs";
import { resolveRuntimeChannel } from "./config/channel.mjs";
import { createDesktopRuntime } from "./runtime.mjs";
import { createUpdateManager } from "./update/manager.mjs";
import { startDocProntoService } from "./service/server.mjs";
import { listWindowsCertificates } from "./service/windows-capabilities.mjs";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const packageMetadata = require("../package.json");
const channel = resolveRuntimeChannel({
  isPackaged: app.isPackaged,
  packageChannel: packageMetadata.docprontoChannel,
  arguments: process.argv,
  environment: process.env,
});
const sessionToken = randomBytes(32).toString("hex");

async function checkServiceHealth({ origin }) {
  const response = await fetch(`${origin}/api/health`, {
    headers: { "x-docpronto-token": sessionToken },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    throw Object.assign(new Error(`Local service health check failed with HTTP ${response.status}.`), {
      code: "DESKTOP_SERVICE_HEALTH_FAILED",
    });
  }
}

const runtime = createDesktopRuntime({
  app,
  BrowserWindow,
  ipcMain,
  shell,
  channel,
  startService: startDocProntoService,
  createStore: options => new DiagnosticStore(options),
  createUpdateManager: options => {
    if (!app.isPackaged) return { start: async () => false, dispose() {} };
    return createUpdateManager({ ...options, autoUpdater: electronUpdater.autoUpdater });
  },
  exportDiagnostics: exportDiagnosticBundle,
  chooseDiagnosticDestination: async ({ window }) => {
    const date = new Date().toISOString().slice(0, 10);
    const result = await dialog.showSaveDialog(window, {
      title: "Exportar diagnostico do DOCPronto",
      defaultPath: `docpronto-diagnostico-${date}.zip`,
      filters: [{ name: "Arquivo ZIP", extensions: ["zip"] }],
      properties: ["createDirectory", "showOverwriteConfirmation"],
    });
    return result.canceled ? null : result.filePath;
  },
  reportFatalError: error => {
    dialog.showErrorBox(
      "DOCPronto nao iniciou",
      `Nao foi possivel abrir o DOCPronto.\n\nCodigo: ${error.code}`,
    );
  },
  initializeOptionalCapabilities: async () => {
    if (process.platform === "win32") await listWindowsCertificates();
  },
  healthCheck: checkServiceHealth,
  assetsRoot: join(currentDirectory, "..", "public", "docpronto"),
  preloadPath: join(currentDirectory, "preload.cjs"),
  sessionToken,
});

void runtime.start().catch(error => {
  console.error(`[DOCPronto] startup failed (${error.code ?? "DESKTOP_START_FAILED"}):`, error);
});
