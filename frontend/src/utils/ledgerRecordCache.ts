import type { ProjectRecord, RecordComplexQuery } from "@/types/api";

export interface LedgerRecordSnapshot {
  records: ProjectRecord[];
  total: number;
}

export interface LedgerRecordCacheHit {
  snapshot: LedgerRecordSnapshot;
  stale: boolean;
}

interface LedgerRecordCacheEntry {
  key: string;
  projectId: string;
  snapshot: LedgerRecordSnapshot;
  storedAt: number;
  lastAccessOrder: number;
}

export interface LedgerRecordCacheOptions {
  maxEntries?: number;
  staleTimeMs?: number;
  maxAgeMs?: number;
  now?: () => number;
}

function cloneRecord(record: ProjectRecord): ProjectRecord {
  return {
    ...record,
    cell_highlight_colors: { ...record.cell_highlight_colors },
    values: { ...record.values },
  };
}

function cloneSnapshot(snapshot: LedgerRecordSnapshot): LedgerRecordSnapshot {
  return {
    records: snapshot.records.map(cloneRecord),
    total: snapshot.total,
  };
}

function normalizedQuery(query: RecordComplexQuery): RecordComplexQuery {
  return {
    ...query,
    field_filters: [...query.field_filters]
      .map((filter) => (
        "values" in filter && Array.isArray(filter.values)
          ? { ...filter, values: [...filter.values].sort() }
          : { ...filter }
      ))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
  };
}

export function ledgerRecordQueryKey(query: RecordComplexQuery): string {
  return JSON.stringify(normalizedQuery(query));
}

export class LedgerRecordCache {
  private readonly entries = new Map<string, LedgerRecordCacheEntry>();

  private readonly maxEntries: number;

  private readonly staleTimeMs: number;

  private readonly maxAgeMs: number;

  private readonly now: () => number;

  private accessSequence = 0;

  constructor(options: LedgerRecordCacheOptions = {}) {
    this.maxEntries = Math.max(1, options.maxEntries ?? 8);
    this.staleTimeMs = Math.max(0, options.staleTimeMs ?? 30_000);
    this.maxAgeMs = Math.max(this.staleTimeMs, options.maxAgeMs ?? 10 * 60_000);
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    return this.entries.size;
  }

  isFresh(key: string): boolean {
    const entry = this.entries.get(key);
    if (!entry) return false;
    const now = this.now();
    const age = now - entry.storedAt;
    if (age > this.maxAgeMs) {
      this.entries.delete(key);
      return false;
    }
    if (age > this.staleTimeMs) return false;
    entry.lastAccessOrder = ++this.accessSequence;
    return true;
  }

  get(key: string): LedgerRecordCacheHit | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    const now = this.now();
    const age = now - entry.storedAt;
    if (age > this.maxAgeMs) {
      this.entries.delete(key);
      return null;
    }
    entry.lastAccessOrder = ++this.accessSequence;
    return {
      snapshot: cloneSnapshot(entry.snapshot),
      stale: age > this.staleTimeMs,
    };
  }

  set(
    key: string,
    projectId: string,
    snapshot: LedgerRecordSnapshot,
  ): void {
    const now = this.now();
    this.entries.set(key, {
      key,
      projectId,
      snapshot: cloneSnapshot(snapshot),
      storedAt: now,
      lastAccessOrder: ++this.accessSequence,
    });
    this.evictLeastRecentlyUsed();
  }

  invalidateProject(projectId: string): void {
    this.entries.forEach((entry, key) => {
      if (entry.projectId === projectId) this.entries.delete(key);
    });
  }

  clear(): void {
    this.entries.clear();
  }

  private evictLeastRecentlyUsed(): void {
    while (this.entries.size > this.maxEntries) {
      let oldestKey: string | null = null;
      let oldestAccessOrder = Number.POSITIVE_INFINITY;
      this.entries.forEach((entry) => {
        if (entry.lastAccessOrder < oldestAccessOrder) {
          oldestKey = entry.key;
          oldestAccessOrder = entry.lastAccessOrder;
        }
      });
      if (oldestKey === null) return;
      this.entries.delete(oldestKey);
    }
  }
}
