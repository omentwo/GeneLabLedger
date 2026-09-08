import { describe, expect, it } from "vitest";

import {
  gridAutoScrollVector,
  nextGridScrollOffset,
} from "@/utils/gridAutoScroll";

const viewport = { left: 100, right: 500, top: 50, bottom: 350 };

describe("grid drag auto-scroll", () => {
  it("detects horizontal scrolling at and beyond the visible edges", () => {
    expect(gridAutoScrollVector(120, 200, viewport, 42)).toEqual({
      horizontal: -1,
      vertical: 0,
    });
    expect(gridAutoScrollVector(520, 200, viewport, 42)).toEqual({
      horizontal: 1,
      vertical: 0,
    });
  });

  it("supports vertical and diagonal scrolling", () => {
    expect(gridAutoScrollVector(300, 60, viewport, 42)).toEqual({
      horizontal: 0,
      vertical: -1,
    });
    expect(gridAutoScrollVector(520, 380, viewport, 42)).toEqual({
      horizontal: 1,
      vertical: 1,
    });
  });

  it("stays idle away from every edge", () => {
    expect(gridAutoScrollVector(300, 200, viewport, 42)).toEqual({
      horizontal: 0,
      vertical: 0,
    });
  });

  it("clamps each scroll step to the available range", () => {
    expect(nextGridScrollOffset(100, 500, 1, 24)).toBe(124);
    expect(nextGridScrollOffset(490, 500, 1, 24)).toBe(500);
    expect(nextGridScrollOffset(10, 500, -1, 24)).toBe(0);
  });
});
