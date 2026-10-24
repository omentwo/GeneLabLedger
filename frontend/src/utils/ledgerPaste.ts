import type { FieldDefinition, RecordBatchNewRecord } from "@/types/api";

import { normalizeDateInput } from "@/utils/datetime";
import { getRecordFieldValue } from "@/utils/recordFieldValue";
import type { GridCellPosition } from "@/utils/gridSelectionModel";
import type { LedgerRow } from "@/utils/ledgerTableView";

/** 粘贴/填充的目标单元格条目，与剪贴板矩阵及填充序列同构。 */
export type GridPasteEntry = { rowOffset: number; columnOffset: number; value: string };

/** 把 TSV 文本解析为粘贴条目；末尾的换行不产生空行。 */
export function parsePasteEntries(text: string): GridPasteEntry[] {
  const lines = text.replace(/\r/g, "").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines
    .map((line) => line.split("\t"))
    .flatMap((rowValues, rowOffset) =>
      rowValues.map((value, columnOffset) => ({ rowOffset, columnOffset, value })),
    );
}

/** 目标范围超出已加载行数时需要补齐的草稿行数。 */
export function countMissingPasteRows(
  entries: GridPasteEntry[],
  startRowIndex: number,
  rowCount: number,
): number {
  const maxRowOffset = entries.reduce((max, entry) => Math.max(max, entry.rowOffset), 0);
  return Math.max(0, startRowIndex + maxRowOffset + 1 - rowCount);
}

export interface ResolvedPasteTarget {
  position: GridCellPosition;
  record: LedgerRow;
  field: FieldDefinition;
  /** 将写入的值：exactCells 原样保留，文本粘贴去首尾空白。 */
  value: string;
  /** 写入前的现值，作为批量保存的乐观并发依据。 */
  expectedValue: string;
}

export interface ResolvedPasteTargets {
  targets: ResolvedPasteTarget[];
  /** 全部可解析（含被锁定跳过）的目标位置，用于操作后的选区重设。 */
  changedPositions: GridCellPosition[];
  skippedLocked: number;
}

/**
 * 把粘贴条目解析为具体写入目标。纯函数：不触状态、不写入；
 * 行/列越界或字段缺失的条目被忽略，锁定单元格计入
 * skippedLocked 且不产生写入目标。
 */
export function resolvePasteTargets(
  entries: GridPasteEntry[],
  startRowIndex: number,
  startColumnIndex: number,
  rows: LedgerRow[],
  fields: FieldDefinition[],
  options: { exact: boolean },
): ResolvedPasteTargets {
  const seenPositions = new Set<string>();
  const changedPositions: GridCellPosition[] = [];
  const targets: ResolvedPasteTarget[] = [];
  let skippedLocked = 0;
  entries.forEach((entry) => {
    const targetRowIndex = startRowIndex + entry.rowOffset;
    const targetColumnIndex = startColumnIndex + entry.columnOffset;
    const record = rows[targetRowIndex];
    if (!record) return;
    const field = fields[targetColumnIndex];
    if (!field || targetColumnIndex < 0 || targetRowIndex < 0) return;
    const position = { rowIndex: targetRowIndex, columnIndex: targetColumnIndex };
    const positionKey = `${targetRowIndex}:${targetColumnIndex}`;
    if (!seenPositions.has(positionKey)) {
      seenPositions.add(positionKey);
      changedPositions.push(position);
    }
    if (record.locked) {
      skippedLocked += 1;
      return;
    }
    targets.push({
      position,
      record,
      field,
      value: options.exact ? entry.value : entry.value.trim(),
      expectedValue: getRecordFieldValue(record, field),
    });
  });
  return { targets, changedPositions, skippedLocked };
}

/** 把已变更的草稿行映射为批量新建记录载荷（核心字段单独建列，不入 values）。 */
export function buildBatchNewRecords(
  drafts: LedgerRow[],
  projectFields: FieldDefinition[],
): RecordBatchNewRecord[] {
  return drafts.map((record) => ({
    client_id: record.id,
    pathology_number: record.pathology_number.trim(),
    block_number: record.block_number?.trim() || null,
    status: record.status,
    experiment_date: record.experiment_date ? normalizeDateInput(record.experiment_date) : null,
    experiment_number: record.experiment_number?.trim() || null,
    values: Object.fromEntries(
      projectFields
        .filter((field) => !field.is_core)
        .map((field) => [field.id, (record.values[field.id] ?? "").trim()]),
    ),
    ...(record._insertAnchorId && record._insertPlacement === "before"
      ? { insert_before_record_id: record._insertAnchorId }
      : {}),
    ...(record._insertAnchorId && record._insertPlacement === "after"
      ? { insert_after_record_id: record._insertAnchorId }
      : {}),
  }));
}
