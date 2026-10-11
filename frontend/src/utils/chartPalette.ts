import { computed } from "vue";

import { currentTheme } from "@/utils/themePreference";

const defaults: Record<string, string> = {
  "--app-chart-primary": "#736e67", "--app-chart-secondary": "#4e79a7",
  "--app-card": "#f0eee8", "--app-text": "#2d2a26", "--app-muted": "#6d6760",
  "--app-border": "#e3e1db", "--app-primary-text": "#6d6760",
};
// Mirrors --app-chart-category-* in tokens.css (Tableau hues, darkened to the
// 3:1 contrast floor); keep the two in sync.
const categories = ["#2e6d9e", "#c1500f", "#1f8080", "#9a8210", "#7a58b5", "#4f8a28", "#b04a78", "#67625b"];
categories.forEach((color, index) => { defaults[`--app-chart-category-${index + 1}`] = color; });

export function useChartPalette() {
  return computed(() => {
    // CSS alone is not reactive. The shared preference invalidates this palette
    // for both local switches and cross-window storage notifications.
    void currentTheme.value;
    const style = getComputedStyle(document.documentElement);
    return Object.fromEntries(Object.entries(defaults).map(([name, fallback]) =>
      [name, style.getPropertyValue(name).trim() || fallback]));
  });
}

/** Stable under sorting/filtering, unlike the project's index in a chart. */
export function projectColorSlot(projectId: string): number {
  let hash = 2166136261;
  for (const character of projectId) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return (hash >>> 0) % categories.length + 1;
}

/** Choose a readable label for the actual bar color in either theme. */
export function chartLabelColor(background: string): string {
  const hex = background.match(/^#([\da-f]{6})$/i)?.[1];
  const channels = hex ? [0, 2, 4].map((start) => parseInt(hex.slice(start, start + 2), 16))
    : background.match(/[\d.]+/g)?.slice(0, 3).map(Number);
  if (!channels || channels.length !== 3) return "#111111";
  const linear = channels.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const luminance = linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722;
  return (1.05 / (luminance + 0.05)) >= ((luminance + 0.05) / 0.05) ? "#ffffff" : "#000000";
}
