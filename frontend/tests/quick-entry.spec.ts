import { describe, expect, it } from "vitest";

import type { FieldDefinition, ProjectRecord } from "@/types/api";
import {
  buildQuickEntryChanges,
  buildQuickEntryCreatePayload,
  normalizeQuickEntrySettings,
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
  field("required", null, {
    sort_order: 4,
    validation_rules: { required: true },
  }),
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
    values: { required: "旧值", hidden: "隐藏值" },
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
      version: 1,
      projects: {
        "project-1": {
          selectedFieldIds: ["pathology"],
          pinnedFieldIds: [],
        },
      },
    });
  });

  it("keeps pathology and required fields selected and removes stale pinned fields", () => {
    expect(resolveQuickEntryProjectSettings(
      fields,
      {
        selectedFieldIds: ["hidden", "removed"],
        pinnedFieldIds: ["hidden", "pathology", "removed"],
      },
    )).toEqual({
      selectedFieldIds: ["pathology", "required", "hidden"],
      pinnedFieldIds: ["hidden"],
    });
  });

  it("uses current-view defaults before the user has saved a dedicated selection", () => {
    expect(resolveQuickEntryProjectSettings(fields, undefined, {
      selectedFieldIds: ["pathology", "number"],
      pinnedFieldIds: ["number"],
    })).toEqual({
      selectedFieldIds: ["pathology", "number", "required"],
      pinnedFieldIds: ["number"],
    });
  });

  it("respects an explicitly empty current-view selection while retaining mandatory fields", () => {
    expect(resolveQuickEntryProjectSettings(fields, undefined, {
      selectedFieldIds: [],
      pinnedFieldIds: [],
    })).toEqual({
      selectedFieldIds: ["pathology", "required"],
      pinnedFieldIds: [],
    });
  });
});

describe("quick entry record operations", () => {
  it("builds a create payload from only the selected quick-entry fields", () => {
    expect(buildQuickEntryCreatePayload(
      "project-1",
      fields,
      ["date", "pathology", "status", "required"],
      {
        date: "2026/8/3",
        pathology: " P-100 ",
        status: "已完成",
        required: " 新值 ",
        hidden: "不应提交",
      },
    )).toEqual({
      project_id: "project-1",
      pathology_number: "P-100",
      status: "已完成",
      experiment_date: "2026-08-03",
      experiment_number: null,
      values: { required: "新值" },
    });
  });

  it("creates optimistic-concurrency cell changes only for edited selected headers", () => {
    expect(buildQuickEntryChanges(
      record("1"),
      fields,
      ["pathology", "required"],
      { pathology: "P-1", required: "新值", hidden: "被忽略" },
      { pathology: "P-1", required: "旧值", hidden: "隐藏值" },
    )).toEqual([
      {
        record_id: "1",
        field_id: "required",
        value: "新值",
        expected_value: "旧值",
      },
    ]);
  });

  it("never exposes generated-report records in the pathology-number list", () => {
    expect(unreportedQuickEntryRecords([
      { ...record("3"), position: 3 },
      { ...record("1"), position: 1 },
      { ...record("2", true), position: 2 },
    ]).map((item) => item.id)).toEqual(["1", "3"]);
  });
});
