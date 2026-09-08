export type RecordSelectionScope = "all" | "unlocked";
export type RecordSelectionAction = "select-all" | "invert";

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
