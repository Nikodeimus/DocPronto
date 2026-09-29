import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { createDesktopRuntime } from "../../desktop/runtime.mjs";

function createHarness({
  lock = true,
  serviceError,
  optionalError,
  storeError,
  windowError,
  loadError,
  ipcError,
  destroyError,
} = {}) {
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
  window.destroyCalls = 0;
  window.destroy = () => {
    window.destroyCalls += 1;
    if (destroyError) throw destroyError;
  };
  window.docprontoLoadPromise = loadError ? Promise.reject(loadError) : Promise.resolve();

  const ipcHandlers = new Map();
  const ipcMain = {
    handle(name, handler) {
      if (ipcError) throw ipcError;
      ipcHandlers.set(name, handler);
    },
    removeHandler: name => ipcHandlers.delete(name),
  };
  const calls = { service: 0, store: 0, window: 0, updater: 0, updaterDispose: 0, optional: 0, export: 0 };
  const fatalErrors = [];
  const lifecycleEvents = [];
  return {
    app, store, service, window, diagnostics, ipcHandlers, calls, fatalErrors, lifecycleEvents,
    trustedEvent() {
      const senderFrame = { url: `${service.origin}/` };
      return { senderFrame, sender: { mainFrame: senderFrame } };
    },
    dependencies: {
      app,
      BrowserWindow: class {},
      ipcMain,
      shell: {},
      channel: "lab",
      createStore: ({ userData }) => {
        calls.store += 1;
        assert.equal(userData, "C:\\Users\\Test\\AppData\\Roaming\\DOCPronto-Laboratorio");
        if (storeError) throw storeError;
        return store;
      },
      startService: async ({ onDiagnostic }) => {
        calls.service += 1;
        if (serviceError) throw serviceError;
        onDiagnostic({ code: "LOCAL_SERVICE_STARTED" });
        return service;
      },
      createWindow: options => {
        calls.window += 1;
        assert.equal(options.origin, service.origin);
        if (windowError) throw windowError;
        return window;
      },
      createUpdateManager: ({ diagnostics, channelConfig, appVersion }) => {
        assert.equal(channelConfig.updateChannel, "lab");
        assert.equal(appVersion, "0.1.0");
        assert.equal(typeof diagnostics.append, "function");
        return {
          async start() { calls.updater += 1; },
          dispose() { calls.updaterDispose += 1; },
        };
      },
      initializeOptionalCapabilities: async () => {
        calls.optional += 1;
        if (optionalError) throw optionalError;
      },
      exportDiagnostics: async options => {
        calls.export += 1;
        return options.destination;
      },
      chooseDiagnosticDestination: async () => "C:\\Users\\Test\\Desktop\\docpronto-diagnostico.zip",
      reportFatalError: error => { fatalErrors.push(error); },
      onLifecycleEvent: event => { lifecycleEvents.push(event); },
      preloadPath: "C:\\app\\desktop\\preload.cjs",
    },
  };
}

test("lock negado encerra sem criar servico, store ou janela", async () => {
  const harness = createHarness({ lock: false });
  const runtime = createDesktopRuntime(harness.dependencies);
  await runtime.start();
  assert.equal(harness.app.quitCalls, 1);
  assert.deepEqual(harness.calls, { service: 0, store: 0, window: 0, updater: 0, updaterDispose: 0, optional: 0, export: 0 });
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
  assert.equal(harness.window.showCalls, 1);
  harness.app.emit("second-instance");
  assert.equal(harness.window.restoreCalls, 1);
  assert.equal(harness.window.showCalls, 2);
  assert.equal(harness.window.focusCalls, 1);
  assert.ok(harness.lifecycleEvents.some(event => event.type === "second-instance"));
});

