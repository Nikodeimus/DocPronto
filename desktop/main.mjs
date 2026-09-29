import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
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
const integrityPolicy = {
  mode: packageMetadata.docprontoIntegrityMode ?? "checksum-only",
  publisherNames: packageMetadata.docprontoPublisherNames ?? [],
};
const channel = resolveRuntimeChannel({
  isPackaged: app.isPackaged,
  packageChannel: packageMetadata.docprontoChannel,
  arguments: process.argv,
  environment: process.env,
});
const sessionToken = randomBytes(32).toString("hex");
const smokeMode = process.env.DOCPRONTO_SMOKE === "1";

function smokePath(name) {
  const candidate = process.env[name];
  if (!smokeMode || !candidate) return null;
  const temporaryRoot = resolve(tmpdir());
  const resolved = resolve(candidate);
  const fromTemporaryRoot = relative(temporaryRoot, resolved);
  if (fromTemporaryRoot.startsWith("..") || fromTemporaryRoot === "" || fromTemporaryRoot.includes("..")) {
    throw Object.assign(new Error(`${name} must be inside the system temporary directory.`), {
      code: "INVALID_SMOKE_PATH",
    });
  }
  return resolved;
}

const smokeReportPath = smokePath("DOCPRONTO_SMOKE_REPORT");
const smokeControlPath = smokePath("DOCPRONTO_SMOKE_CONTROL");
function reportSmoke(event) {
  if (!smokeReportPath) return;
  appendFileSync(smokeReportPath, `${JSON.stringify({
    ...event,
    pid: process.pid,
    timestamp: new Date().toISOString(),
    uptimeMs: Math.round(process.uptime() * 1_000),
  })}\n`, { encoding: "utf8", flag: "a" });
}

let smokeControlTimer;
if (smokeControlPath) {
  smokeControlTimer = setInterval(() => {
    try {
      if (!existsSync(smokeControlPath)) return;
      const command = readFileSync(smokeControlPath, "utf8").trim();
      unlinkSync(smokeControlPath);
      if (command === "quit") app.quit();
    } catch (error) {
      reportSmoke({ type: "control-failed", code: error.code ?? "SMOKE_CONTROL_FAILED" });
    }
  }, 50);
  smokeControlTimer.unref();
}

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
  startService: options => startDocProntoService({
    ...options,
    appInfo: { version: app.getVersion(), channel },
  }),
  createStore: options => new DiagnosticStore(options),
  createUpdateManager: options => {
    if (smokeMode) return { start: async () => false, dispose() {} };
    if (!app.isPackaged) return { start: async () => false, dispose() {} };
    return createUpdateManager({
      ...options,
      autoUpdater: electronUpdater.autoUpdater,
      integrityPolicy,
    });
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
    if (smokeMode && process.env.DOCPRONTO_SMOKE_MISSING_OPTIONALS === "1") {
      reportSmoke({ type: "optional-capability-failed", capability: "word", code: "WORD_UNAVAILABLE" });
      reportSmoke({ type: "optional-capability-failed", capability: "certificate", code: "CERTIFICATE_NOT_FOUND" });
      return;
    }
    if (process.platform === "win32") await listWindowsCertificates();
  },
  healthCheck: checkServiceHealth,
  assetsRoot: join(currentDirectory, "..", "public", "docpronto"),
  preloadPath: join(currentDirectory, "preload.cjs"),
  sessionToken,
  onLifecycleEvent: event => {
    if (event.type === "service-ready") {
      reportSmoke({ ...event, sessionToken, version: app.getVersion(), channel });
    } else {
      reportSmoke(event);
    }
    if (event.type === "stopping" && smokeControlTimer) clearInterval(smokeControlTimer);
  },
});

void runtime.start().catch(error => {
  console.error(`[DOCPronto] startup failed (${error.code ?? "DESKTOP_START_FAILED"}):`, error);
});
