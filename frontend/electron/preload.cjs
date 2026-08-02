const { contextBridge, ipcRenderer } = require("electron");

function argumentValue(name) {
  const prefix = `--${name}=`;
  const argument = process.argv.find((value) => value.startsWith(prefix));
  return argument ? argument.slice(prefix.length) : "";
}

contextBridge.exposeInMainWorld("geneLedgerDesktop", {
  isElectron: true,
  backendUrl: argumentValue("gene-ledger-backend-url"),
  dataDirectory: argumentValue("gene-ledger-data-directory"),
  saveWorkbook: (filename, data) =>
    ipcRenderer.invoke("gene-ledger:save-workbook", { filename, data }),
  chooseDirectory: (initialDirectory) =>
    ipcRenderer.invoke("gene-ledger:choose-directory", initialDirectory),
  changeDataDirectory: () => ipcRenderer.invoke("gene-ledger:change-data-directory"),
  getAlwaysOnTop: () => ipcRenderer.invoke("gene-ledger:get-always-on-top"),
  setAlwaysOnTop: (value) => ipcRenderer.invoke("gene-ledger:set-always-on-top", Boolean(value)),
  restart: () => ipcRenderer.invoke("gene-ledger:restart"),
});
