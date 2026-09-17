import { describe, expect, it } from "vitest";

import { fieldDropTargetIndex, moveArrayItem } from "@/utils/fieldOrder";

describe("field ordering", () => {
  it("converts insertion boundaries to indexes after removing the source", () => {
    expect(fieldDropTargetIndex(1, 0, 4)).toBe(0);
    expect(fieldDropTargetIndex(1, 3, 4)).toBe(2);
    expect(fieldDropTargetIndex(1, 4, 4)).toBe(3);
  });

  it("supports moving directly to the first or last position", () => {
    expect(moveArrayItem(["a", "b", "c", "d"], 1, 3)).toEqual(["a", "c", "d", "b"]);
    expect(moveArrayItem(["a", "b", "c", "d"], 2, 0)).toEqual(["c", "a", "b", "d"]);
  });

  it("rejects invalid drag boundaries without corrupting the order", () => {
    expect(fieldDropTargetIndex(1, 5, 4)).toBe(-1);
    expect(moveArrayItem(["a", "b"], 5, 0)).toEqual(["a", "b"]);
  });
});
