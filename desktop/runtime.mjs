import { join } from "node:path";

import { getChannelConfig } from "./config/channel.mjs";
import { createMainWindow } from "./window.mjs";

const IPC_CHANNELS = Object.freeze([
  "docpronto:get-app-info",
  "docpronto:window-painted",
  "docpronto:diagnostics:list",
  "docpronto:diagnostics:clear",
  "docpronto:diagnostics:export",
  "docpronto:diagnostics:record",
]);
const FILTER_KEYS = new Set(["level", "tool", "stage", "code", "executionId", "since", "until", "limit"]);
const EVENT_KEYS = new Set(["level", "tool", "stage", "code", "message", "technical", "durationMs", "metadata"]);
const STARTUP_CODES = Object.freeze({
  configuration: "DESKTOP_CONFIGURATION_FAILED",
  store: "DESKTOP_STORE_START_FAILED",
  service: "DESKTOP_SERVICE_START_FAILED",
  ipc: "DESKTOP_IPC_START_FAILED",
  window: "DESKTOP_WINDOW_START_FAILED",
  "window-load": "DESKTOP_WINDOW_LOAD_FAILED",
});

function ipcArgumentError(message) {
  return Object.assign(new TypeError(message), { code: "INVALID_IPC_ARGUMENTS" });
}

