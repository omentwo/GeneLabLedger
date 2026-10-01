import ElementPlus from "element-plus";
import { createPinia } from "pinia";
import { createApp, nextTick, type Component } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { queryRecords } from "@/api/records";
import { getSetting } from "@/api/system";
import { useAppStore } from "@/stores/app";
import type { Project, ProjectRecord } from "@/types/api";
import LedgerView from "@/views/LedgerView.vue";

vi.mock("@/api/records", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/api/records")>(),
  queryRecords: vi.fn(),
}));
vi.mock("@/api/system", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/api/system")>(),
  getSetting: vi.fn(async () => ({ value: null })),
  putSetting: vi.fn(async () => undefined),
}));
vi.mock("@/api/preview", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/api/preview")>(),
  getPreviewCapabilities: vi.fn(async () => ({ native_preview: false })),
}));
vi.mock("@/utils/desktop", () => ({ desktopBridge: () => undefined }));

const longValue = "很长的诊断备注内容，".repeat(30);

const project: Project = {
  id: "p1", name: "项目一", sort_order: 0, experiment_enabled: true, duplicate_pathology_warning_enabled: false,
  fields: [{
    id: "note", project_id: "p1", key: "note", label: "备注", data_type: "text", system_key: null,
    is_core: false, hidden: false, sort_order: 0, width: 120, options: [],
  }],
};

function record(id: string, overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id, project_id: "p1", project_name: "项目一", position: 0, pathology_number: id,
    block_number: null, experiment_date: null, experiment_number: null, status: "待实验",
    report_generated: false, locked: false, highlight_color: null, values: { note: longValue },
    created_at: "", updated_at: "", ...overrides,
  };
}

const mountedApps: ReturnType<typeof createApp>[] = [];
const scrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");

beforeEach(() => {
  vi.resetAllMocks();
  window.localStorage.clear();
  // jsdom 未实现 scrollIntoView（进入编辑聚焦时调用）
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  vi.stubGlobal("ResizeObserver", class implements ResizeObserver {
    constructor(private callback: ResizeObserverCallback) {}
    observe(target: Element) {
      this.callback([{ target, contentRect: new DOMRect(0, 0, 900, 340) } as ResizeObserverEntry], this);
    }
    unobserve() {}
    disconnect() {}
  });
  vi.mocked(getSetting).mockImplementation(async (key) => ({ key, value: null }));
});

afterEach(() => {
  mountedApps.splice(0).forEach((app) => app.unmount());
  document.body.innerHTML = "";
  if (scrollIntoViewDescriptor) {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", scrollIntoViewDescriptor);
  } else {
    Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mountLedger(rows: ProjectRecord[]): Promise<HTMLElement> {
  vi.mocked(queryRecords).mockImplementation(async (query) => {
    const items = rows.map((row) => ({ ...row, values: { ...row.values } }));
    return { items, total: items.length, limit: query.limit, offset: 0 };
  });
  const pinia = createPinia();
  useAppStore(pinia).projects = [structuredClone(project)];
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: "/", component: LedgerView as Component }] });
  await router.push("/?project=p1");
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp(LedgerView as Component);
  app.use(pinia).use(router).use(ElementPlus);
  mountedApps.push(app);
  app.mount(container);
  await vi.waitFor(() => expect(container.querySelectorAll(".el-table-v2").length).toBe(1));
  await vi.waitFor(() => expect(container.querySelectorAll(".cell-field-value").length).toBeGreaterThan(0));
  await nextTick();
  return container;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 450));

describe("ledger cell native title", () => {
  it("sets the native title only when the text is clipped and clears it on leave", async () => {
    const container = await mountLedger([record("26-1")]);
    // 等表格初始化滚动稳定后再取单元格，避免行 DOM 在断言窗口内被重渲染替换
    await settle();
    const span = container.querySelector<HTMLElement>(".el-table-v2__main .cell-field-value")!;
    expect(span).toBeDefined();

    // 未截断的文本不设置 title
    span.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    expect(span.title).toBe("");

    // 截断后 hover 才写入完整内容，由浏览器原生展示
    Object.defineProperty(span, "scrollWidth", { configurable: true, value: 220 });
    Object.defineProperty(span, "clientWidth", { configurable: true, value: 100 });
    span.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    expect(span.title).toBe(longValue);

    // 移开后清除，避免行复用时残留旧内容
    span.dispatchEvent(new MouseEvent("mouseleave", { bubbles: true }));
    expect(span.title).toBe("");
  });
});
