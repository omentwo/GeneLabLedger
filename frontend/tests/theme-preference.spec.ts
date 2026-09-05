import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { currentTheme, initializeTheme, setTheme, THEME_STORAGE_KEY } from "@/utils/themePreference";

let dispose: (() => void) | undefined;

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  delete document.documentElement.dataset.theme;
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  vi.restoreAllMocks();
});

function notify(value: string | null, key: string | null = THEME_STORAGE_KEY, storage = localStorage): void {
  window.dispatchEvent(new StorageEvent("storage", { key, newValue: value, storageArea: storage }));
}

describe("color theme preference", () => {
  it("keeps the current paper style for a first launch", () => {
    dispose = initializeTheme();
    expect(currentTheme.value).toBe("paper");
    expect(document.documentElement.dataset.theme).toBe("paper");
  });

  it.each(["indigo", "sky", "noir", "biolum", "paper"] as const)("applies and restores %s before mounting", (theme) => {
    expect(setTheme(theme)).toBe(true);
    expect(currentTheme.value).toBe(theme);
    expect(document.documentElement.dataset.theme).toBe(theme);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe(theme);
    delete document.documentElement.dataset.theme;
    dispose = initializeTheme();
    expect(document.documentElement.dataset.theme).toBe(theme);
  });

  it("falls back safely for an unknown stored theme", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "removed-theme");
    dispose = initializeTheme();
    expect(currentTheme.value).toBe("paper");
  });

  it("syncs another window without writing back and causing notification loops", () => {
    dispose = initializeTheme();
    const write = vi.spyOn(Storage.prototype, "setItem");
    notify("sky");
    expect(currentTheme.value).toBe("sky");
    expect(document.documentElement.dataset.theme).toBe("sky");
    expect(write).not.toHaveBeenCalled();
    notify(null);
    expect(currentTheme.value).toBe("paper");
    notify("indigo");
    notify(null, null);
    expect(currentTheme.value).toBe("paper");
  });

  it("ignores unrelated preferences and session storage", () => {
    dispose = initializeTheme();
    notify("sky", "unrelated-key");
    notify("sky", THEME_STORAGE_KEY, sessionStorage);
    expect(currentTheme.value).toBe("paper");
  });

  it("still switches for this session when persistence is blocked", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("full"); });
    dispose = initializeTheme();
    expect(currentTheme.value).toBe("paper");
    expect(setTheme("indigo")).toBe(false);
    expect(document.documentElement.dataset.theme).toBe("indigo");
    expect(currentTheme.value).toBe("indigo");
  });

  it("removes the window listener when disposed", () => {
    dispose = initializeTheme();
    dispose();
    notify("sky");
    expect(currentTheme.value).toBe("paper");
  });
});
