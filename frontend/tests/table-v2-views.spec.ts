import ElementPlus, { ElMessage, ElMessageBox } from "element-plus";
import { createPinia } from "pinia";
import { createApp, nextTick, type Component } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getPreviewCapabilities } from "@/api/preview";
import { assignExperimentNumbers, listRecords } from "@/api/records";
import { listPrintEngines, listPrinters, listReportTemplates, nativePreviewReport, printReports, replaceReportMappings } from "@/api/reports";
import { getSetting } from "@/api/system";
import { useAppStore } from "@/stores/app";
import type { Project, ProjectRecord, ReportTemplate } from "@/types/api";
import { exportWorkbook } from "@/utils/workbook";
import ExperimentsView from "@/views/ExperimentsView.vue";
import ReportsView from "@/views/ReportsView.vue";

vi.mock("@/api/records", () => ({ listRecords: vi.fn(), assignExperimentNumbers: vi.fn() }));
vi.mock("@/api/system", () => ({ getSetting: vi.fn(), putSetting: vi.fn() }));
vi.mock("@/api/preview", () => ({ getPreviewCapabilities: vi.fn(), getNativePreviewStatus: vi.fn() }));
vi.mock("@/utils/workbook", () => ({ exportWorkbook: vi.fn() }));
vi.mock("@/api/reports", () => ({
  addReportTemplateVersion: vi.fn(), createReportTemplate: vi.fn(), deleteReportTemplate: vi.fn(),
  listPrintEngines: vi.fn(), listPrinters: vi.fn(), listReportTemplates: vi.fn(),
  nativePreviewReport: vi.fn(), printReports: vi.fn(), replaceReportMappings: vi.fn(),
}));

const project: Project = {
  id: "p1", name: "项目一", sort_order: 0, experiment_enabled: true, duplicate_pathology_warning_enabled: false,
  fields: [{
    id: "name", project_id: "p1", key: "name", label: "姓名", data_type: "text", system_key: null,
    is_core: false, hidden: false, sort_order: 0, width: 120, options: [],
  }],
};
const template: ReportTemplate = {
  id: "template-1", project_id: "p1", project_name: "项目一", name: "报告模板", created_at: "",
  versions: [{
    id: "version-1", version_number: 1, original_filename: "template.docx", created_at: "",
    placeholders: ["patient", "fixed"],
    mappings: [
      { id: "m1", placeholder: "patient", source_type: "field", field_id: "name", fixed_value: null },
      { id: "m2", placeholder: "fixed", source_type: "fixed", field_id: null, fixed_value: "原固定文字" },
    ],
  }],
};

function record(id: string, overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id, project_id: "p1", project_name: "项目一", position: 0, pathology_number: id,
    block_number: null, experiment_date: "2026-10-01", experiment_number: null, status: "待实验",
    report_generated: false, locked: false, highlight_color: null, values: { name: `姓名-${id}` },
    created_at: "", updated_at: "", ...overrides,
  };
}

const mountedApps: ReturnType<typeof createApp>[] = [];

beforeEach(() => {
  vi.resetAllMocks();
  window.localStorage.clear();
  // jsdom has no layout; provide dimensions while rendering the actual Table V2.
  vi.stubGlobal("ResizeObserver", class implements ResizeObserver {
    constructor(private callback: ResizeObserverCallback) {}
    observe(target: Element) {
      this.callback([{ target, contentRect: new DOMRect(0, 0, 900, 340) } as ResizeObserverEntry], this);
    }
    unobserve() {}
    disconnect() {}
  });
  for (const method of ["success", "warning", "error", "info"] as const) {
    vi.spyOn(ElMessage, method).mockReturnValue({ close: vi.fn() });
  }
  vi.spyOn(ElMessageBox, "confirm").mockImplementation(vi.fn().mockResolvedValue("confirm"));
  vi.mocked(getSetting).mockImplementation(async (key) => ({ key, value: null }));
  vi.mocked(exportWorkbook).mockResolvedValue(true);
  vi.mocked(listReportTemplates).mockResolvedValue([structuredClone(template)]);
  vi.mocked(listPrinters).mockResolvedValue([{ name: "测试打印机", is_default: true }]);
  vi.mocked(listPrintEngines).mockResolvedValue([{ key: "auto", label: "自动", available: true, resolved_engine: "word" }]);
  vi.mocked(getPreviewCapabilities).mockResolvedValue({
    microsoft_office: true, microsoft_writer: true, microsoft_spreadsheet: true,
    wps_writer: false, wps_spreadsheet: false, native_preview: true, preferred_engine: "microsoft",
  });
  vi.mocked(printReports).mockResolvedValue({ printer_name: "测试打印机", printed_count: 2, print_engine: "word" });
  vi.mocked(nativePreviewReport).mockResolvedValue({
    job_id: "preview-1", status: "completed", action: "preview", print_engine: "word",
    document_type: "docx", filename: "report.docx", error: null,
  });
  vi.mocked(replaceReportMappings).mockResolvedValue(structuredClone(template.versions[0]!));
});

