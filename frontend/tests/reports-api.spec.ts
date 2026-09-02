import { afterEach, describe, expect, it, vi } from "vitest";

import {
  deleteReportTemplate,
  nativePreviewReport,
  printReports,
  replaceReportMappings,
} from "@/api/reports";

describe("report placeholder mappings", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("allows any placeholder to map to any selected ledger field id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "version-1",
          version_number: 1,
          original_filename: "TB.docx",
          placeholders: ["sex"],
          mappings: [],
          created_at: "2026-07-30T00:00:00",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await replaceReportMappings("version-1", [
      {
        placeholder: "sex",
        source_type: "field",
        field_id: "field-experiment-date",
        fixed_value: null,
      },
    ]);

    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/report-template-versions/version-1/mappings");
    expect(options.method).toBe("PUT");
    expect(JSON.parse(String(options.body))).toEqual({
      mappings: [
        {
          placeholder: "sex",
          source_type: "field",
          field_id: "field-experiment-date",
          fixed_value: null,
        },
      ],
    });
  });

  it("sends the combined pathology-number mapping without a field id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "version-1",
          version_number: 1,
          original_filename: "TB.docx",
          placeholders: ["case_no"],
          mappings: [],
          created_at: "2026-07-30T00:00:00",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await replaceReportMappings("version-1", [
      {
        placeholder: "case_no",
        source_type: "pathology_with_block",
        field_id: null,
        fixed_value: null,
      },
    ]);

    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(options.body))).toEqual({
      mappings: [
        {
          placeholder: "case_no",
          source_type: "pathology_with_block",
          field_id: null,
          fixed_value: null,
        },
      ],
    });
  });

  it("sends the selected Office print engine with a batch print request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          printer_name: "实验室打印机",
          printed_count: 2,
          print_engine: "word",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await printReports(
      "version-1",
      ["record-1", "record-2"],
      "实验室打印机",
      "word",
    );

    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/reports/print");
    expect(JSON.parse(String(options.body))).toEqual({
      template_version_id: "version-1",
      items: [
        { project_record_id: "record-1" },
        { project_record_id: "record-2" },
      ],
      printer_name: "实验室打印机",
      print_engine: "word",
    });
  });

  it("sends the native report action and selected engine", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          job_id: "native-job",
          status: "open",
          action: "open",
          print_engine: "word",
          document_type: "docx",
          filename: "report.docx",
          error: null,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await nativePreviewReport("version-1", "record-1", "word", "open");

    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/report-template-versions/version-1/native-preview");
    expect(JSON.parse(String(options.body))).toEqual({
      template_version_id: "version-1",
      record_ids: ["record-1"],
      print_engine: "word",
      action: "open",
    });
  });

  it("returns template cleanup warnings after the database delete succeeds", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          template_id: "template-1",
          removed_template_directory: false,
          cleanup_warnings: ["报告模板文件未能清理，请稍后手动检查"],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await deleteReportTemplate("template-1");

    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/report-templates/template-1");
    expect(options.method).toBe("DELETE");
    expect(result.cleanup_warnings).toHaveLength(1);
  });
});
