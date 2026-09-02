const { contextBridge, ipcRenderer } = require("electron");

function argumentValue(name) {
  const prefix = `--${name}=`;
  const argument = process.argv.find((value) => value.startsWith(prefix));
  return argument ? argument.slice(prefix.length) : "";
}

contextBridge.exposeInMainWorld("geneLedgerDesktop", {
  isElectron: true,
  windowKind: argumentValue("gene-ledger-window-kind") || "main",
  backendUrl: argumentValue("gene-ledger-backend-url"),
  dataDirectory: argumentValue("gene-ledger-data-directory"),
  saveWorkbook: (filename, data) =>
    ipcRenderer.invoke("gene-ledger:save-workbook", { filename, data }),
  printPreview: (url) => ipcRenderer.invoke("gene-ledger:print-preview", url),
  chooseDirectory: (initialDirectory) =>
    ipcRenderer.invoke("gene-ledger:choose-directory", initialDirectory),
  changeDataDirectory: () => ipcRenderer.invoke("gene-ledger:change-data-directory"),
  getAlwaysOnTop: () => ipcRenderer.invoke("gene-ledger:get-always-on-top"),
  setAlwaysOnTop: (value) => ipcRenderer.invoke("gene-ledger:set-always-on-top", Boolean(value)),
  getWindowState: () => ipcRenderer.invoke("gene-ledger:get-window-state"),
  openQuickEntry: (context) => ipcRenderer.invoke("gene-ledger:open-quick-entry", context),
  quickEntryReady: () => ipcRenderer.invoke("gene-ledger:quick-entry-ready"),
  focusMainWindow: () => ipcRenderer.invoke("gene-ledger:focus-main-window"),
  notifyQuickEntryChanged: (payload) =>
    ipcRenderer.invoke("gene-ledger:quick-entry-changed", payload),
  notifyQuickEntryFieldsChanged: (payload) =>
    ipcRenderer.invoke("gene-ledger:quick-entry-fields-changed", payload),
  onQuickEntryOpenRequested: (listener) => {
    const handler = (_event, context) => listener(context);
    ipcRenderer.on("gene-ledger:quick-entry-open-requested", handler);
    return () => ipcRenderer.removeListener("gene-ledger:quick-entry-open-requested", handler);
  },
  onQuickEntryChanged: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on("gene-ledger:quick-entry-changed", handler);
    return () => ipcRenderer.removeListener("gene-ledger:quick-entry-changed", handler);
  },
  onQuickEntryFieldsChanged: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on("gene-ledger:quick-entry-fields-changed", handler);
    return () => ipcRenderer.removeListener("gene-ledger:quick-entry-fields-changed", handler);
  },
  minimizeWindow: () => ipcRenderer.invoke("gene-ledger:minimize-window"),
  toggleWindowMaximize: () => ipcRenderer.invoke("gene-ledger:toggle-window-maximize"),
  closeWindow: () => ipcRenderer.invoke("gene-ledger:close-window"),
  onWindowStateChanged: (listener) => {
    const handler = (_event, state) => listener(state);
    ipcRenderer.on("gene-ledger:window-state-changed", handler);
    return () => ipcRenderer.removeListener("gene-ledger:window-state-changed", handler);
  },
  restart: () => ipcRenderer.invoke("gene-ledger:restart"),
});