afterEach(() => {
  mountedApps.splice(0).forEach((app) => app.unmount());
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mountView(view: Component, rows: ProjectRecord[], query = ""): Promise<HTMLElement> {
  vi.mocked(listRecords).mockResolvedValue({ items: rows, total: rows.length, limit: 1000, offset: 0 });
  vi.mocked(assignExperimentNumbers).mockImplementation(async (ids, prefix) =>
    ids.map((id, index) => ({ ...rows.find((row) => row.id === id)!, experiment_number: `${prefix}-${index + 1}` })),
  );
  const pinia = createPinia();
  useAppStore(pinia).projects = [structuredClone(project)];
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: "/", component: view }] });
  await router.push(`/${query}`);
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp(view);
  app.use(pinia).use(router).use(ElementPlus);
  mountedApps.push(app);
  app.mount(container);
  await vi.waitFor(() => expect(container.querySelectorAll(".el-table-v2").length).toBe(2));
  await nextTick();
  return container;
}

function button(root: ParentNode, label: string | RegExp): HTMLButtonElement {
  const result = Array.from(root.querySelectorAll("button")).find((node) =>
    typeof label === "string" ? node.textContent?.trim() === label : label.test(node.textContent ?? ""),
  );
  expect(result, `button ${String(label)}`).toBeDefined();
  return result!;
}

async function check(root: ParentNode, label: string): Promise<void> {
  const input = root.querySelector(`[aria-label="${label}"]`)?.querySelector<HTMLInputElement>("input");
  expect(input, label).not.toBeNull();
  input!.click();
  await nextTick();
}

async function inputValue(input: HTMLInputElement, value: string): Promise<void> {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await nextTick();
}

describe("experiment Table V2 interactions", () => {
  it("selects all records beyond the rendered rows, inverts selection and clears it on filtering", async () => {
    const rows = Array.from({ length: 80 }, (_, index) => record(`26-${index + 1}`));
    const container = await mountView(ExperimentsView, rows);
    const table = container.querySelector('[aria-label="待实验记录表"]')!;
    expect(table.querySelectorAll(".el-table-v2__main .el-table-v2__row").length).toBeLessThan(rows.length);
    await check(table, "选择待实验记录 26-1");
    expect(table.querySelector(".is-indeterminate")).not.toBeNull();
    button(container, "全选").click();
    await nextTick();
    expect(button(container, "加入编号（80）")).toBeDefined();
    button(container, "反选").click();
    await nextTick();
    expect(button(container, "加入编号（0）")).toBeDefined();
    await check(table, "选择待实验记录 26-1");
    await inputValue(container.querySelector<HTMLInputElement>('input[placeholder^="筛选病理号"]')!, "26-1");
    expect(button(container, "加入编号（0）")).toBeDefined();
  });

  it("keeps UUID selection order, moves rows and exports and assigns the displayed numbering order", async () => {
    const rows = [record("r1", { pathology_number: "26-10" }), record("r2", { pathology_number: "26-2", block_number: "1" }), record("r3", { pathology_number: "26-2", block_number: "2" })];
    const container = await mountView(ExperimentsView, rows);
    const candidate = container.querySelector('[aria-label="待实验记录表"]')!;
    const queue = container.querySelector('[aria-label="编号编排表"]')!;
    await inputValue(container.querySelector<HTMLInputElement>('input[placeholder="例如：20260801"]')!, "20261001");
    await check(candidate, "选择待实验记录 26-2-2");
    await check(candidate, "选择待实验记录 26-10");
    button(container, "加入编号（2）").click();
    await nextTick();
    const firstRow = () => queue.querySelector(".el-table-v2__main .el-table-v2__row")!.textContent;
    expect(firstRow()).toContain("26-2-2");
    queue.querySelector<HTMLButtonElement>('[aria-label="下移记录 26-2-2"]')!.click();
    await nextTick();
    expect(firstRow()).toContain("26-10");
    button(container, "应用排序").click();
    await nextTick();
    expect(firstRow()).toContain("26-2-2");
    expect(firstRow()).toContain("20261001-1");
    button(container, "导出 Excel").click();
    await vi.waitFor(() => expect(exportWorkbook).toHaveBeenCalledWith([{
      name: "实验编号", headers: ["序号", "实验编号", "病理号", "项目"],
      rows: [[1, "20261001-1", "26-2-2", "项目一"], [2, "20261001-2", "26-10", "项目一"]],
    }], "实验编号_20261001"));
    button(container, "编排完成并回写编号").click();
    await vi.waitFor(() => expect(assignExperimentNumbers).toHaveBeenCalledWith(["r3", "r1"], "20261001"));
    queue.querySelector<HTMLButtonElement>('[aria-label="移除记录 26-2-2"]')!.click();
    await vi.waitFor(() => expect(firstRow()).toContain("26-10"));
    button(container, "清空编号队列").click();
    await nextTick();
    expect(queue.textContent).toContain("当前没有已选择的记录");
    expect(button(container, "加入编号（0）")).toBeDefined();
  });
});

