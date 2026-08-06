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
});
