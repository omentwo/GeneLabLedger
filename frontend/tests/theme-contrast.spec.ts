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

function lab(rgb: Rgb): [number, number, number] {
  const [r, g, b] = rgb.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const pivot = (t: number): number => (t > 0.008856 ? Math.cbrt(t) : (903.3 * t + 16) / 116);
  const fx = pivot((r! * 0.4124 + g! * 0.3576 + b! * 0.1805) / 0.95047);
  const fy = pivot(r! * 0.2126 + g! * 0.7152 + b! * 0.0722);
  const fz = pivot((r! * 0.0193 + g! * 0.1192 + b! * 0.9505) / 1.08883);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIEDE2000 perceptual difference; ≥10 reads as clearly distinct side by side. */
function deltaE2000(left: Rgb, right: Rgb): number {
  const [L1, a1, b1] = lab(left);
  const [L2, a2, b2] = lab(right);
  const chromaMean = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2;
  const g = 0.5 * (1 - Math.sqrt(chromaMean ** 7 / (chromaMean ** 7 + 25 ** 7)));
  const cp1 = Math.hypot((1 + g) * a1, b1);
  const cp2 = Math.hypot((1 + g) * a2, b2);
  const hp1 = (Math.atan2(b1, (1 + g) * a1) * 180 / Math.PI + 360) % 360;
  const hp2 = (Math.atan2(b2, (1 + g) * a2) * 180 / Math.PI + 360) % 360;
  const dL = L2 - L1;
  const dC = cp2 - cp1;
  let dhp = hp2 - hp1;
  if (Math.abs(dhp) > 180) dhp -= Math.sign(dhp) * 360;
  const dH = 2 * Math.sqrt(cp1 * cp2) * Math.sin(dhp * Math.PI / 360);
  const lightMean = (L1 + L2) / 2;
  const chromaBar = (cp1 + cp2) / 2;
  const hueBar = cp1 * cp2 === 0 ? hp1 + hp2
    : (Math.abs(hp1 - hp2) > 180 ? (hp1 + hp2 + 360) / 2 : (hp1 + hp2) / 2);
  const t = 1 - 0.17 * Math.cos((hueBar - 30) * Math.PI / 180) + 0.24 * Math.cos(2 * hueBar * Math.PI / 180)
    + 0.32 * Math.cos((3 * hueBar + 6) * Math.PI / 180) - 0.20 * Math.cos((4 * hueBar - 63) * Math.PI / 180);
  const rotation = 2 * Math.sqrt(chromaBar ** 7 / (chromaBar ** 7 + 25 ** 7))
    * Math.sin(60 * Math.exp(-(((hueBar - 275) / 25) ** 2)) * Math.PI / 180);
  const sl = 1 + 0.015 * (lightMean - 50) ** 2 / Math.sqrt(20 + (lightMean - 50) ** 2);
  const sc = 1 + 0.045 * chromaBar;
  const sh = 1 + 0.015 * chromaBar * t;
  return Math.sqrt((dL / sl) ** 2 + (dC / sc) ** 2 + (dH / sh) ** 2 - rotation * (dC / sc) * (dH / sh));
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

  it("keeps the eight categorical slots mutually distinguishable (ΔE2000 ≥ 14)", () => {
    // The floor also bans lightness-only same-hue pairs: two slots differing
    // only in brightness are unreadable as separate legend entries.
    const marks = Array.from({ length: 8 }, (_, index) => color(values[`--app-chart-category-${index + 1}`]!, values));
    marks.forEach((left, i) => marks.slice(i + 1).forEach((right, j) =>
      expect(deltaE2000(left, right), `category ${i + 1} vs ${i + j + 2}`).toBeGreaterThanOrEqual(14)));
  });

  it("keeps chart primary and secondary series distinguishable (ΔE2000 ≥ 13)", () => {
    // The 本月/上月 and trend pairs sit in one chart: a lightness-only step
    // between two same-hue colors cannot be told apart there.
    expect(deltaE2000(color(values["--app-chart-primary"]!, values), color(values["--app-chart-secondary"]!, values)))
      .toBeGreaterThanOrEqual(13);
  });
});
