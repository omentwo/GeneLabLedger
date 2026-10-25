export interface GeneLedgerDesktopBridge {
  isElectron: true;
  windowKind: "main" | "quick-entry" | "ledger-tools";
  backendUrl: string;
  dataDirectory: string;
  clipboardFollowAvailable: boolean;
  startClipboardFollow: (context: ClipboardFollowContext) => Promise<{ sequence: number }>;
  stopClipboardFollow: (sessionId: string) => Promise<void>;
  acceptCurrentClipboard: (sessionId: string) => Promise<void>;
  writeInternalClipboard: (text: string) => Promise<void>;
  onClipboardFollowEvent: (listener: (event: ClipboardFollowEvent) => void) => () => void;
  saveWorkbook: (
    filename: string,
    data: ArrayBuffer,
  ) => Promise<{ saved: boolean; path: string }>;
  chooseDirectory: (
    initialDirectory: string,
  ) => Promise<{ selected: boolean; directory: string }>;
  chooseBackupFile: (
    initialDirectory: string,
  ) => Promise<{ selected: boolean; path: string }>;
  changeDataDirectory: () => Promise<{ changed: boolean; directory: string }>;
  getAlwaysOnTop: () => Promise<boolean>;
  setAlwaysOnTop: (value: boolean) => Promise<boolean>;
  getWindowState: () => Promise<{ isMaximized: boolean; alwaysOnTop: boolean }>;
  openQuickEntry: (context: QuickEntryOpenContext) => Promise<void>;
  openLedgerTools: (context: LedgerToolsOpenContext) => Promise<void>;
  ledgerToolsReady: () => Promise<void>;
  notifyLedgerToolsChanged: (payload: LedgerToolsChangedPayload) => Promise<void>;
  selectProjectFromLedgerTools: (projectId: string) => Promise<void>;
  getPendingToolChanges: () => Promise<LedgerToolsProjectChange[]>;
  acknowledgeToolChanges: (changes: LedgerToolsProjectChange[]) => Promise<void>;
  locateLedgerRecord: (payload: LedgerRecordLocate) => Promise<void>;
  quickEntryReady: () => Promise<void>;
  focusMainWindow: () => Promise<boolean>;
  notifyQuickEntryChanged: (payload: QuickEntryChangedPayload) => Promise<void>;
  getPendingQuickEntryChanges: () => Promise<QuickEntryProjectChange[]>;
  acknowledgeQuickEntryChanges: (changes: QuickEntryProjectChange[]) => Promise<void>;
  notifyQuickEntryFieldsChanged: (payload: QuickEntryFieldsChangedPayload) => Promise<void>;
  onQuickEntryOpenRequested: (
    listener: (context: QuickEntryOpenContext) => void,
  ) => () => void;
  onLedgerToolsOpenRequested: (
    listener: (context: LedgerToolsOpenContext) => void,
  ) => () => void;
  onLedgerToolsChanged: (
    listener: (payload: LedgerToolsChangedPayload) => void,
  ) => () => void;
  onLedgerToolsProjectSelected: (
    listener: (payload: { projectId: string }) => void,
  ) => () => void;
  onLedgerToolsLocateRecord: (
    listener: (payload: LedgerRecordLocate) => void,
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
  closeGuardReady: () => Promise<void>;
  onCloseRequested: (listener: (request: WindowCloseRequest) => void) => () => void;
  respondToCloseRequest: (response: WindowCloseState & { requestId: string; saved: boolean }) => Promise<void>;
  onWindowStateChanged: (
    listener: (state: { isMaximized: boolean; alwaysOnTop: boolean }) => void,
  ) => () => void;
  restart: () => Promise<void>;
}

export interface WindowCloseState {
  dirty: boolean;
  busy: boolean;
}

export interface WindowCloseRequest {
  requestId: string;
  action: "inspect" | "save" | "release";
}

export interface QuickEntryOpenContext {
  projectId: string;
  selectedFieldIds: string[];
}

export interface ClipboardFollowContext {
  sessionId: string;
  projectId: string;
  recordId: string;
}

export type ClipboardFollowEvent = ClipboardFollowContext & (
  { type: "clipboard"; sequence: number; eventId: number; text: string; manual: boolean }
  | { type: "stopped"; reason: string }
);

export interface QuickEntryChangedPayload {
  projectId: string;
  recordId: string;
  action: "create" | "update";
  revision?: number;
}

export interface QuickEntryProjectChange {
  projectId: string;
  revision: number;
}

export interface QuickEntryFieldsChangedPayload {
  projectId: string;
}

export type LedgerToolsTab = "fields" | "reorder" | "find-replace";

export interface LedgerToolsOpenContext {
  tool: LedgerToolsTab;
  mode?: "find" | "replace";
  projectId: string;
}

export interface LedgerToolsChangedPayload {
  projectId: string;
  action: "fields" | "reorder" | "replace";
  revision?: number;
}

export interface LedgerToolsProjectChange {
  projectId: string;
  revision: number;
  action?: LedgerToolsChangedPayload["action"];
}

export interface LedgerRecordLocate {
  projectId: string;
  recordId: string;
  fieldId: string;
}

declare global {
  interface Window {
    geneLedgerDesktop?: GeneLedgerDesktopBridge;
  }
}

export {};
