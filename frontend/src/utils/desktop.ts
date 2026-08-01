export function desktopBridge() {
  return window.geneLedgerDesktop;
}

export function apiBaseUrl(): string {
  return desktopBridge()?.backendUrl ?? "";
}

export async function chooseNativeDirectory(
  initialDirectory: string,
): Promise<{ selected: boolean; directory: string }> {
  const bridge = desktopBridge();
  if (!bridge) {
    throw new Error("目录选择仅在 Electron 桌面版中可用");
  }
  return bridge.chooseDirectory(initialDirectory);
}
