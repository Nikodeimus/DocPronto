import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

import { createMainWindow } from "../../desktop/window.mjs";

class FakeBrowserWindow {
  static menu = "unset";
  static setMenu(value) { this.menu = value; }
  constructor(options) {
    this.options = options;
    this.destroyCalls = 0;
    this.loaded = [];
    this.webContents = {
      openHandler: null,
      handlers: new Map(),
      setWindowOpenHandler: handler => { this.webContents.openHandler = handler; },
      on: (name, handler) => { this.webContents.handlers.set(name, handler); },
    };
  }
  destroy() { this.destroyCalls += 1; }
  loadURL(url) {
    this.loaded.push(url);
    return Promise.resolve();
  }
}

function createWindow(overrides = {}) {
  const opened = [];
  const window = createMainWindow({
    BrowserWindow: FakeBrowserWindow,
    origin: "http://127.0.0.1:43123",
    preloadPath: "C:\\app\\desktop\\preload.cjs",
    channelConfig: { productName: "DOCPronto Laboratorio" },
    shell: { openExternal: async url => opened.push(url) },
    ...overrides,
  });
  return { window, opened };
}

test("janela usa isolamento forte, preload CommonJS, dimensoes fixas e nenhum menu", async () => {
  const { window } = createWindow();
  assert.equal(window.options.width, 1120);
  assert.equal(window.options.height, 760);
  assert.equal(window.options.minWidth, 900);
  assert.equal(window.options.minHeight, 640);
  assert.equal(window.options.backgroundColor, "#f5f3eb");
  assert.equal(window.options.title, "DOCPronto Laboratorio");
  assert.deepEqual(window.options.webPreferences, {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
    preload: "C:\\app\\desktop\\preload.cjs",
  });
  assert.equal(FakeBrowserWindow.menu, null);
  await window.docprontoLoadPromise;
  assert.deepEqual(window.loaded, ["http://127.0.0.1:43123/"]);
});

test("window.open bloqueia tudo e abre somente https no navegador do sistema", () => {
  const { window, opened } = createWindow();
  assert.deepEqual(window.webContents.openHandler({ url: "https://docpronto.example/ajuda" }), { action: "deny" });
  assert.deepEqual(window.webContents.openHandler({ url: "http://unsafe.example" }), { action: "deny" });
  assert.deepEqual(window.webContents.openHandler({ url: "file:///C:/secret.txt" }), { action: "deny" });
  assert.deepEqual(opened, ["https://docpronto.example/ajuda"]);
});

test("navegacao e redirect externos sao cancelados e apenas HTTPS abre no shell", () => {
  const { window, opened } = createWindow();
  const navigate = window.webContents.handlers.get("will-navigate");
  const redirect = window.webContents.handlers.get("will-redirect");
  const local = { prevented: false, preventDefault() { this.prevented = true; } };
  navigate(local, "http://127.0.0.1:43123/ferramenta");
  assert.equal(local.prevented, false);

  for (const [handler, target] of [
    [navigate, "https://example.com/ajuda"],
    [redirect, "https://example.com/login"],
    [navigate, "http://localhost:43123/"],
    [redirect, "file:///C:/Windows/win.ini"],
    [navigate, "javascript:alert(1)"],
  ]) {
    const event = { prevented: false, preventDefault() { this.prevented = true; } };
    handler(event, target);
    assert.equal(event.prevented, true, target);
  }
  assert.deepEqual(opened, ["https://example.com/ajuda", "https://example.com/login"]);
});

test("rejeicao de loadURL destroi a janela e produz erro estavel", async () => {
  class RejectingWindow extends FakeBrowserWindow {
    loadURL(url) {
      this.loaded.push(url);
      return Promise.reject(new Error("net::ERR_FAILED"));
    }
  }
  const window = createMainWindow({
    BrowserWindow: RejectingWindow,
    origin: "http://127.0.0.1:43123",
    preloadPath: "preload.cjs",
    channelConfig: { productName: "DOCPronto" },
    shell: { openExternal() {} },
  });
  await assert.rejects(
    window.docprontoLoadPromise,
    error => error.code === "DESKTOP_WINDOW_LOAD_FAILED" && /ERR_FAILED/.test(error.cause.message),
  );
  assert.equal(window.destroyCalls, 1);
});

test("preload CommonJS executa em sandbox restrito e expoe somente a API enumerada", async () => {
  const source = await readFile(new URL("../../desktop/preload.cjs", import.meta.url), "utf8");
  const invocations = [];
  let exposedName;
  let exposedApi;
  const electron = {
    contextBridge: {
      exposeInMainWorld(name, api) {
        exposedName = name;
        exposedApi = api;
      },
    },
    ipcRenderer: {
      invoke(...args) {
        invocations.push(args);
        return Promise.resolve(args);
      },
    },
  };
  const sandbox = {
    require(specifier) {
      assert.equal(specifier, "electron");
      return electron;
    },
  };

  vm.runInNewContext(source, sandbox, { filename: "desktop/preload.cjs" });

  assert.equal(exposedName, "docprontoDesktop");
  assert.deepEqual(Object.keys(exposedApi).sort(), ["diagnostics", "getAppInfo"]);
  assert.deepEqual(Object.keys(exposedApi.diagnostics).sort(), ["clear", "export", "list", "record"]);
  assert.equal(Object.isFrozen(exposedApi), true);
  assert.equal(Object.isFrozen(exposedApi.diagnostics), true);
  assert.equal("exec" in exposedApi, false);
  assert.equal("readFile" in exposedApi, false);
  await exposedApi.getAppInfo();
  await exposedApi.diagnostics.list({ level: "error" });
  await exposedApi.diagnostics.clear();
  await exposedApi.diagnostics.export();
  await exposedApi.diagnostics.record({ code: "TEST" });
  assert.deepEqual(invocations, [
    ["docpronto:get-app-info"],
    ["docpronto:diagnostics:list", { level: "error" }],
    ["docpronto:diagnostics:clear"],
    ["docpronto:diagnostics:export"],
    ["docpronto:diagnostics:record", { code: "TEST" }],
  ]);
});
