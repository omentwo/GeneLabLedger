import { afterEach, describe, expect, it, vi } from "vitest";

import {
  addExperimentPlanItem,
  applyExperimentPlan,
  deleteExperimentPlanItem,
  reorderExperimentPlan,
  updateExperimentPlan,
} from "@/api/experiments";

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("experiment plan API", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("adds a record to an editable plan by UUID without a date or repeat flag", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        id: "item-1",
        plan_id: "plan-1",
        record_id: "record-braf-1",
        project_id: "project-braf",
        project_name: "BRAFV600E",
        pathology_number: "26-00001",
        experiment_date: "2026-07-30",
        previous_experiment_number: null,
        position: 1,
        experiment_number: "20260801-1",
        status: "待实验",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await addExperimentPlanItem("plan-1", "record-braf-1");

    const [url, options] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe("/api/experiments/plans/plan-1/items");
    expect(options.method).toBe("POST");
    expect(JSON.parse(String(options.body))).toEqual({ record_id: "record-braf-1" });
  });

  it("persists item order and applies only through explicit plan actions", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(jsonResponse({ id: "plan-1", prefix: "20260801", items: [] })),
      );
    vi.stubGlobal("fetch", fetchMock);

    await reorderExperimentPlan("plan-1", ["item-2", "item-1"]);
    await updateExperimentPlan("plan-1", "CUSTOM");
    await applyExperimentPlan("plan-1");
    await deleteExperimentPlanItem("plan-1", "item-1");

    const calls = fetchMock.mock.calls as [string, RequestInit][];
    expect(calls[0]![0]).toBe("/api/experiments/plans/plan-1/order");
    expect(JSON.parse(String(calls[0]![1].body))).toEqual({
      item_ids: ["item-2", "item-1"],
    });
    expect(calls[1]![0]).toBe("/api/experiments/plans/plan-1");
    expect(calls[1]![1].method).toBe("PATCH");
    expect(JSON.parse(String(calls[1]![1].body))).toEqual({ prefix: "CUSTOM" });
    expect(calls[2]![0]).toBe("/api/experiments/plans/plan-1/apply");
    expect(calls[2]![1].method).toBe("POST");
    expect(calls[3]![0]).toBe("/api/experiments/plans/plan-1/items/item-1");
    expect(calls[3]![1].method).toBe("DELETE");
  });
});
