import { afterEach, describe, expect, it, vi } from "vitest";
import { computed } from "vue";

import { chartLabelColor, projectColorSlot, useChartPalette } from "@/utils/chartPalette";
import { setTheme } from "@/utils/themePreference";

afterEach(() => { vi.restoreAllMocks(); setTheme("paper"); });

describe("theme-aware chart palette", () => {
  it("updates cached chart options when only the theme changes", () => {
    vi.spyOn(window, "getComputedStyle").mockImplementation(() => ({
      getPropertyValue: (name: string) => name === "--app-chart-primary"
        ? document.documentElement.dataset.theme === "noir" ? "#38bdf8" : "#736e67"
        : name === "--app-card" ? document.documentElement.dataset.theme === "noir" ? "#1a1f26" : "#f0eee8" : "",
    }) as CSSStyleDeclaration);
    setTheme("paper");
    const palette = useChartPalette();
    const option = computed(() => ({ color: palette.value["--app-chart-primary"], tooltip: palette.value["--app-card"] }));
    const first = option.value;
    setTheme("noir");
    expect(option.value).toEqual({ color: "#38bdf8", tooltip: "#1a1f26" });
    expect(option.value).not.toBe(first);
  });

  it("assigns projects independently of chart sorting and filters", () => {
    const ids = ["project-1", "project-2", "project-3"];
    const colors = new Map(ids.map((id) => [id, projectColorSlot(id)]));
    [...ids].reverse().slice(0, 2).forEach((id) => expect(projectColorSlot(id)).toBe(colors.get(id)));
    ids.forEach((id) => expect(projectColorSlot(id)).toBeGreaterThanOrEqual(1));
    ids.forEach((id) => expect(projectColorSlot(id)).toBeLessThanOrEqual(8));
  });

  it("uses dark labels on bright bars and white labels on dark bars", () => {
    expect(chartLabelColor("#fbbf24")).toBe("#000000");
    expect(chartLabelColor("#2563a6")).toBe("#ffffff");
    expect(chartLabelColor("rgb(251, 191, 36)")).toBe("#000000");
  });
});
