import { describe, expect, it } from "vitest";

import type { FieldDefinition, ProjectRecord } from "@/types/api";
import {
  buildQuickEntryChanges,
  normalizeQuickEntrySettings,
  parseCombinedPathologyNumber,
  resolveQuickEntryProjectSettings,
  unreportedQuickEntryRecords,
} from "@/utils/quickEntry";

function field(
  id: string,
  systemKey: string | null = null,
  options: Partial<FieldDefinition> = {},
): FieldDefinition {
  return {
    id,
    project_id: "project-1",
    key: id,
    label: id,
    data_type: systemKey === "experiment_date" ? "date" : "text",
    system_key: systemKey,
    is_core: Boolean(systemKey),
    hidden: false,
    sort_order: 0,
    width: 120,
    options: [],
    ...options,
  };
}

const fields = [
  field("date", "experiment_date", { sort_order: 0 }),
  field("pathology", "pathology_number", { sort_order: 1 }),
  field("number", "experiment_number", { sort_order: 2 }),
  field("status", "status", { data_type: "select", sort_order: 3 }),
  field("custom", null, { sort_order: 4 }),
  field("hidden", null, { hidden: true, sort_order: 5 }),
];

function record(id: string, reportGenerated = false): ProjectRecord {
  return {
    id,
    project_id: "project-1",
    project_name: "项目一",
    position: Number(id.replace(/\D/g, "")) || 0,
    pathology_number: `P-${id}`,
    status: "待实验",
    experiment_date: "2026-08-31",
    experiment_number: null,
    report_generated: reportGenerated,
    locked: false,
    highlight_color: null,
    values: { custom: "旧值", hidden: "隐藏值" },
    created_at: "",
    updated_at: "",
  };
}

describe("quick entry field settings", () => {
  it("normalizes persisted settings without trusting malformed values", () => {
    expect(normalizeQuickEntrySettings({
      projects: {
        "project-1": {
          selectedFieldIds: ["pathology", "pathology", 42],
          pinnedFieldIds: "date",
        },
        broken: null,
      },
    })).toEqual({
      version: 5,
      projects: {
        "project-1": {
          selectedFieldIds: ["pathology"],
          pinnedFieldIds: [],
          fieldWidth: 320,
          quickCreateFieldWidth: 320,
          fontSize: 14,
          inputHeight: 32,
          autoAdvanceAfterUpdate: true,
          clipboardFieldIds: ["pathology"],
          clipboardEnabled: false,
          clipboardOverwriteExisting: false,
          clipboardAutoContinue: false,
        },
      },
    });
  });

  it("keeps pathology selected and removes stale pinned fields", () => {
    expect(resolveQuickEntryProjectSettings(
      fields,
      {
        selectedFieldIds: ["hidden", "removed"],
        pinnedFieldIds: ["hidden", "pathology", "removed"],
        fieldWidth: 999,
        quickCreateFieldWidth: 150,
        fontSize: 99,
        inputHeight: 12,
        autoAdvanceAfterUpdate: false,
      },
    )).toEqual({
      selectedFieldIds: ["hidden", "pathology"],
      pinnedFieldIds: ["hidden"],
      fieldWidth: 600,
      quickCreateFieldWidth: 160,
      fontSize: 20,
      inputHeight: 28,
      autoAdvanceAfterUpdate: false,
      clipboardFieldIds: [],
      clipboardEnabled: false,
      clipboardOverwriteExisting: false,
      clipboardAutoContinue: false,
    });
  });

  it("uses current-view defaults before the user has saved a dedicated selection", () => {
    expect(resolveQuickEntryProjectSettings(fields, undefined, {
      selectedFieldIds: ["pathology", "number"],
      pinnedFieldIds: ["number"],
    })).toEqual({
      selectedFieldIds: ["pathology", "number"],
      pinnedFieldIds: ["number"],
      fieldWidth: 320,
      quickCreateFieldWidth: 320,
      fontSize: 14,
      inputHeight: 32,
      autoAdvanceAfterUpdate: true,
      clipboardFieldIds: ["number"],
      clipboardEnabled: false,
      clipboardOverwriteExisting: false,
      clipboardAutoContinue: false,
    });
  });

  it("respects an explicitly empty current-view selection while retaining mandatory fields", () => {
    expect(resolveQuickEntryProjectSettings(fields, undefined, {
      selectedFieldIds: [],
      pinnedFieldIds: [],
    })).toEqual({
      selectedFieldIds: ["pathology"],
      pinnedFieldIds: [],
      fieldWidth: 320,
      quickCreateFieldWidth: 320,
      fontSize: 14,
      inputHeight: 32,
      autoAdvanceAfterUpdate: true,
      clipboardFieldIds: [],
      clipboardEnabled: false,
      clipboardOverwriteExisting: false,
      clipboardAutoContinue: false,
    });
  });

  it("splits a combined pathology number at the final normalized dash", () => {
    expect(parseCombinedPathologyNumber(" A-20260907－3 ")).toEqual({
      pathologyNumber: "A-20260907",
      blockNumber: "3",
      normalized: "A-20260907-3",
    });
    expect(() => parseCombinedPathologyNumber("A20260907")).toThrow("病理号-蜡块号");
  });

  it("migrates v4 settings without changing the existing field order or dimensions", () => {
    const migrated = normalizeQuickEntrySettings({ version: 4, projects: {
      p: { selectedFieldIds: ["custom", "pathology", "date"], pinnedFieldIds: ["date"], fieldWidth: 410 },
    } });
    expect(migrated.version).toBe(5);
    expect(migrated.projects.p?.selectedFieldIds).toEqual(["custom", "pathology", "date"]);
    expect(migrated.projects.p?.fieldWidth).toBe(410);
    expect(migrated.projects.p?.clipboardEnabled).toBe(false);
    expect(resolveQuickEntryProjectSettings(fields, migrated.projects.p).clipboardFieldIds).toEqual(["custom", "date"]);
  });

  it("keeps paste order independent and excludes record identifiers, hidden and removed fields", () => {
    const resolved = resolveQuickEntryProjectSettings(fields, {
      selectedFieldIds: ["pathology", "date", "custom", "hidden"],
      clipboardFieldIds: ["custom", "hidden", "removed", "pathology", "date"], clipboardEnabled: true,
    });
    expect(resolved.selectedFieldIds).toEqual(["pathology", "date", "custom", "hidden"]);
    expect(resolved.clipboardFieldIds).toEqual(["custom", "date"]);
    expect(resolved.clipboardEnabled).toBe(true);
    expect(resolveQuickEntryProjectSettings(fields, { clipboardFieldIds: [] }).clipboardFieldIds).toEqual([]);
  });
});

describe("quick entry record operations", () => {
  it("creates optimistic-concurrency cell changes only for edited selected headers", () => {
    expect(buildQuickEntryChanges(
      record("1"),
      fields,
      ["pathology", "custom"],
      { pathology: "P-1", custom: "新值", hidden: "被忽略" },
      { pathology: "P-1", custom: "旧值", hidden: "隐藏值" },
    )).toEqual([
      {
        record_id: "1",
        field_id: "custom",
        value: "新值",
        expected_value: "旧值",
      },
    ]);
  });

  it("never exposes locked or generated-report records in the pathology-number list", () => {
    expect(unreportedQuickEntryRecords([
      { ...record("3"), position: 3 },
      { ...record("1"), position: 1 },
      { ...record("2", true), position: 2 },
      { ...record("4"), position: 4, locked: true },
    ]).map((item) => item.id)).toEqual(["1", "3"]);
  });
});
