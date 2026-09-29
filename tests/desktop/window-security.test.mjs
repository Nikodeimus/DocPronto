import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createMainWindow } from "../../desktop/window.mjs";

class FakeBrowserWindow {
  static menu = "unset";
  static setMenu(value) { this.menu = value; }
  constructor(options) {
    this.options = options;
    this.loaded = [];
    this.webContents = {
      openHandler: null,
      navigationHandler: null,
      setWindowOpenHandler: handler => { this.webContents.openHandler = handler; },
      on: (name, handler) => {
        if (name === "will-navigate") this.webContents.navigationHandler = handler;
      },
    };
  }
  loadURL(url) { this.loaded.push(url); }
}

test("janela usa isolamento forte, dimensoes fixas e nenhum menu", () => {
  const window = createMainWindow({
    BrowserWindow: FakeBrowserWindow,
    origin: "http://127.0.0.1:43123",
    preloadPath: "C:\\app\\desktop\\preload.mjs",
    channelConfig: { productName: "DOCPronto Laboratorio" },
    shell: { openExternal() {} },
  });
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
    preload: "C:\\app\\desktop\\preload.mjs",
  });
  assert.equal(FakeBrowserWindow.menu, null);
  assert.deepEqual(window.loaded, ["http://127.0.0.1:43123/"]);
});

test("window.open bloqueia tudo e abre somente https no navegador do sistema", () => {
  const opened = [];
  const window = createMainWindow({
    BrowserWindow: FakeBrowserWindow,
    origin: "http://127.0.0.1:43123",
    preloadPath: "preload.mjs",
    channelConfig: { productName: "DOCPronto" },
    shell: { openExternal: async url => opened.push(url) },
  });
  assert.deepEqual(window.webContents.openHandler({ url: "https://docpronto.example/ajuda" }), { action: "deny" });
  assert.deepEqual(window.webContents.openHandler({ url: "http://unsafe.example" }), { action: "deny" });
  assert.deepEqual(window.webContents.openHandler({ url: "file:///C:/secret.txt" }), { action: "deny" });
  assert.deepEqual(opened, ["https://docpronto.example/ajuda"]);
});

test("navegacao permite somente a origem local exata", () => {
  const window = createMainWindow({
    BrowserWindow: FakeBrowserWindow,
    origin: "http://127.0.0.1:43123",
    preloadPath: "preload.mjs",
    channelConfig: { productName: "DOCPronto" },
    shell: { openExternal() {} },
  });
  const local = { prevented: false, preventDefault() { this.prevented = true; } };
  window.webContents.navigationHandler(local, "http://127.0.0.1:43123/ferramenta");
  assert.equal(local.prevented, false);
  for (const target of ["https://example.com", "http://localhost:43123/", "file:///C:/Windows/win.ini"]) {
    const event = { prevented: false, preventDefault() { this.prevented = true; } };
    window.webContents.navigationHandler(event, target);
    assert.equal(event.prevented, true, target);
  }
});

test("preload enumera somente API estreita sem ponte generica", async () => {
  const source = await readFile(new URL("../../desktop/preload.mjs", import.meta.url), "utf8");
  for (const allowed of ["getAppInfo", "diagnostics", "list", "clear", "export", "record"]) {
    assert.match(source, new RegExp(`\\b${allowed}\\b`));
  }
  for (const forbidden of ["exec", "spawn", "readFile", "writeFile", "sendSync", "send\\("]) {
    assert.doesNotMatch(source, new RegExp(forbidden));
  }
  assert.match(source, /contextBridge\.exposeInMainWorld\(["']docprontoDesktop["']/);
});
