<script setup lang="ts">
import "@univerjs/preset-sheets-core/lib/index.css";

import type { FUniver } from "@univerjs/core/facade";
import type { FRange, FWorkbook, FWorksheet } from "@univerjs/sheets/facade";
import { createUniver, LocaleType, mergeLocales } from "@univerjs/presets";
import { UniverSheetsCorePreset } from "@univerjs/preset-sheets-core";
import UniverPresetSheetsCoreZhCN from "@univerjs/preset-sheets-core/locales/zh-CN";
import type {
  ICellData,
  IDisposable,
  IRange,
  IStyleData,
  IWorkbookData,
  Nullable,
  Univer,
} from "@univerjs/core";
import { BooleanNumber, HorizontalAlign, VerticalAlign, WrapStrategy } from "@univerjs/core";
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";

import type { FieldDefinition, ProjectRecord } from "@/types/api";

export type UniverLedgerRow = ProjectRecord & { _draft?: true };

const props = withDefaults(
  defineProps<{
    projectId: string;
    projectName: string;
    fields: FieldDefinition[];
    rows: UniverLedgerRow[];
    loading?: boolean;
  }>(),
  { loading: false },
);

const emit = defineEmits<{
  (event: "selection-change", records: ProjectRecord[]): void;
  (event: "cell-change", payload: {
    record: UniverLedgerRow;
    field: FieldDefinition;
    value: string;
  }): void;
  (event: "background-change", payload: { recordIds: string[]; color: string | null }): void;
  (event: "column-resize", payload: { fieldId: string; width: number }): void;
}>();

const container = ref<HTMLElement | null>(null);
const ready = ref(false);

let univerInstance: Univer | null = null;
let univerAPIInstance: FUniver | null = null;
let workbook: FWorkbook | null = null;
let worksheet: FWorksheet | null = null;
let disposables: IDisposable[] = [];
let syncing = false;
let structureKey = "";
let cachedSelections: IRange[] = [];
const cellValues = new Map<string, string>();

const HEADER_STYLE = "ledger-header";
const BODY_STYLE = "ledger-body";

function textValue(value: Nullable<string | number | boolean>): string {
  return value == null ? "" : String(value);
}

function valueFor(row: UniverLedgerRow, field: FieldDefinition): string {
  if (field.system_key === "pathology_number") return row.pathology_number;
  if (field.system_key === "experiment_date") return row.experiment_date ?? "";
  if (field.system_key === "experiment_number") return row.experiment_number ?? "";
  if (field.system_key === "status") return row.status;
  return row.values[field.id] ?? "";
}

function cellKey(row: UniverLedgerRow, field: FieldDefinition): string {
  return `${row.id}:${field.id}`;
}

function rowStyleId(row: UniverLedgerRow): string {
  const color = row.highlight_color?.toLowerCase().replace(/[^a-z0-9]/g, "") ?? "";
  return color ? `ledger-row-${color}` : BODY_STYLE;
}

function buildSnapshot(): Partial<IWorkbookData> {
  const sheetId = `ledger-sheet-${props.projectId || "empty"}`;
  const rowCount = Math.max(props.rows.length + 24, 100);
  const columnCount = Math.max(props.fields.length, 1);
  const cellData: Record<number, Record<number, ICellData>> = {};
  const rowData: Record<number, { h: number }> = { 0: { h: 34 } };
  const columnData: Record<number, { w: number }> = {};

  props.fields.forEach((field, columnIndex) => {
    columnData[columnIndex] = { w: Math.max(72, Math.round(field.width || 120)) };
    if (!cellData[0]) cellData[0] = {};
    cellData[0][columnIndex] = { v: field.label, s: HEADER_STYLE };
  });

  props.rows.forEach((row, rowIndex) => {
    const sheetRow = rowIndex + 1;
    rowData[sheetRow] = { h: 34 };
    const rowCells: Record<number, ICellData> = {};
    cellData[sheetRow] = rowCells;
    props.fields.forEach((field, columnIndex) => {
      const value = valueFor(row, field);
      rowCells[columnIndex] = { v: value, s: rowStyleId(row) };
      cellValues.set(cellKey(row, field), value);
    });
  });

  return {
    id: `ledger-${props.projectId || "empty"}`,
    name: props.projectName || "台账",
    appVersion: "0.25.1",
    locale: LocaleType.ZH_CN,
    styles: {
      [HEADER_STYLE]: {
        bl: BooleanNumber.TRUE,
        bg: { rgb: "#f2f4f7" },
        ht: HorizontalAlign.CENTER,
        vt: VerticalAlign.MIDDLE,
        bd: {
          b: { s: 1, cl: { rgb: "#d0d5dd" } },
          l: { s: 1, cl: { rgb: "#d0d5dd" } },
          r: { s: 1, cl: { rgb: "#d0d5dd" } },
          t: { s: 1, cl: { rgb: "#d0d5dd" } },
        },
      } satisfies IStyleData,
      [BODY_STYLE]: {
        bg: { rgb: "#ffffff" },
        ht: HorizontalAlign.CENTER,
        vt: VerticalAlign.MIDDLE,
        tb: WrapStrategy.WRAP,
      } satisfies IStyleData,
      ...Object.fromEntries(
        props.rows
          .map((row) => row.highlight_color?.toLowerCase())
          .filter((color): color is string => Boolean(color))
          .map((color) => [
            rowStyleId({ highlight_color: color } as UniverLedgerRow),
            {
              bg: { rgb: color },
              ht: HorizontalAlign.CENTER,
              vt: VerticalAlign.MIDDLE,
              tb: WrapStrategy.WRAP,
            } satisfies IStyleData,
          ]),
      ),
    },
    sheetOrder: [sheetId],
    sheets: {
      [sheetId]: {
        id: sheetId,
        name: props.projectName || "台账",
        tabColor: "#409eff",
        hidden: BooleanNumber.FALSE,
        freeze: { xSplit: 0, ySplit: 1, startRow: 1, startColumn: 0 },
        rowCount,
        columnCount,
        zoomRatio: 1,
        scrollTop: 0,
        scrollLeft: 0,
        defaultColumnWidth: 120,
        defaultRowHeight: 34,
        mergeData: [],
        cellData,
        rowData,
        columnData,
        rowHeader: { width: 46 },
        columnHeader: { height: 24 },
        showGridlines: BooleanNumber.TRUE,
        rightToLeft: BooleanNumber.FALSE,
      },
    },
  };
}

