import { readonly, ref } from "vue";

export const THEME_STORAGE_KEY = "gene-lab-ledger.theme";
export const THEME_OPTIONS = [
  { id: "paper", name: "纸感暖灰", description: "暖灰层次，低调操作，纸面阅读感。", colors: ["#faf9f5", "#f0eee8", "#8b8680"] },
  { id: "indigo", name: "靛蓝工作台", description: "深墨蓝导航，靛蓝重点，雾灰背景。", colors: ["#202a44", "#4f5cc0", "#f4f5f9"] },
  { id: "sky", name: "天蓝清爽", description: "黑白底色，天蓝点缀，彩色图表。", colors: ["#3ea4ec", "#0e72bc", "#ffffff"] },
  { id: "noir", name: "暗室冷青", description: "近黑冷灰沉浸底色，冷青主色，青柠荧光强调。", colors: ["#121519", "#23b8d4", "#a3e635"] },
  { id: "biolum", name: "深渊冷光", description: "冷调黑曜多层画布，荧光青绿高对比，同位素琥珀警戒。", colors: ["#060709", "#00d2ff", "#00ff9d"] },
] as const;
export type ThemeId = (typeof THEME_OPTIONS)[number]["id"];
export const DEFAULT_THEME: ThemeId = "paper";

const selectedTheme = ref<ThemeId>(DEFAULT_THEME);
export const currentTheme = readonly(selectedTheme);

export function normalizeTheme(value: unknown): ThemeId {
  return THEME_OPTIONS.some((theme) => theme.id === value) ? value as ThemeId : DEFAULT_THEME;
}

function applyTheme(value: unknown): void {
  selectedTheme.value = normalizeTheme(value);
  // Root scope also reaches teleported dialogs and dropdowns.
  document.documentElement.dataset.theme = selectedTheme.value;
}

/** Applies immediately; false means storage is unavailable for the next launch. */
export function setTheme(theme: ThemeId): boolean {
  applyTheme(theme);
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, selectedTheme.value);
    return true;
  } catch {
    return false;
  }
}

/** Initialize before Vue mounts, including in standalone quick-entry windows. */
export function initializeTheme(): () => void {
  try {
    applyTheme(window.localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    applyTheme(DEFAULT_THEME);
  }
  const onStorage = (event: StorageEvent): void => {
    if (event.key !== THEME_STORAGE_KEY && event.key !== null) return;
    try {
      if (event.storageArea !== window.localStorage) return;
    } catch {
      return;
    }
    applyTheme(event.newValue);
  };
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
}
