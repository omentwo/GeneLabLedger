import { describe, expect, it } from "vitest";

import type { FieldDefinition, ProjectRecord } from "@/types/api";
import { getRecordFieldValue } from "@/utils/recordFieldValue";

function field(systemKey: string | null): FieldDefinition {
  return {
    id: "field-id", project_id: "project-1", key: "pathology_number", label: "病理号",
    data_type: "text", system_key: systemKey, is_core: Boolean(systemKey), hidden: false,
    sort_order: 0, width: 120, options: [],
  };
}

const record: ProjectRecord = Object.freeze({
  id: "record-1", project_id: "project-1", project_name: "项目", position: 0,
  pathology_number: "26-1", block_number: "2", experiment_date: "2026-10-01",
  experiment_number: "20261001-3", status: "待实验", report_generated: false,
  locked: false, highlight_color: null, values: Object.freeze({ "field-id": "  自由文字  " }),
  created_at: "", updated_at: "",
});

describe("shared record field reader", () => {
  it.each([
    ["pathology_number", "26-1"], ["block_number", "2"],
    ["experiment_date", "2026-10-01"], ["experiment_number", "20261001-3"],
    ["status", "待实验"],
  ])("reads %s from the core field rather than the custom values", (key, expected) => {
    expect(getRecordFieldValue(record, field(key))).toBe(expected);
  });

  it.each(["block_number", "experiment_date", "experiment_number"])(
    "returns an empty string for a missing %s", (key) => {
      expect(getRecordFieldValue({ ...record, [key]: null }, field(key))).toBe("");
    },
  );

  it("reads custom fields by ID without inferring core fields from labels or formatting the value", () => {
    expect(getRecordFieldValue(record, field(null))).toBe("  自由文字  ");
    expect(getRecordFieldValue(record, { ...field(null), id: "missing" })).toBe("");
  });
});
