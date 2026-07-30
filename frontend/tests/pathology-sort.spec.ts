import { describe, expect, it } from "vitest";

import { comparePathologyNumbers } from "@/utils/pathologySort";

describe("pathology number natural order", () => {
  it("puts plain numeric prefixes before letter prefixes and sorts years ascending", () => {
    const values = [
      "K26-02483",
      "26-57559",
      "B26-08734",
      "25-99999",
      "26-07834",
      "26-00001",
    ];

    expect(values.sort(comparePathologyNumbers)).toEqual([
      "25-99999",
      "26-00001",
      "26-07834",
      "26-57559",
      "B26-08734",
      "K26-02483",
    ]);
  });
});
