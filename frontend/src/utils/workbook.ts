import { desktopBridge } from "@/utils/desktop";
import { apiRequestBlob } from "@/api/client";

export type WorkbookFormat = "xlsx";

export interface WorkbookSheet {
  name: string;
  headers: string[];
  rows: Array<Array<string | number | null | undefined>>;
  hiddenColumns?: number[];
}

function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 500);
}

export async function exportWorkbook(
  sheets: WorkbookSheet[],
  filenameBase: string,
): Promise<boolean> {
  const { blob, filename } = await apiRequestBlob("/exports/workbook", {
    method: "POST",
    body: JSON.stringify({
      filename: filenameBase,
      sheets: sheets.map((sheet) => ({
        name: sheet.name,
        headers: sheet.headers,
        rows: sheet.rows.map((row) =>
          row.map((value) => (value == null ? "" : String(value))),
        ),
        hidden_columns: sheet.hiddenColumns ?? [],
      })),
    }),
  });
  const bridge = desktopBridge();
  if (bridge) {
    const result = await bridge.saveWorkbook(
      filename ?? `${filenameBase}.xlsx`,
      await blob.arrayBuffer(),
    );
    return result.saved;
  }
  downloadBlob(filename ?? `${filenameBase}.xlsx`, blob);
  return true;
}