function selectedRowIndexes(ranges: IRange[]): number[] {
  const indexes = new Set<number>();
  ranges.forEach((range) => {
    const start = Math.max(1, range.startRow);
    const end = Math.min(props.rows.length, range.endRow);
    for (let row = start; row <= end; row += 1) indexes.add(row - 1);
  });
  return [...indexes].sort((left, right) => left - right);
}

function emitSelection(ranges: IRange[]): void {
  const selected = selectedRowIndexes(ranges)
    .map((index) => props.rows[index])
    .filter((row): row is UniverLedgerRow => row !== undefined && !row._draft);
  emit("selection-change", selected);
}

function rangesForCommand(): IRange[] {
  if (cachedSelections.length) return cachedSelections;
  const active = workbook?.getActiveRange()?.getRange();
  return active ? [active] : [];
}

function handleCommand(command: { id: string; params?: unknown }): void {
  if (syncing) return;
  if (
    command.id === "sheet.command.set-background-color" ||
    command.id === "sheet.command.reset-background-color"
  ) {
    const params = command.params as { value?: unknown } | undefined;
    const activeRanges = rangesForCommand();
    const color =
      command.id === "sheet.command.reset-background-color"
        ? null
        : typeof params?.value === "string"
          ? params.value
          : null;
    const recordIds = selectedRowIndexes(activeRanges)
      .map((index) => props.rows[index])
      .filter((row): row is UniverLedgerRow => row !== undefined && !row._draft)
      .map((row) => row.id);
    if (recordIds.length) emit("background-change", { recordIds, color });
    return;
  }

  if (command.id === "sheet.command.delta-column-width") {
    const params = command.params as { anchorCol?: unknown } | undefined;
    const columnIndex = typeof params?.anchorCol === "number" ? params.anchorCol : -1;
    const field = props.fields[columnIndex];
    const width = columnIndex >= 0 ? worksheet?.getColumnWidth(columnIndex) ?? 0 : 0;
    if (field && width > 0) emit("column-resize", { fieldId: field.id, width });
    return;
  }

  if (command.id === "sheet.command.set-worksheet-col-width") {
    const params = command.params as { ranges?: IRange[]; value?: unknown } | undefined;
    const width = typeof params?.value === "number" ? params.value : 0;
    const columnIndex = params?.ranges?.[0]?.startColumn ?? -1;
    const field = props.fields[columnIndex];
    if (field && width > 0) emit("column-resize", { fieldId: field.id, width });
  }
}

function handleValueChanged(effectedRanges: FRange[]): void {
  const activeWorksheet = worksheet;
  if (!activeWorksheet) return;
  effectedRanges.forEach((effectedRange) => {
    const range = effectedRange.getRange();
    const startRow = Math.max(1, range.startRow);
    const endRow = Math.min(props.rows.length, range.endRow);
    const startColumn = Math.max(0, range.startColumn);
    const endColumn = Math.min(props.fields.length - 1, range.endColumn);
    for (let rowIndex = startRow; rowIndex <= endRow; rowIndex += 1) {
      const row = props.rows[rowIndex - 1];
      if (!row) continue;
      for (let columnIndex = startColumn; columnIndex <= endColumn; columnIndex += 1) {
        const field = props.fields[columnIndex];
        if (!field) continue;
        const cell = activeWorksheet.getRange(rowIndex, columnIndex);
        const value = textValue(cell.getValue());
        const key = cellKey(row, field);
        const previousValue = cellValues.get(key) ?? valueFor(row, field);
        if (value === previousValue) continue;
        if (row.locked) {
          syncing = true;
          cell.setValueForCell(previousValue || "");
          syncing = false;
          continue;
        }
        cellValues.set(key, value);
        emit("cell-change", { record: row, field, value });
      }
    }
  });
}

