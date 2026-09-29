"use strict";

// Electron sandboxed preloads use its restricted CommonJS loader.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { contextBridge, ipcRenderer } = require("electron");

const api = Object.freeze({
  getAppInfo: () => ipcRenderer.invoke("docpronto:get-app-info"),
  signalReady: () => ipcRenderer.invoke("docpronto:renderer-ready"),
  diagnostics: Object.freeze({
    list: filters => ipcRenderer.invoke("docpronto:diagnostics:list", filters),
    clear: () => ipcRenderer.invoke("docpronto:diagnostics:clear"),
    export: () => ipcRenderer.invoke("docpronto:diagnostics:export"),
    record: event => ipcRenderer.invoke("docpronto:diagnostics:record", event),
  }),
});

contextBridge.exposeInMainWorld("docprontoDesktop", api);
