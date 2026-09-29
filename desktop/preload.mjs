import { contextBridge, ipcRenderer } from "electron";

const api = Object.freeze({
  getAppInfo: () => ipcRenderer.invoke("docpronto:get-app-info"),
  diagnostics: Object.freeze({
    list: filters => ipcRenderer.invoke("docpronto:diagnostics:list", filters),
    clear: () => ipcRenderer.invoke("docpronto:diagnostics:clear"),
    export: options => ipcRenderer.invoke("docpronto:diagnostics:export", options),
    record: event => ipcRenderer.invoke("docpronto:diagnostics:record", event),
  }),
});

contextBridge.exposeInMainWorld("docprontoDesktop", api);
