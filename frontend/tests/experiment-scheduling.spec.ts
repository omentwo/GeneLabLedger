import { describe, expect, it } from "vitest";

import {
  compareExperimentPathologyNumbers,
  experimentPathologyNumber,
} from "@/utils/experimentScheduling";

describe("experiment scheduling pathology number", () => {
  it("appends a trimmed block number only for scheduling display", () => {
    const record = { pathology_number: "26-34856", block_number: " 1 " };

    expect(experimentPathologyNumber(record)).toBe("26-34856-1");
    expect(record.pathology_number).toBe("26-34856");
  });

  it("keeps the canonical pathology number when the block number is empty", () => {
    expect(
      experimentPathologyNumber({ pathology_number: "26-34856", block_number: null }),
    ).toBe("26-34856");
  });

  it("sorts blocks naturally within the same pathology number", () => {
    const records = [
      { pathology_number: "26-34856", block_number: "10" },
      { pathology_number: "26-34856", block_number: "2" },
      { pathology_number: "26-34855", block_number: "9" },
    ];

    records.sort(compareExperimentPathologyNumbers);

    expect(records.map(experimentPathologyNumber)).toEqual([
      "26-34855-9",
      "26-34856-2",
      "26-34856-10",
    ]);
  });
});
