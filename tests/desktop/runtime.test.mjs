import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { createDesktopRuntime } from "../../desktop/runtime.mjs";

function createHarness({ lock = true, serviceError, optionalError } = {}) {
  const app = new EventEmitter();
  const paths = new Map([["appData", "C:\\Users\\Test\\AppData\\Roaming"]]);
  app.getPath = name => paths.get(name);
  app.setPath = (name, value) => paths.set(name, value);
  app.requestSingleInstanceLock = () => lock;
  app.quitCalls = 0;
  app.quit = () => { app.quitCalls += 1; };
  app.exitCalls = [];
  app.exit = code => { app.exitCalls.push(code); };
  app.whenReady = async () => {};
  app.getVersion = () => "0.1.0";

  const diagnostics = [];
  const store = {
    append: async event => { diagnostics.push(event); },
    list: async filters => [{ filters }],
    clearCalls: 0,
    async clear() { this.clearCalls += 1; },
    closeCalls: 0,
    async close() { this.closeCalls += 1; },
  };
  const service = {
    origin: "http://127.0.0.1:43123",
    closeCalls: 0,
    async close() { this.closeCalls += 1; },
  };
  const window = new EventEmitter();
  window.restoreCalls = 0;
  window.focusCalls = 0;
  window.showCalls = 0;
  window.isMinimized = () => true;
  window.restore = () => { window.restoreCalls += 1; };
  window.focus = () => { window.focusCalls += 1; };
  window.show = () => { window.showCalls += 1; };

  const ipcHandlers = new Map();
  const ipcMain = { handle: (name, handler) => ipcHandlers.set(name, handler), removeHandler: name => ipcHandlers.delete(name) };
  const calls = { service: 0, store: 0, window: 0, updater: 0, optional: 0 };
  return {
    app, store, service, window, diagnostics, ipcHandlers, calls,
    dependencies: {
      app,
      BrowserWindow: class {},
      ipcMain,
      shell: {},
      channel: "lab",
      createStore: ({ userData }) => {
        calls.store += 1;
        assert.equal(userData, "C:\\Users\\Test\\AppData\\Roaming\\DOCPronto-Laboratorio");
        return store;
      },
      startService: async ({ onDiagnostic }) => {
        calls.service += 1;
        if (serviceError) throw serviceError;
        await onDiagnostic({ code: "LOCAL_SERVICE_STARTED" });
        return service;
      },
      createWindow: options => {
        calls.window += 1;
        assert.equal(options.origin, service.origin);
        return window;
      },
      updateManager: { async initialize() { calls.updater += 1; } },
      initializeOptionalCapabilities: async () => {
        calls.optional += 1;
        if (optionalError) throw optionalError;
      },
      exportDiagnostics: async options => ({ options }),
      preloadPath: "C:\\app\\desktop\\preload.mjs",
    },
  };
}

test("lock negado encerra sem criar servico, store ou janela", async () => {
  const harness = createHarness({ lock: false });
  const runtime = createDesktopRuntime(harness.dependencies);
  await runtime.start();
  assert.equal(harness.app.quitCalls, 1);
  assert.deepEqual(harness.calls, { service: 0, store: 0, window: 0, updater: 0, optional: 0 });
});

test("lock aceito configura userData e inicia exatamente um servico", async () => {
  const harness = createHarness();
  const runtime = createDesktopRuntime(harness.dependencies);
  await Promise.all([runtime.start(), runtime.start()]);
  assert.equal(harness.calls.service, 1);
  assert.equal(harness.calls.store, 1);
  assert.equal(harness.calls.window, 1);
});

test("segunda instancia restaura, mostra e foca a janela existente", async () => {
  const harness = createHarness();
  const runtime = createDesktopRuntime(harness.dependencies);
  await runtime.start();
  harness.app.emit("second-instance");
  assert.equal(harness.window.restoreCalls, 1);
  assert.equal(harness.window.showCalls, 1);
  assert.equal(harness.window.focusCalls, 1);
});

test("before-quit fecha store e servico exatamente uma vez", async () => {
  const harness = createHarness();
  const runtime = createDesktopRuntime(harness.dependencies);
  await runtime.start();
  const first = runtime.stop();
  const second = runtime.stop();
  harness.app.emit("before-quit");
  await Promise.all([first, second, runtime.stopped]);
  assert.equal(harness.store.closeCalls, 1);
  assert.equal(harness.service.closeCalls, 1);
});

test("before-quit segura a saida ate concluir o encerramento", async () => {
  const harness = createHarness();
  const runtime = createDesktopRuntime(harness.dependencies);
  await runtime.start();
  const event = { prevented: 0, preventDefault() { this.prevented += 1; } };
  harness.app.emit("before-quit", event);
  await runtime.stopped;
  assert.equal(event.prevented, 1);
  assert.deepEqual(harness.app.exitCalls, [0]);
});

test("capacidade opcional com falha nao impede a janela", async () => {
  const harness = createHarness({ optionalError: Object.assign(new Error("Word ausente"), { code: "WORD_NOT_AVAILABLE" }) });
  const runtime = createDesktopRuntime(harness.dependencies);
  await runtime.start();
  harness.window.emit("ready-to-show");
  await runtime.optionalReady;
  assert.equal(harness.calls.window, 1);
  assert.equal(harness.calls.updater, 1);
  assert.ok(harness.diagnostics.some(event => event.code === "OPTIONAL_CAPABILITY_INIT_FAILED"));
});

test("falha ao iniciar servico registra codigo estavel e encerra", async () => {
  const harness = createHarness({ serviceError: Object.assign(new Error("EADDRINUSE"), { code: "EADDRINUSE" }) });
  const runtime = createDesktopRuntime(harness.dependencies);
  await assert.rejects(runtime.start(), /EADDRINUSE/);
  assert.ok(harness.diagnostics.some(event => event.code === "DESKTOP_SERVICE_START_FAILED"));
  assert.equal(harness.app.quitCalls, 1);
  assert.equal(harness.calls.window, 0);
});

test("IPC expoe somente contratos enumerados e usa o store", async () => {
  const harness = createHarness();
  const runtime = createDesktopRuntime(harness.dependencies);
  await runtime.start();
  assert.deepEqual([...harness.ipcHandlers.keys()].sort(), [
    "docpronto:diagnostics:clear",
    "docpronto:diagnostics:export",
    "docpronto:diagnostics:list",
    "docpronto:diagnostics:record",
    "docpronto:get-app-info",
  ]);
  const info = await harness.ipcHandlers.get("docpronto:get-app-info")();
  assert.equal(info.channel, "lab");
  assert.equal(info.isLab, true);
  await harness.ipcHandlers.get("docpronto:diagnostics:record")(null, { code: "TEST_EVENT" });
  assert.ok(harness.diagnostics.some(event => event.code === "TEST_EVENT"));
});
