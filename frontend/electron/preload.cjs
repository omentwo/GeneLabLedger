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
  clipboardFollowAvailable: process.platform === "win32",
  startClipboardFollow: (context) => ipcRenderer.invoke("gene-ledger:clipboard-follow-start", context),
  stopClipboardFollow: (sessionId) => ipcRenderer.invoke("gene-ledger:clipboard-follow-stop", sessionId),
  writeInternalClipboard: (text) => ipcRenderer.invoke("gene-ledger:clipboard-write-internal", text),
  onClipboardFollowEvent: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on("gene-ledger:clipboard-follow-event", handler);
    return () => ipcRenderer.removeListener("gene-ledger:clipboard-follow-event", handler);
  },
  saveWorkbook: (filename, data) =>
    ipcRenderer.invoke("gene-ledger:save-workbook", { filename, data }),
  chooseDirectory: (initialDirectory) =>
    ipcRenderer.invoke("gene-ledger:choose-directory", initialDirectory),
  chooseBackupFile: (initialDirectory) =>
    ipcRenderer.invoke("gene-ledger:choose-backup-file", initialDirectory),
  changeDataDirectory: () => ipcRenderer.invoke("gene-ledger:change-data-directory"),
  getAlwaysOnTop: () => ipcRenderer.invoke("gene-ledger:get-always-on-top"),
  setAlwaysOnTop: (value) => ipcRenderer.invoke("gene-ledger:set-always-on-top", Boolean(value)),
  getWindowState: () => ipcRenderer.invoke("gene-ledger:get-window-state"),
  openQuickEntry: (context) => ipcRenderer.invoke("gene-ledger:open-quick-entry", context),
  quickEntryReady: () => ipcRenderer.invoke("gene-ledger:quick-entry-ready"),
  focusMainWindow: () => ipcRenderer.invoke("gene-ledger:focus-main-window"),
  notifyQuickEntryChanged: (payload) =>
    ipcRenderer.invoke("gene-ledger:quick-entry-changed", payload),
  getPendingQuickEntryChanges: () =>
    ipcRenderer.invoke("gene-ledger:get-pending-quick-entry-changes"),
  acknowledgeQuickEntryChanges: (changes) =>
    ipcRenderer.invoke("gene-ledger:acknowledge-quick-entry-changes", changes),
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
