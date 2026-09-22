import { apiRequest } from "@/api/client";

export interface DatabaseBackupSettings {
  enabled: boolean;
  directory: string;
  interval_hours: number;
  retention_backup_days: number;
  copies_per_day: number;
  backup_on_shutdown: boolean;
}

export interface DatabaseBackupStatus {
  running: boolean;
  last_success_at: string | null;
  last_failure_at: string | null;
  last_error: string | null;
  last_path: string | null;
  last_reason: string | null;
  next_run_at: string | null;
}

export interface DatabaseBackupItem {
  path: string;
  filename: string;
  backup_date: string;
  created_at: string;
  size_bytes: number;
}

export interface DatabaseBackupRun {
  path: string;
  created_at: string;
  size_bytes: number;
  reason: string;
}

export interface DatabaseBackupRestoreResult {
  restart_required: boolean;
  safety_backup_path: string;
  source_backup_path: string;
}

export function getDatabaseBackupSettings(): Promise<DatabaseBackupSettings> {
  return apiRequest<DatabaseBackupSettings>("/database-backups/settings");
}

export function updateDatabaseBackupSettings(
  settings: DatabaseBackupSettings,
): Promise<DatabaseBackupSettings> {
  return apiRequest<DatabaseBackupSettings>("/database-backups/settings", {
    method: "PUT",
    body: JSON.stringify(settings),
  });
}

export function getDatabaseBackupStatus(): Promise<DatabaseBackupStatus> {
  return apiRequest<DatabaseBackupStatus>("/database-backups/status");
}

export function listDatabaseBackups(limit = 210): Promise<DatabaseBackupItem[]> {
  return apiRequest<DatabaseBackupItem[]>(`/database-backups?limit=${limit}`);
}

export function runDatabaseBackup(): Promise<DatabaseBackupRun> {
  return apiRequest<DatabaseBackupRun>("/database-backups/run", {
    method: "POST",
    timeoutMs: 300_000,
  });
}

export function prepareDatabaseBackupRestore(
  path: string,
): Promise<DatabaseBackupRestoreResult> {
  return apiRequest<DatabaseBackupRestoreResult>("/database-backups/restore", {
    method: "POST",
    body: JSON.stringify({ path }),
    timeoutMs: 300_000,
  });
}
