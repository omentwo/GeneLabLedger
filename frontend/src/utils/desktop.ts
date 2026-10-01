export function desktopBridge() {
  return window.geneLedgerDesktop;
}

export function apiBaseUrl(): string {
  return desktopBridge()?.backendUrl ?? "";
}
