import { describe, expect, it, vi } from "vitest";

import {
  LatestValuePersistence,
  resolveLedgerCellCompletionAction,
  resolveLedgerCellEditState,
} from "@/utils/ledgerPersistence";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("ledger cell save state", () => {
  it("clears unsaved state immediately when a normal edit returns to the persisted value", () => {
    expect(resolveLedgerCellEditState("原值", "原值", 0)).toBe("clear");
    expect(resolveLedgerCellEditState("新值", "原值", 0)).toBe("dirty");
  });

  it("keeps a reverted value pending until an older save completes", () => {
    expect(resolveLedgerCellEditState("原值", "原值", 1)).toBe("dirty");
    expect(resolveLedgerCellCompletionAction({
      completedVersion: 2,
      currentVersion: 3,
      currentValue: "原值",
      persistedValue: "旧请求写入的新值",
      inFlightCount: 0,
    })).toBe("resave");
  });

  it("does not let an old response clear a newer queued edit", () => {
    expect(resolveLedgerCellCompletionAction({
      completedVersion: 2,
      currentVersion: 4,
      currentValue: "最新值",
      persistedValue: "旧值",
      inFlightCount: 1,
    })).toBe("pending");
    expect(resolveLedgerCellCompletionAction({
      completedVersion: 4,
      currentVersion: 4,
      currentValue: "最新值",
      persistedValue: "最新值",
      inFlightCount: 0,
    })).toBe("none");
  });

  it("keeps a revert pending when a newer queued request could still overwrite it", () => {
    expect(resolveLedgerCellCompletionAction({
      completedVersion: 2,
      currentVersion: 5,
      currentValue: "原值",
      persistedValue: "原值",
      inFlightCount: 1,
    })).toBe("pending");
  });
});

describe("latest-value persistence", () => {
  it("serializes rapid changes and never reapplies an obsolete response", async () => {
    const first = deferred<number>();
    const second = deferred<number>();
    const savedValues: number[] = [];
    const appliedValues: number[] = [];
    const queue = new LatestValuePersistence<number>({
      initialValue: 120,
      save: vi.fn((value: number) => {
        savedValues.push(value);
        return value === 180 ? first.promise : second.promise;
      }),
      apply: (value) => appliedValues.push(value),
      onLatestError: () => undefined,
    });

    queue.request(180);
    queue.request(240);
    expect(savedValues).toEqual([180]);
    expect(appliedValues).toEqual([180, 240]);

    first.resolve(180);
    await Promise.resolve();
    await Promise.resolve();
    expect(savedValues).toEqual([180, 240]);
    expect(appliedValues).toEqual([180, 240]);

    second.resolve(240);
    await queue.whenIdle();
    expect(appliedValues).toEqual([180, 240, 240]);
  });

  it("rolls the latest failed change back to the last committed value", async () => {
    const first = deferred<number>();
    const second = deferred<number>();
    const appliedValues: number[] = [];
    const errors: unknown[] = [];
    const queue = new LatestValuePersistence<number>({
      initialValue: 120,
      save: (value) => value === 180 ? first.promise : second.promise,
      apply: (value) => appliedValues.push(value),
      onLatestError: (error) => errors.push(error),
    });

    queue.request(180);
    queue.request(240);
    first.resolve(180);
    await Promise.resolve();
    await Promise.resolve();
    second.reject(new Error("保存失败"));
    await queue.whenIdle();

    expect(appliedValues).toEqual([180, 240, 180]);
    expect(errors).toHaveLength(1);
  });

  it("suppresses an obsolete failure when a newer value is waiting", async () => {
    const first = deferred<number>();
    const appliedValues: number[] = [];
    const errors: unknown[] = [];
    const queue = new LatestValuePersistence<number>({
      initialValue: 120,
      save: (value) => value === 180 ? first.promise : Promise.resolve(value),
      apply: (value) => appliedValues.push(value),
      onLatestError: (error) => errors.push(error),
    });

    queue.request(180);
    queue.request(240);
    first.reject(new Error("旧请求失败"));
    await queue.whenIdle();

    expect(appliedValues).toEqual([180, 240, 240]);
    expect(errors).toEqual([]);
  });
});
