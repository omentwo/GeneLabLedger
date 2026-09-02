import { afterEach, describe, expect, it, vi } from "vitest";

import { createLedgerNativePreview } from "@/api/preview";

describe("ledger native preview API", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the selected scope and native action", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          job_id: "native-job",
          status: "open",
          action: "preview",
          print_engine: "word",
          document_type: "xlsx",
          filename: "ledger.xlsx",
          error: null,
          scope: "selection",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await createLedgerNativePreview("ledger-1", {
      action: "preview",
      scope: "selection",
      cells: [{ record_id: "record-1", field_id: "field-1" }],
      print_engine: "word",
    });

    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/ledgers/ledger-1/native-preview");
    expect(options.method).toBe("POST");
    expect(JSON.parse(String(options.body))).toEqual({
      action: "preview",
      scope: "selection",
      cells: [{ record_id: "record-1", field_id: "field-1" }],
      print_engine: "word",
    });
  });

  it("sends the current-project scope for Excel or WPS preview", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          job_id: "project-job",
          status: "open",
          action: "open",
          print_engine: "wps",
          document_type: "xlsx",
          filename: "project.xlsx",
          error: null,
          scope: "project",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await createLedgerNativePreview("ledger-1", {
      action: "open",
      scope: "project",
      print_engine: "wps",
    });

    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/ledgers/ledger-1/native-preview");
    expect(JSON.parse(String(options.body))).toEqual({
      action: "open",
      scope: "project",
      print_engine: "wps",
    });
  });
});
