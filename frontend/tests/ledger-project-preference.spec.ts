import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  LAST_LEDGER_PROJECT_STORAGE_KEY,
  readLastLedgerProjectId,
  rememberLastLedgerProjectId,
  resolveInitialLedgerProjectId,
} from "@/utils/ledgerProjectPreference";

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe("last opened ledger project", () => {
  it("prefers a valid project from the URL", () => {
    expect(resolveInitialLedgerProjectId("project-c", "project-b", ["project-a", "project-b", "project-c"])).toBe("project-c");
  });

  it("restores the remembered project when the URL has none", () => {
    expect(resolveInitialLedgerProjectId("", "project-b", ["project-a", "project-b"])).toBe("project-b");
  });

  it("falls back to the first project when the remembered project was deleted", () => {
    expect(resolveInitialLedgerProjectId("", "removed", ["project-a", "project-b"])).toBe("project-a");
    expect(resolveInitialLedgerProjectId("", "removed", [])).toBe("");
  });

  it("stores and reads the last project id", () => {
    expect(rememberLastLedgerProjectId(" project-b ")).toBe(true);
    expect(localStorage.getItem(LAST_LEDGER_PROJECT_STORAGE_KEY)).toBe("project-b");
    expect(readLastLedgerProjectId()).toBe("project-b");
  });

  it("does not interrupt navigation when browser storage is unavailable", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    expect(readLastLedgerProjectId()).toBe("");
    expect(rememberLastLedgerProjectId("project-b")).toBe(false);
    expect(rememberLastLedgerProjectId("  ")).toBe(false);
  });
});