function syncRows(): void {
  if (!worksheet || !ready.value) return;
  syncing = true;
  try {
    props.rows.forEach((row, rowIndex) => {
      const sheetRow = rowIndex + 1;
      const rowRange = worksheet?.getRange(sheetRow, 0, 1, Math.max(props.fields.length, 1));
      if (rowRange) {
        const color = row.highlight_color || "#ffffff";
        if (rowRange.getBackground() !== color) rowRange.setBackground(color);
      }
      props.fields.forEach((field, columnIndex) => {
        const value = valueFor(row, field);
        const key = cellKey(row, field);
        const current = textValue(worksheet?.getRange(sheetRow, columnIndex).getValue());
        if (current !== value) worksheet?.getRange(sheetRow, columnIndex).setValueForCell(value || "");
        cellValues.set(key, value);
      });
    });
    props.fields.forEach((field, columnIndex) => {
      const width = Math.max(72, Math.round(field.width || 120));
      if (worksheet?.getColumnWidth(columnIndex) !== width) worksheet?.setColumnWidth(columnIndex, width);
    });
  } finally {
    syncing = false;
  }
}

function clearDisposables(): void {
  disposables.forEach((disposable) => disposable.dispose());
  disposables = [];
}

function destroyWorkbook(): void {
  clearDisposables();
  workbook?.dispose();
  workbook = null;
  worksheet = null;
  cachedSelections = [];
  cellValues.clear();
}

function createWorkbook(): void {
  if (!container.value || !univerAPIInstance) return;
  destroyWorkbook();
  const created = univerAPIInstance.createWorkbook(buildSnapshot());
  workbook = created;
  worksheet = workbook.getActiveSheet();
  worksheet.setFrozenRows(1);
  cachedSelections = [];
  disposables.push(
    workbook.onSelectionChange((ranges) => {
      cachedSelections = ranges;
      emitSelection(ranges);
    }),
  );
  disposables.push(
    workbook.onCommandExecuted((command) => {
      handleCommand(command as { id: string; params?: unknown });
    }),
  );
  disposables.push(
    univerAPIInstance.addEvent(univerAPIInstance.Event.SheetValueChanged, ({ effectedRanges }) => {
      if (syncing) return;
      handleValueChanged(effectedRanges);
    }),
  );
  structureKey = `${props.projectId}|${props.fields.map((field) => field.id).join(",")}|${props.rows
    .map((row) => row.id)
    .join(",")}`;
}

onMounted(() => {
  if (!container.value) return;
  const created = createUniver({
    locale: LocaleType.ZH_CN,
    locales: {
      [LocaleType.ZH_CN]: mergeLocales(UniverPresetSheetsCoreZhCN),
    },
    presets: [
      UniverSheetsCorePreset({
        container: container.value,
        header: true,
        toolbar: true,
        contextMenu: true,
        footer: {
          sheetBar: false,
          statisticBar: true,
          menus: false,
          zoomSlider: true,
        },
      }),
    ],
  });
  univerInstance = created.univer;
  univerAPIInstance = created.univerAPI;
  createWorkbook();
  ready.value = true;
  void nextTick(syncRows);
});

watch(
  () => `${props.projectId}|${props.fields.map((field) => field.id).join(",")}|${props.rows
    .map((row) => row.id)
    .join(",")}`,
  (nextKey) => {
    if (!ready.value || nextKey === structureKey) return;
    createWorkbook();
  },
);

watch(
  () => [
    ...props.fields.map((field) => `${field.id}:${field.width}`),
    ...props.rows.flatMap((row) => [
      row.id,
      row.highlight_color ?? "",
      ...props.fields.map((field) => valueFor(row, field)),
    ]),
  ],
  () => {
    if (ready.value) syncRows();
  },
  { deep: true },
);

onBeforeUnmount(() => {
  destroyWorkbook();
  univerAPIInstance?.dispose();
  univerInstance?.dispose();
  univerAPIInstance = null;
  univerInstance = null;
  ready.value = false;
});
</script>

<template>
  <div class="univer-ledger-grid" :class="{ 'is-loading': loading }">
    <div ref="container" class="univer-ledger-container" />
    <div v-if="loading" class="univer-ledger-loading">正在读取项目数据…</div>
  </div>
</template>

<style scoped>
.univer-ledger-grid {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 360px;
  overflow: hidden;
  background: #fff;
}

.univer-ledger-container {
  width: 100%;
  height: 100%;
}

.univer-ledger-loading {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: #667085;
  background: rgb(255 255 255 / 56%);
  pointer-events: none;
}
</style>
