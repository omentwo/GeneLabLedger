export type RecordSelectionScope = "all" | "unlocked";
export type RecordSelectionAction = "select-all" | "invert";
export type RecordSelectionRange = { start: number; end: number };

type SelectableRecord = {
  id: string;
  locked: boolean;
};

export function recordMatchesSelectionScope(
  record: Pick<SelectableRecord, "locked">,
  scope: RecordSelectionScope,
): boolean {
  return scope === "all" || !record.locked;
}

export function applyVisibleRecordSelection(input: {
  visibleRecords: SelectableRecord[];
  selectedIds: ReadonlySet<string>;
  scope: RecordSelectionScope;
  action: RecordSelectionAction;
}): Set<string> {
  const next = new Set(input.selectedIds);
  input.visibleRecords.forEach((record) => {
    if (!recordMatchesSelectionScope(record, input.scope)) return;
    if (input.action === "select-all") next.add(record.id);
    else if (next.has(record.id)) next.delete(record.id);
    else next.add(record.id);
  });
  return next;
}

export function normalizeRecordSelectionRange(
  start: number,
  end: number,
): RecordSelectionRange {
  return start <= end ? { start, end } : { start: end, end: start };
}

export function recordSelectionRangeContains(
  range: RecordSelectionRange,
  rowIndex: number,
): boolean {
  return rowIndex >= range.start && rowIndex <= range.end;
}

export function applyRecordSelectionRange<T extends { id: string }>(input: {
  records: readonly T[];
  initialSelectedIds: ReadonlySet<string>;
  startIndex: number;
  endIndex: number;
  selected: boolean;
  isSelectable?: (record: T, rowIndex: number) => boolean;
}): Set<string> {
  const next = new Set(input.initialSelectedIds);
  if (!input.records.length) return next;
  const normalized = normalizeRecordSelectionRange(input.startIndex, input.endIndex);
  const start = Math.max(0, normalized.start);
  const end = Math.min(input.records.length - 1, normalized.end);
  for (let rowIndex = start; rowIndex <= end; rowIndex += 1) {
    const record = input.records[rowIndex];
    if (!record || (input.isSelectable && !input.isSelectable(record, rowIndex))) continue;
    if (input.selected) next.add(record.id);
    else next.delete(record.id);
  }
  return next;
}