function isPlainObject(value) {
  if (!value || Object.prototype.toString.call(value) !== "[object Object]") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateFilters(filters) {
  if (filters === undefined) return {};
  if (!isPlainObject(filters)) throw ipcArgumentError("Diagnostic filters must be an object.");
  for (const [key, value] of Object.entries(filters)) {
    if (!FILTER_KEYS.has(key)) throw ipcArgumentError(`Unsupported diagnostic filter: ${key}`);
    if (key === "limit") {
      if (!Number.isInteger(value) || value < 0 || value > 2_000) {
        throw ipcArgumentError("Diagnostic limit must be an integer between 0 and 2000.");
      }
    } else if (typeof value !== "string" || value.length > 256) {
      throw ipcArgumentError(`Diagnostic filter ${key} must be a short string.`);
    }
  }
  return filters;
}

function validateDiagnosticEvent(event) {
  if (!isPlainObject(event)) throw ipcArgumentError("Diagnostic event must be an object.");
  for (const key of Object.keys(event)) {
    if (!EVENT_KEYS.has(key)) throw ipcArgumentError(`Unsupported diagnostic event field: ${key}`);
  }
  let serialized;
  try {
    serialized = JSON.stringify(event);
  } catch {
    throw ipcArgumentError("Diagnostic event must be serializable.");
  }
  if (!serialized || Buffer.byteLength(serialized) > 64 * 1024) {
    throw ipcArgumentError("Diagnostic event exceeds the IPC limit.");
  }
  return event;
}

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
  createUpdateManager,
  channel,
  createWindow = createMainWindow,
  exportDiagnostics,
  chooseDiagnosticDestination,
  reportFatalError = () => {},
  initializeOptionalCapabilities = async () => {},
  healthCheck = defaultHealthCheck,
  onLifecycleEvent = () => {},
  assetsRoot,
  preloadPath,
  sessionToken,
} = {}) {
  const channelConfig = getChannelConfig(channel);
  let mainWindow;
  let service;
  let store;
  let updateManager;
  let startPromise;
  let stopPromise;
  let lifecycleStopPromise;
  let optionalReady = Promise.resolve();
  let ipcRegistered = false;
  let lifecycleRegistered = false;
  let gracefulExitStarted = false;
  let windowPainted = false;

  function emitLifecycleEvent(event) {
    try {
      onLifecycleEvent({ ...event, timestamp: new Date().toISOString() });
    } catch {
      // Smoke observability is best-effort and cannot affect the application.
    }
  }

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

    function assertTrustedSender(event) {
      const frame = event?.senderFrame;
      const mainFrame = event?.sender?.mainFrame;
      let trustedOrigin = false;
      try {
        trustedOrigin = new URL(frame?.url).origin === service.origin;
      } catch {
        trustedOrigin = false;
      }
      if (!frame || !mainFrame || frame !== mainFrame || !trustedOrigin) {
        throw Object.assign(new Error("IPC sender is not trusted."), {
          code: "UNTRUSTED_IPC_SENDER",
        });
      }
    }

    function handle(name, validateArguments, operation) {
      ipcMain.handle(name, async (event, ...args) => {
        assertTrustedSender(event);
        const validated = validateArguments(args);
        return operation(...validated);
      });
    }

    const noArguments = args => {
      if (args.length !== 0) throw ipcArgumentError("This IPC operation does not accept arguments.");
      return [];
    };

    handle("docpronto:get-app-info", noArguments, async () => ({
      ...environment(),
      productName: channelConfig.productName,
      isLab: channelConfig.isLab,
    }));
    handle("docpronto:window-painted", noArguments, async () => {
      if (!mainWindow?.isVisible()) return false;
      if (!windowPainted) {
        windowPainted = true;
        emitLifecycleEvent({ type: "window-painted", windowVisible: true, framePainted: true });
        optionalReady = initializeDeferredFeatures();
      }
      return true;
    });
    handle("docpronto:diagnostics:list", args => {
      if (args.length > 1) throw ipcArgumentError("Diagnostic list accepts at most one argument.");
      return [validateFilters(args[0])];
    }, filters => store.list(filters));
    handle("docpronto:diagnostics:clear", noArguments, () => store.clear());
    handle("docpronto:diagnostics:record", args => {
      if (args.length !== 1) throw ipcArgumentError("Diagnostic record requires one event.");
      return [validateDiagnosticEvent(args[0])];
    }, diagnosticEvent => store.append(diagnosticEvent));
    handle("docpronto:diagnostics:export", noArguments, async () => {
      if (typeof exportDiagnostics !== "function") {
        throw Object.assign(new Error("Diagnostic export is unavailable."), {
          code: "DIAGNOSTIC_EXPORT_UNAVAILABLE",
        });
      }
      if (typeof chooseDiagnosticDestination !== "function") {
        throw Object.assign(new Error("Diagnostic destination selection is unavailable."), {
          code: "DIAGNOSTIC_DESTINATION_UNAVAILABLE",
        });
      }
      const destination = await chooseDiagnosticDestination({ window: mainWindow, channelConfig });
      if (destination === null || destination === undefined) return null;
      if (typeof destination !== "string" || !destination) {
        throw Object.assign(new Error("Diagnostic destination selection returned an invalid path."), {
          code: "INVALID_DIAGNOSTIC_DESTINATION",
        });
      }
      return exportDiagnostics({
        events: await store.list({ limit: 2_000 }),
        environment: environment(),
        destination,
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
      ["DESKTOP_UPDATE_INIT_FAILED", async () => {
        if (typeof createUpdateManager !== "function") return;
        updateManager ??= await createUpdateManager({
          channelConfig,
          appVersion: app.getVersion?.() ?? "unknown",
          diagnostics: { append: recordDiagnostic },
        });
        await updateManager.start();
      }],
      ["OPTIONAL_CAPABILITY_INIT_FAILED", () => initializeOptionalCapabilities({ channelConfig })],
    ];
    await Promise.all(operations.map(async ([code, operation]) => {
      try {
        await operation();
      } catch (error) {
        emitLifecycleEvent({
          type: "optional-capability-failed",
          code: error?.code ?? code,
        });
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
      emitLifecycleEvent({ type: "stopping" });
      if (ipcRegistered) {
        for (const name of IPC_CHANNELS) ipcMain.removeHandler?.(name);
        ipcRegistered = false;
      }
      const currentService = service;
      const currentStore = store;
      const currentWindow = mainWindow;
      const currentUpdateManager = updateManager;
      service = undefined;
      store = undefined;
      mainWindow = undefined;
      const cleanupOperations = [
        () => currentUpdateManager?.dispose?.(),
        () => {
          if (currentWindow && !currentWindow.isDestroyed?.()) currentWindow.destroy?.();
        },
        () => currentService?.close?.(),
        () => currentStore?.close?.(),
      ];
      updateManager = undefined;
      await Promise.allSettled(cleanupOperations.map(operation => Promise.resolve().then(operation)));
    })();
    return stopPromise;
  }

  function registerLifecycle() {
    if (lifecycleRegistered) return;
    lifecycleRegistered = true;
    app.on("second-instance", () => {
      emitLifecycleEvent({ type: "second-instance" });
      bringWindowToFront();
    });
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
    let startupStage = "configuration";
    try {
      registerLifecycle();
      const userData = join(app.getPath("appData"), channelConfig.userDataName);
      app.setName?.(channelConfig.productName);
      app.setPath("userData", userData);
      await app.whenReady();

      startupStage = "store";
      store = createStore({ userData, channelConfig });

      startupStage = "service";
      service = await startService({
        assetsRoot,
        sessionToken,
        onDiagnostic: event => { void recordDiagnostic(event); },
      });
      const serviceHealth = healthCheck({ origin: service.origin, sessionToken });

      startupStage = "ipc";
      registerIpc();

      startupStage = "window";
      mainWindow = createWindow({
        BrowserWindow,
        origin: service.origin,
        preloadPath,
        channelConfig,
        shell,
      });
      mainWindow.once?.("closed", () => { mainWindow = undefined; });
      mainWindow.show?.();

      startupStage = "service";
      await serviceHealth;
      emitLifecycleEvent({ type: "service-ready", origin: service.origin });

      startupStage = "window-load";
      await (mainWindow.docprontoLoadPromise ?? Promise.resolve());
      return true;
    } catch (cause) {
      const code = cause?.code === "DESKTOP_WINDOW_LOAD_FAILED"
        ? cause.code
        : STARTUP_CODES[startupStage] ?? "DESKTOP_START_FAILED";
      const error = Object.assign(new Error(cause?.message || "DOCPronto desktop startup failed.", { cause }), {
        code,
      });
      await recordDiagnostic({
        level: "error",
        tool: "desktop",
        stage: "startup",
        code,
        message: "Nao foi possivel iniciar o DOCPronto.",
        technical: technicalDetails(cause),
      });
      await stop();
      try {
        reportFatalError(error);
      } catch {
        // The fatal reporting surface cannot prevent process cleanup.
      }
      app.quit();
      throw error;
    }
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
