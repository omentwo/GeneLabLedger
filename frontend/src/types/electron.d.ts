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
  getAlwaysOnTop: () => Promise<boolean>;
  setAlwaysOnTop: (value: boolean) => Promise<boolean>;
  getWindowState: () => Promise<{ isMaximized: boolean; alwaysOnTop: boolean }>;
  minimizeWindow: () => Promise<void>;
  toggleWindowMaximize: () => Promise<boolean>;
  closeWindow: () => Promise<void>;
  onWindowStateChanged: (
    listener: (state: { isMaximized: boolean; alwaysOnTop: boolean }) => void,
  ) => () => void;
  restart: () => Promise<void>;
}

declare global {
  interface Window {
    geneLedgerDesktop?: GeneLedgerDesktopBridge;
  }
}

export {};
