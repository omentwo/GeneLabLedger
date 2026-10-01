import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { chartLabelColor } from "@/utils/chartPalette";
import { THEME_OPTIONS } from "@/utils/themePreference";

type Rgb = [number, number, number];
const sources = ["tokens.css", "themes.css", "index.css"].map((file) =>
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../src/styles", file), "utf8"));
const blocks = sources.flatMap((source) => [...source.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .filter((match) => match[1]!.includes(":root"))
  .map((match) => ({ selector: match[1]!, values: Object.fromEntries(
    [...match[2]!.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((item) => [item[1]!, item[2]!.trim()]),
  ) })));

function themeValues(theme: string): Record<string, string> {
  return Object.assign({}, ...blocks.filter((block) => !block.selector.includes("[data-theme"))
    .map((block) => block.values), ...blocks.filter((block) => block.selector.includes(`[data-theme="${theme}"]`))
    .map((block) => block.values));
}

function color(value: string, values: Record<string, string>, underlay: Rgb = [255, 255, 255]): Rgb {
  if (value.startsWith("var(")) return color(values[value.slice(4, -1)]!, values, underlay);
  if (/^#[\da-f]{6}$/i.test(value)) return [0, 2, 4].map((offset) => parseInt(value.slice(1 + offset, 3 + offset), 16)) as Rgb;
  const match = value.match(/^rgb\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+)(%)?)?\s*\)$/);
  if (!match) throw new Error(`Unsupported contrast color: ${value}`);
  const alpha = match[4] ? Number(match[4]) / (match[5] ? 100 : 1) : 1;
  return [1, 2, 3].map((index) => Number(match[index]) * alpha + underlay[index - 1]! * (1 - alpha)) as Rgb;
}

function luminance(rgb: Rgb): number {
  const [red, green, blue] = rgb.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return red! * 0.2126 + green! * 0.7152 + blue! * 0.0722;
}

function contrast(left: Rgb, right: Rgb): number {
  const values = [luminance(left), luminance(right)].sort((a, b) => b - a);
  return (values[0]! + 0.05) / (values[1]! + 0.05);
}

describe.each(THEME_OPTIONS.map((theme) => theme.id))("%s theme contrast", (theme) => {
  const values = themeValues(theme);
  const canvas = color(values["--app-bg"]!, values);
  const card = color(values["--app-card"]!, values, canvas);
  const ratio = (foreground: string, background: string): number => {
    const surface = color(values[background]!, values, card);
    return contrast(color(values[foreground]!, values, surface), surface);
  };

  it("keeps body, secondary, small text, navigation and primary button labels at 4.5:1", () => {
    const pairs = [
      ...["--app-text", "--app-muted", "--app-subtle"].flatMap((text) =>
        ["--app-bg", "--app-card", "--app-surface-soft"].map((surface) => [text, surface])),
      ["--app-primary-text", "--app-primary-soft"], ["--app-warning-text", "--app-warning-soft"],
      ["--app-danger-text", "--app-danger-soft"], ["--app-danger-text", "--app-card"],
      ["--app-success-text", "--app-card"], ["--app-on-danger", "--app-danger"],
      ["--app-nav-text", "--app-nav-bg"], ["--app-nav-muted", "--app-nav-bg"],
      ["--app-nav-active-text", "--app-nav-active"],
      ["--app-on-primary", "--app-primary"], ["--app-on-primary", "--app-primary-hover"],
      ["--app-on-warning", "--app-warning"], ["--app-on-success", "--app-success"],
    ];
    pairs.forEach(([foreground, background]) => expect(ratio(foreground!, background!), `${foreground} on ${background}`).toBeGreaterThanOrEqual(4.5));
  });

  it("keeps control outlines and essential chart marks at 3:1", () => {
    ["--app-bg", "--app-card"].forEach((background) =>
      expect(ratio("--app-control-border", background), `control on ${background}`).toBeGreaterThanOrEqual(3));
    const marks = ["--app-chart-primary", "--app-chart-secondary", ...Array.from({ length: 8 }, (_, index) => `--app-chart-category-${index + 1}`)];
    marks.forEach((mark) => expect(ratio(mark, "--app-card"), mark).toBeGreaterThanOrEqual(3));
  });

  it("keeps automatically chosen bar labels readable at 4.5:1", () => {
    for (let index = 1; index <= 8; index += 1) {
      const background = color(values[`--app-chart-category-${index}`]!, values);
      const hex = `#${background.map((channel) => Math.round(channel).toString(16).padStart(2, "0")).join("")}`;
      expect(contrast(color(chartLabelColor(hex), values), background)).toBeGreaterThanOrEqual(4.5);
    }
  });
});
