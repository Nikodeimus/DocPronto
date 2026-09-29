import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, ipcMain, shell } from "electron";
import electronUpdater from "electron-updater";

import { DiagnosticStore } from "./diagnostics/store.mjs";
import { exportDiagnosticBundle } from "./diagnostics/export.mjs";
import { createDesktopRuntime } from "./runtime.mjs";
import { startDocProntoService } from "./service/server.mjs";
import { listWindowsCertificates } from "./service/windows-capabilities.mjs";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const channelArgument = process.argv.find(argument => argument.startsWith("--channel="));
const channel = channelArgument?.slice("--channel=".length) || process.env.DOCPRONTO_CHANNEL || "lab";
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

const updateManager = {
  async initialize({ channelConfig }) {
    if (!app.isPackaged) return;
    const { autoUpdater } = electronUpdater;
    autoUpdater.channel = channelConfig.updateChannel;
    autoUpdater.autoDownload = false;
    await autoUpdater.checkForUpdatesAndNotify();
  },
};

const runtime = createDesktopRuntime({
  app,
  BrowserWindow,
  ipcMain,
  shell,
  channel,
  startService: startDocProntoService,
  createStore: options => new DiagnosticStore(options),
  updateManager,
  exportDiagnostics: exportDiagnosticBundle,
  initializeOptionalCapabilities: async () => {
    if (process.platform === "win32") await listWindowsCertificates();
  },
  healthCheck: checkServiceHealth,
  assetsRoot: join(currentDirectory, "..", "public", "docpronto"),
  preloadPath: join(currentDirectory, "preload.mjs"),
  sessionToken,
});

void runtime.start().catch(() => {
  // Startup diagnostics are persisted by the runtime before Electron exits.
});
