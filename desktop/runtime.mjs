import { join } from "node:path";

import { getChannelConfig } from "./config/channel.mjs";
import { createMainWindow } from "./window.mjs";

const IPC_CHANNELS = Object.freeze([
  "docpronto:get-app-info",
  "docpronto:diagnostics:list",
  "docpronto:diagnostics:clear",
  "docpronto:diagnostics:export",
  "docpronto:diagnostics:record",
]);

function technicalDetails(error) {
  return {
    name: error?.name,
    code: error?.code,
    message: error?.message,
    stack: error?.stack,
  };
}

function defaultHealthCheck() {
  return Promise.resolve();
}

export function createDesktopRuntime({
  app,
  BrowserWindow,
  ipcMain,
  shell,
  startService,
  createStore,
  updateManager,
  channel,
  createWindow = createMainWindow,
  exportDiagnostics,
  initializeOptionalCapabilities = async () => {},
  healthCheck = defaultHealthCheck,
  assetsRoot,
  preloadPath,
  sessionToken,
} = {}) {
  const channelConfig = getChannelConfig(channel);
  let mainWindow;
  let service;
  let store;
  let startPromise;
  let stopPromise;
  let lifecycleStopPromise;
  let optionalReady = Promise.resolve();
  let ipcRegistered = false;
  let lifecycleRegistered = false;
  let gracefulExitStarted = false;

  async function recordDiagnostic(event) {
    if (!store) return;
    try {
      await store.append(event);
    } catch {
      // Diagnostics are best-effort and cannot break the desktop lifecycle.
    }
  }

  function environment() {
    return {
      appVersion: app.getVersion?.() ?? "unknown",
      electron: process.versions.electron ?? "unknown",
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      channel: channelConfig.channel,
    };
  }

  function registerIpc() {
    if (ipcRegistered) return;
    ipcRegistered = true;
    ipcMain.handle("docpronto:get-app-info", async () => ({
      ...environment(),
      productName: channelConfig.productName,
      isLab: channelConfig.isLab,
    }));
    ipcMain.handle("docpronto:diagnostics:list", (_event, filters = {}) => store.list(filters));
    ipcMain.handle("docpronto:diagnostics:clear", () => store.clear());
    ipcMain.handle("docpronto:diagnostics:record", (_event, diagnosticEvent) => store.append(diagnosticEvent));
    ipcMain.handle("docpronto:diagnostics:export", async (_event, options = {}) => {
      if (typeof exportDiagnostics !== "function") {
        throw Object.assign(new Error("Diagnostic export is unavailable."), {
          code: "DIAGNOSTIC_EXPORT_UNAVAILABLE",
        });
      }
      return exportDiagnostics({
        events: await store.list({ limit: 2_000 }),
        environment: environment(),
        destination: options.destination,
      });
    });
  }

  function bringWindowToFront() {
    if (!mainWindow) return;
    if (mainWindow.isMinimized?.()) mainWindow.restore();
    mainWindow.show?.();
    mainWindow.focus?.();
  }

  async function initializeDeferredFeatures() {
    const operations = [
      ["DESKTOP_UPDATE_INIT_FAILED", () => updateManager?.initialize?.({ channelConfig })],
      ["OPTIONAL_CAPABILITY_INIT_FAILED", () => initializeOptionalCapabilities({ channelConfig })],
    ];
    await Promise.all(operations.map(async ([code, operation]) => {
      try {
        await operation();
      } catch (error) {
        await recordDiagnostic({
          level: "warning",
          tool: "desktop",
          stage: "deferred-initialization",
          code,
          message: "Um componente opcional nao pode ser inicializado.",
          technical: technicalDetails(error),
        });
      }
    }));
  }

  async function stop() {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      if (ipcRegistered) {
        for (const name of IPC_CHANNELS) ipcMain.removeHandler?.(name);
        ipcRegistered = false;
      }
      const currentService = service;
      const currentStore = store;
      service = undefined;
      store = undefined;
      await Promise.allSettled([
        currentService?.close?.(),
        currentStore?.close?.(),
      ]);
    })();
    return stopPromise;
  }

  function registerLifecycle() {
    if (lifecycleRegistered) return;
    lifecycleRegistered = true;
    app.on("second-instance", bringWindowToFront);
    app.on("before-quit", event => {
      if (gracefulExitStarted) return;
      gracefulExitStarted = true;
      event?.preventDefault?.();
      lifecycleStopPromise = stop().finally(() => {
        if (typeof app.exit === "function") app.exit(0);
        else app.quit();
      });
    });
    app.on("window-all-closed", () => {
      if (process.platform !== "darwin") app.quit();
    });
  }

  async function startOnce() {
    if (!app.requestSingleInstanceLock()) {
      app.quit();
      return false;
    }
    registerLifecycle();

    const userData = join(app.getPath("appData"), channelConfig.userDataName);
    app.setName?.(channelConfig.productName);
    app.setPath("userData", userData);
    await app.whenReady();
    store = createStore({ userData, channelConfig });
    registerIpc();

    try {
      service = await startService({
        assetsRoot,
        sessionToken,
        onDiagnostic: event => { void recordDiagnostic(event); },
      });
      await healthCheck({ origin: service.origin, sessionToken });
    } catch (error) {
      await recordDiagnostic({
        level: "error",
        tool: "desktop-service",
        stage: "startup",
        code: "DESKTOP_SERVICE_START_FAILED",
        message: "Nao foi possivel iniciar o servico local do DOCPronto.",
        technical: technicalDetails(error),
      });
      await stop();
      app.quit();
      throw error;
    }

    mainWindow = createWindow({
      BrowserWindow,
      origin: service.origin,
      preloadPath,
      channelConfig,
      shell,
    });
    mainWindow.once?.("closed", () => { mainWindow = undefined; });
    mainWindow.once?.("ready-to-show", () => {
      mainWindow?.show?.();
      optionalReady = initializeDeferredFeatures();
    });
    return true;
  }

  return {
    start() {
      if (!startPromise) startPromise = startOnce();
      return startPromise;
    },
    stop,
    get stopped() { return lifecycleStopPromise ?? stopPromise ?? Promise.resolve(); },
    get optionalReady() { return optionalReady; },
    get window() { return mainWindow; },
  };
}
