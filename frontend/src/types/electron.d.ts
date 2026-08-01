export interface GeneLedgerDesktopBridge {
  isElectron: true;
  backendUrl: string;
  dataDirectory: string;
  saveWorkbook: (
    filename: string,
    data: ArrayBuffer,
  ) => Promise<{ saved: boolean; path: string }>;
  chooseDirectory: (
    initialDirectory: string,
  ) => Promise<{ selected: boolean; directory: string }>;
  changeDataDirectory: () => Promise<{ changed: boolean; directory: string }>;
  restart: () => Promise<void>;
}

declare global {
  interface Window {
    geneLedgerDesktop?: GeneLedgerDesktopBridge;
  }
}

export {};
