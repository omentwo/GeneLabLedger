export interface GeneLedgerDesktopBridge {
  isElectron: true;
  windowKind: "main" | "quick-entry";
  backendUrl: string;
  dataDirectory: string;
  saveWorkbook: (
    filename: string,
    data: ArrayBuffer,
  ) => Promise<{ saved: boolean; path: string }>;
  printPreview: (url: string) => Promise<{ success: boolean; reason: string }>;
  chooseDirectory: (
    initialDirectory: string,
  ) => Promise<{ selected: boolean; directory: string }>;
  changeDataDirectory: () => Promise<{ changed: boolean; directory: string }>;
  getAlwaysOnTop: () => Promise<boolean>;
  setAlwaysOnTop: (value: boolean) => Promise<boolean>;
  getWindowState: () => Promise<{ isMaximized: boolean; alwaysOnTop: boolean }>;
  openQuickEntry: (context: QuickEntryOpenContext) => Promise<void>;
  quickEntryReady: () => Promise<void>;
  focusMainWindow: () => Promise<boolean>;
  notifyQuickEntryChanged: (payload: QuickEntryChangedPayload) => Promise<void>;
  notifyQuickEntryFieldsChanged: (payload: QuickEntryFieldsChangedPayload) => Promise<void>;
  onQuickEntryOpenRequested: (
    listener: (context: QuickEntryOpenContext) => void,
  ) => () => void;
  onQuickEntryChanged: (
    listener: (payload: QuickEntryChangedPayload) => void,
  ) => () => void;
  onQuickEntryFieldsChanged: (
    listener: (payload: QuickEntryFieldsChangedPayload) => void,
  ) => () => void;
  minimizeWindow: () => Promise<void>;
  toggleWindowMaximize: () => Promise<boolean>;
  closeWindow: () => Promise<void>;
  onWindowStateChanged: (
    listener: (state: { isMaximized: boolean; alwaysOnTop: boolean }) => void,
  ) => () => void;
  restart: () => Promise<void>;
}

export interface QuickEntryOpenContext {
  projectId: string;
  selectedFieldIds: string[];
  pinnedFieldIds: string[];
}

export interface QuickEntryChangedPayload {
  projectId: string;
  recordId: string;
  action: "create" | "update";
}

export interface QuickEntryFieldsChangedPayload {
  projectId: string;
}

declare global {
  interface Window {
    geneLedgerDesktop?: GeneLedgerDesktopBridge;
  }
}

export {};