test("runtime publica marcos minimos para o smoke empacotado", async () => {
  const optionalError = Object.assign(new Error("Word ausente"), { code: "WORD_UNAVAILABLE" });
  const harness = createHarness({ optionalError });
  const runtime = createDesktopRuntime(harness.dependencies);

  await runtime.start();
  assert.ok(harness.lifecycleEvents.some(event => (
    event.type === "service-ready" && event.origin === harness.service.origin
  )));
  assert.ok(harness.lifecycleEvents.some(event => event.type === "ui-ready"));

  harness.window.emit("ready-to-show");
  await runtime.optionalReady;
  assert.ok(harness.lifecycleEvents.some(event => (
    event.type === "optional-capability-failed" && event.code === "WORD_UNAVAILABLE"
  )));

  await runtime.stop();
  assert.ok(harness.lifecycleEvents.some(event => event.type === "stopping"));
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

test("cleanup continua fechando store e servico se destruir janela falhar", async () => {
  const harness = createHarness({ destroyError: new Error("destroy falhou") });
  const runtime = createDesktopRuntime(harness.dependencies);
  await runtime.start();
  await runtime.stop();
  assert.equal(harness.window.destroyCalls, 1);
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

test("atualizador inicia somente depois de ready-to-show e e descartado no stop", async () => {
  const harness = createHarness();
  const runtime = createDesktopRuntime(harness.dependencies);
  await runtime.start();
  assert.equal(harness.calls.updater, 0);

  harness.window.emit("ready-to-show");
  await runtime.optionalReady;
  assert.equal(harness.calls.updater, 1);

  await runtime.stop();
  assert.equal(harness.calls.updaterDispose, 1);
});

test("falha ao iniciar servico registra codigo estavel e encerra", async () => {
  const harness = createHarness({ serviceError: Object.assign(new Error("EADDRINUSE"), { code: "EADDRINUSE" }) });
  const runtime = createDesktopRuntime(harness.dependencies);
  await assert.rejects(runtime.start(), /EADDRINUSE/);
  assert.ok(harness.diagnostics.some(event => event.code === "DESKTOP_SERVICE_START_FAILED"));
  assert.equal(harness.store.closeCalls, 1);
  assert.equal(harness.app.quitCalls, 1);
  assert.equal(harness.fatalErrors.length, 1);
});

test("falha ao criar store encerra e reporta sem iniciar servico", async () => {
  const harness = createHarness({ storeError: new Error("store indisponivel") });
  const runtime = createDesktopRuntime(harness.dependencies);
  await assert.rejects(runtime.start(), /store indisponivel/);
  assert.equal(harness.calls.service, 0);
  assert.equal(harness.app.quitCalls, 1);
  assert.equal(harness.fatalErrors[0].code, "DESKTOP_STORE_START_FAILED");
});

test("falha ao registrar IPC fecha store e servico e encerra", async () => {
  const harness = createHarness({ ipcError: new Error("IPC duplicado") });
  const runtime = createDesktopRuntime(harness.dependencies);
  await assert.rejects(runtime.start(), /IPC duplicado/);
  assert.equal(harness.store.closeCalls, 1);
  assert.equal(harness.service.closeCalls, 1);
  assert.ok(harness.diagnostics.some(event => event.code === "DESKTOP_IPC_START_FAILED"));
  assert.equal(harness.app.quitCalls, 1);
});

test("falha ao criar janela fecha store e servico e encerra", async () => {
  const harness = createHarness({ windowError: new Error("janela indisponivel") });
  const runtime = createDesktopRuntime(harness.dependencies);
  await assert.rejects(runtime.start(), /janela indisponivel/);
  assert.equal(harness.store.closeCalls, 1);
  assert.equal(harness.service.closeCalls, 1);
  assert.ok(harness.diagnostics.some(event => event.code === "DESKTOP_WINDOW_START_FAILED"));
  assert.equal(harness.app.quitCalls, 1);
});

test("loadURL rejeitado registra falha, limpa recursos e encerra", async () => {
  const error = Object.assign(new Error("net::ERR_CONNECTION_REFUSED"), { code: "DESKTOP_WINDOW_LOAD_FAILED" });
  const harness = createHarness({ loadError: error });
  const runtime = createDesktopRuntime(harness.dependencies);
  await assert.rejects(runtime.start(), /ERR_CONNECTION_REFUSED/);
  assert.equal(harness.store.closeCalls, 1);
  assert.equal(harness.service.closeCalls, 1);
  assert.ok(harness.diagnostics.some(event => event.code === "DESKTOP_WINDOW_LOAD_FAILED"));
  assert.equal(harness.app.quitCalls, 1);
});

test("IPC aceita somente o frame principal da origem confiavel", async () => {
  const harness = createHarness();
  const runtime = createDesktopRuntime(harness.dependencies);
  await runtime.start();
  const handler = harness.ipcHandlers.get("docpronto:get-app-info");
  await assert.rejects(
    handler({ senderFrame: { url: "https://evil.example/" }, sender: { mainFrame: {} } }),
    error => error.code === "UNTRUSTED_IPC_SENDER",
  );
  const subframe = { url: `${harness.service.origin}/frame` };
  await assert.rejects(
    handler({ senderFrame: subframe, sender: { mainFrame: { url: `${harness.service.origin}/` } } }),
    error => error.code === "UNTRUSTED_IPC_SENDER",
  );
  const info = await handler(harness.trustedEvent());
  assert.equal(info.channel, "lab");
});

test("IPC valida argumentos e exportacao nunca aceita destino do renderer", async () => {
  const harness = createHarness();
  const runtime = createDesktopRuntime(harness.dependencies);
  await runtime.start();
  const event = harness.trustedEvent();
  await assert.rejects(
    harness.ipcHandlers.get("docpronto:diagnostics:list")(event, { unknown: true }),
    error => error.code === "INVALID_IPC_ARGUMENTS",
  );
  await assert.rejects(
    harness.ipcHandlers.get("docpronto:diagnostics:export")(event, { destination: "C:\\Windows\\win.ini" }),
    error => error.code === "INVALID_IPC_ARGUMENTS",
  );
  assert.equal(harness.calls.export, 0);
  const destination = await harness.ipcHandlers.get("docpronto:diagnostics:export")(event);
  assert.equal(destination, "C:\\Users\\Test\\Desktop\\docpronto-diagnostico.zip");
  assert.equal(harness.calls.export, 1);
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
  await harness.ipcHandlers.get("docpronto:diagnostics:record")(harness.trustedEvent(), { code: "TEST_EVENT" });
  assert.ok(harness.diagnostics.some(event => event.code === "TEST_EVENT"));
});
