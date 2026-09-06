import { describe, expect, it } from "vitest";

import {
  createExperimentProjectOrderSetting,
  normalizeExperimentProjectOrder,
} from "@/utils/experimentProjectOrder";

describe("experiment project order", () => {
  it("falls back to the current ledger order without a valid setting", () => {
    expect(normalizeExperimentProjectOrder(null, ["a", "b", "c"])).toEqual(["a", "b", "c"]);
    expect(normalizeExperimentProjectOrder({ project_ids: "bad" }, ["a", "b"])).toEqual(["a", "b"]);
  });

  it("keeps saved projects first and appends newly enabled projects", () => {
    expect(
      normalizeExperimentProjectOrder(
        { version: 1, project_ids: ["c", "a"] },
        ["a", "b", "c", "d"],
      ),
    ).toEqual(["c", "a", "b", "d"]);
  });

  it("removes unknown, invalid, and duplicate project ids", () => {
    expect(
      normalizeExperimentProjectOrder(
        { version: 1, project_ids: ["b", "removed", "b", null, "a"] },
        ["a", "b"],
      ),
    ).toEqual(["b", "a"]);
  });

  it("creates a versioned setting without duplicate ids", () => {
    expect(createExperimentProjectOrderSetting(["b", "a", "b"])).toEqual({
      version: 1,
      project_ids: ["b", "a"],
    });
  });
});