describe("report Table V2 interactions", () => {
  it("restores route selection and refresh selection, previews one record and prints in ledger order", async () => {
    const rows = [record("26-1"), record("26-2"), record("26-3", { report_generated: true })];
    const container = await mountView(ReportsView, rows, "?records=26-1,26-3");
    const table = container.querySelector('[aria-label="报告打印记录表"]')!;
    expect(table.querySelector(".el-table-v2__main .el-table-v2__row .el-table-v2__row-cell")!.textContent).toBe("26-1");
    expect(button(container, /直接打印\s*2\s*份/).disabled).toBe(false);
    const generated = Array.from(container.querySelectorAll(".el-checkbox")).find((node) => node.textContent?.includes("显示已生成报告"))!.querySelector<HTMLInputElement>("input")!;
    generated.click();
    await nextTick();
    expect(button(container, /直接打印\s*1\s*份/).disabled).toBe(false);
    expect(table.textContent).not.toContain("26-3");
    button(container, "刷新记录").click();
    await vi.waitFor(() => expect(listRecords).toHaveBeenCalledTimes(2));
    await nextTick();
    expect(button(container, "Office/WPS 原生预览").disabled).toBe(false);
    button(container, "Office/WPS 原生预览").click();
    await vi.waitFor(() => expect(nativePreviewReport).toHaveBeenCalledWith("version-1", "26-1", "auto", "preview"));
    await check(table, "选择报告记录 26-2");
    expect(button(container, "Office/WPS 原生预览").disabled).toBe(true);
    button(container, /直接打印\s*2\s*份/).click();
    await vi.waitFor(() => expect(printReports).toHaveBeenCalledWith("version-1", ["26-2", "26-1"], "测试打印机", "auto"));
    await inputValue(container.querySelector<HTMLInputElement>('input[placeholder="搜索病理号或任意台账内容"]')!, "26-1");
    expect(button(container, /直接打印\s*份/).disabled).toBe(true);
    expect(table.textContent).toContain("姓名：姓名-26-1");
  });

  it("selects unrendered report records and saves edited placeholder values", async () => {
    const rows = Array.from({ length: 80 }, (_, index) => record(`26-${index + 1}`));
    const container = await mountView(ReportsView, rows);
    const table = container.querySelector('[aria-label="报告打印记录表"]')!;
    expect(table.querySelectorAll(".el-table-v2__main .el-table-v2__row").length).toBeLessThan(rows.length);
    await check(table, "选择全部报告记录");
    expect(button(container, /直接打印\s*80\s*份/).disabled).toBe(false);
    const fixed = container.querySelector<HTMLInputElement>('input[aria-label="fixed 固定文字"]')!;
    await inputValue(fixed, "更新后的固定文字");
    button(container, "保存占位符映射").click();
    await vi.waitFor(() => expect(replaceReportMappings).toHaveBeenCalledWith("version-1", [
      { placeholder: "patient", source_type: "field", field_id: "name", fixed_value: null },
      { placeholder: "fixed", source_type: "fixed", field_id: null, fixed_value: "更新后的固定文字" },
    ]));
  });
});
