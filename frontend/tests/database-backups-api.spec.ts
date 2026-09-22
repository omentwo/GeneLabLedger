import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getDatabaseBackupSettings,
  listDatabaseBackups,
  prepareDatabaseBackupRestore,
  runDatabaseBackup,
  updateDatabaseBackupSettings,
} from "@/api/databaseBackups";

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("database backup APIs", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads and updates the populated-day retention settings", async () => {
    const settings = {
      enabled: true,
      directory: "D:\\GeneLabBackups",
      interval_hours: 1,
      retention_backup_days: 7,
      copies_per_day: 30,
      backup_on_shutdown: true,
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(settings))
      .mockResolvedValueOnce(jsonResponse(settings));
    vi.stubGlobal("fetch", fetchMock);

    await getDatabaseBackupSettings();
    await updateDatabaseBackupSettings(settings);

    expect(fetchMock.mock.calls[0]![0]).toBe("/api/database-backups/settings");
    expect(fetchMock.mock.calls[1]![0]).toBe("/api/database-backups/settings");
    expect(fetchMock.mock.calls[1]![1]).toMatchObject({
      method: "PUT",
      body: JSON.stringify(settings),
    });
  });

  it("runs, lists, and prepares a selected complete backup for restore", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ path: "backup.glbkp" }))
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse({ restart_required: true }));
    vi.stubGlobal("fetch", fetchMock);

    await runDatabaseBackup();
    await listDatabaseBackups(210);
    await prepareDatabaseBackupRestore("D:\\GeneLabBackups\\backup.glbkp");

    expect(fetchMock.mock.calls[0]![0]).toBe("/api/database-backups/run");
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ method: "POST" });
    expect(fetchMock.mock.calls[1]![0]).toBe("/api/database-backups?limit=210");
    expect(fetchMock.mock.calls[2]![0]).toBe("/api/database-backups/restore");
    expect(JSON.parse(String((fetchMock.mock.calls[2]![1] as RequestInit).body))).toEqual({
      path: "D:\\GeneLabBackups\\backup.glbkp",
    });
  });
});
