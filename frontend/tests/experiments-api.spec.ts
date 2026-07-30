import { afterEach, describe, expect, it, vi } from "vitest";

import {
  addExperimentRun,
  deleteExperimentRun,
  reorderExperimentRuns,
} from "@/api/experiments";

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("experiment API identity safety", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("adds the selected project record by its record id only", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        id: "run-braf-1",
        batch_id: "batch-1",
        record_id: "record-braf-1",
        project_id: "project-braf",
        project_name: "BRAFV600E",
        pathology_number: "26-00001",
        position: 1,
        experiment_number: "20260730-01",
        is_repeat: false,
        status: "待实验",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await addExperimentRun("2026-07-30", "record-braf-1", false);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/experiments/batches/2026-07-30/runs");
    expect(options.method).toBe("POST");
    expect(JSON.parse(String(options.body))).toEqual({
      record_id: "record-braf-1",
      allow_repeat: false,
    });
  });

  it("removes only the experiment run and never calls a record creation endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await deleteExperimentRun("run-braf-1");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/experiments/runs/run-braf-1");
    expect(options.method).toBe("DELETE");
  });

  it("persists the exact ordered run id list for the selected date", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ id: "batch-1", experiment_date: "2026-07-30", runs: [] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await reorderExperimentRuns("2026-07-30", ["run-2", "run-1"]);

    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/experiments/batches/2026-07-30/order");
    expect(options.method).toBe("PUT");
    expect(JSON.parse(String(options.body))).toEqual({
      run_ids: ["run-2", "run-1"],
    });
  });
});

