const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// 与 main-window-close.cjs 同一套 vm 测试骨架，扩展点：
// - FakeWindow 记录构造选项（parent/alwaysOnTop）、setAlwaysOnTop 调用与
//   webContents.send 明细；
// - fs mock 捕获 desktop-settings.json 写入，验证 bounds 按 tool 分槽；
// - 导出 createToolWindow / showToolWindow / normalizeStoredBoundsMap。
function fixture({ choices = [] } = {}) {
  const windows = [], calls = [], handlers = new Map(), settingsWrites = [];
  const app = new EventEmitter();
  Object.assign(app, {
    isPackaged: false, requestSingleInstanceLock: () => true, whenReady: () => new Promise(() => {}),
    getPath: () => "test-only-settings", relaunch: () => calls.push("relaunch"), exit: () => calls.push("exit"),
    quit: () => app.emit("before-quit", { preventDefault() { calls.push("prevent-quit"); } }),
  });
  class FakeWindow extends EventEmitter {
    constructor(options) {
      super();
      this.id = windows.length + 1;
      this.options = options;
      this.destroyed = false;
      this.visible = false;
      this.normalBounds = { x: 0, y: 0, width: 820, height: 680 };
      this.alwaysOnTopCalls = [];
      this.sends = [];
      this.state = { dirty: true, busy: false, saved: false };
      const window = this;
      const contents = new EventEmitter();
      Object.assign(contents, {
        id: this.id, mainFrame: {}, isDestroyed: () => this.destroyed,
        setWindowOpenHandler() {},
        send: (channel, payload) => {
          window.sends.push({ channel, payload });
          calls.push(`${window.id}:${channel}`);
          if (channel !== "gene-ledger:close-request") return;
          if (payload.action === "release") return;
          if (payload.action === "save") window.state = { dirty: false, busy: false, saved: true };
          queueMicrotask(() => handlers.get("gene-ledger:close-response")(
            { sender: contents, senderFrame: contents.mainFrame },
            { requestId: payload.requestId, ...window.state },
          ));
        },
      });
      this.contents = contents;
      Object.defineProperty(this, "webContents", { get: () => {
        if (this.destroyed) throw new Error("Object has been destroyed");
        return contents;
      } });
      windows.push(this);
    }
    isDestroyed() { return this.destroyed; }
    isMinimized() { return false; }
    isMaximized() { return false; }
    isVisible() { return this.visible; }
    getBounds() { return this.normalBounds; }
    getNormalBounds() { return this.normalBounds; }
    setAlwaysOnTop(flag, level) { this.alwaysOnTopCalls.push([flag, level]); }
    show() { this.visible = true; this.showCalls = (this.showCalls ?? 0) + 1; }
    focus() { this.focusCalls = (this.focusCalls ?? 0) + 1; }
    restore() { this.visible = true; this.restoreCalls = (this.restoreCalls ?? 0) + 1; }
    showInactive() { this.visible = true; this.showInactiveCalls = (this.showInactiveCalls ?? 0) + 1; }
    moveTop() {}
    loadURL(url) { this.loadedUrl = url; return Promise.resolve(); }
    loadFile() { return Promise.resolve(); }
    close() {
      let prevented = false;
      this.emit("close", { preventDefault() { prevented = true; } });
      if (prevented) return;
      this.destroyed = true;
      calls.push(`${this.id}:closed`);
      this.emit("closed");
      if (windows.every((window) => window.destroyed)) app.emit("window-all-closed");
    }
  }
  const electron = {
    app, BrowserWindow: FakeWindow, Menu: {}, screen: {},
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    dialog: { showMessageBox: async (parent, options) => {
      if (!options || options.buttons.length === 1) { calls.push("blocked"); return { response: 0 }; }
      calls.push(`${parent.id}:prompt`);
      return { response: choices.shift() ?? 2 };
    } },
  };
  const context = {
    require: (name) => {
      if (name === "electron") return electron;
      if (name === "./window-close.cjs") return require("../window-close.cjs");
      if (name === "./clipboard-follow.cjs") return { ClipboardFollower: class {
        close() { calls.push("clipboard-cleanup"); return Promise.resolve(); }
      } };
      if (name === "node:fs") {
        return { ...fs, mkdirSync() {}, writeFileSync(_path, content) { settingsWrites.push(JSON.parse(content)); }, renameSync() {} };
      }
      return require(name);
    },
    module: { exports: {} }, __dirname: path.resolve(__dirname, ".."), process, console,
    // unref：显示兜底等测试内不触发的定时器不应拖住测试进程退出。
    setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref?.(); return timer; },
    clearTimeout, Buffer, URL, URLSearchParams,
  };
  const source = fs.readFileSync(path.resolve(__dirname, "../main.cjs"), "utf8");
  vm.runInNewContext(`${source}
dataDirectory = "test-data-dir";
module.exports = {
  createMainWindow, createQuickEntryWindow, createToolWindow, showToolWindow,
  registerDesktopHandlers, normalizeStoredBoundsMap,
};`, context);
  const api = context.module.exports;
  api.registerDesktopHandlers();
  api.createMainWindow();
  api.createQuickEntryWindow({ projectId: "p1", selectedFieldIds: [] });
  const senderFor = (window) => ({ sender: window.contents, senderFrame: window.contents.mainFrame });
  return { app, windows, calls, handlers, settingsWrites, senderFor, settle: async () => { for (let i = 0; i < 4; i += 1) await new Promise(setImmediate); } };
}

function loadNormalizeStoredBoundsMap() {
  const source = fs.readFileSync(path.resolve(__dirname, "../main.cjs"), "utf8");
  const app = new EventEmitter();
  Object.assign(app, {
    isPackaged: false, requestSingleInstanceLock: () => true, whenReady: () => new Promise(() => {}),
    getPath: () => "test-only-settings",
  });
  const electron = {
    app, BrowserWindow: class {}, Menu: {}, screen: {},
    ipcMain: { handle() {} }, dialog: {},
  };
  const context = {
    require: (name) => {
      if (name === "electron") return electron;
      if (name === "./window-close.cjs") return require("../window-close.cjs");
      if (name === "./clipboard-follow.cjs") return { ClipboardFollower: class {
        close() { return Promise.resolve(); }
      } };
      return require(name);
    },
    module: { exports: {} }, __dirname: path.resolve(__dirname, ".."), process, console,
    setTimeout, clearTimeout, Buffer, URL, URLSearchParams,
  };
  vm.runInNewContext(`${source}\nmodule.exports = { normalizeStoredBoundsMap };`, context);
  return context.module.exports.normalizeStoredBoundsMap;
}

function openToolWindow(f, payload) {
  return f.handlers.get("gene-ledger:open-ledger-tools")(f.senderFor(f.windows[0]), payload);
}

test("three tool windows open independently with per-tool singletons", async () => {
  const f = fixture();
  await openToolWindow(f, { tool: "fields", projectId: "p1" });
  await openToolWindow(f, { tool: "find-replace", projectId: "p1" });
  await openToolWindow(f, { tool: "reorder", projectId: "p1" });
  assert.equal(f.windows.length, 5);
  const fields = f.windows[2];
  const findReplace = f.windows[3];
  const reorder = f.windows[4];

  // 三个窗口都是普通独立顶层窗口（类 WPS/Excel 查找替换）：
  // 无 parent、无 modal、不置顶——可与主窗口并排摆放、互相遮挡、随时拖动。
  for (const window of [fields, findReplace, reorder]) {
    assert.equal(window.options.parent, undefined);
    assert.equal(window.options.modal, undefined);
    assert.equal(window.options.alwaysOnTop, undefined);
    assert.deepEqual(window.alwaysOnTopCalls, []);
  }
  assert.ok(String(fields.options.title).includes("管理项目与表头"));
  assert.ok(String(fields.loadedUrl).includes("/ledger-tools?tool=fields&project=p1"));
  assert.ok(String(findReplace.options.title).includes("查找替换"));
  assert.ok(String(findReplace.loadedUrl).includes("/ledger-tools?tool=find-replace"));
  assert.ok(String(reorder.options.title).includes("按日期重排"));

  // 显示时机：创建后不立即可见（ready-to-show 空壳不再显示），
  // 渲染层发出 ledger-tools-ready 后才 show + focus。
  assert.equal(fields.isVisible(), false);
  assert.equal(findReplace.isVisible(), false);
  assert.equal(reorder.isVisible(), false);
  await f.handlers.get("gene-ledger:ledger-tools-ready")(f.senderFor(findReplace));
  assert.equal(findReplace.isVisible(), true);
  assert.equal(fields.isVisible(), false);

  // 按 tool 各自单例：重复打开不建新窗口，就绪后补发 open-requested。
  await f.handlers.get("gene-ledger:ledger-tools-ready")(f.senderFor(findReplace));
  await openToolWindow(f, { tool: "find-replace", projectId: "p2" });
  await openToolWindow(f, { tool: "fields", projectId: "p2" });
  assert.equal(f.windows.length, 5);
  const requested = findReplace.sends.filter(({ channel }) => channel === "gene-ledger:ledger-tools-open-requested");
  assert.equal(requested.length, 1);
  assert.equal(JSON.stringify(requested[0].payload), JSON.stringify({
    tool: "find-replace", mode: "replace", projectId: "p2",
  }));
  assert.equal(
    fields.sends.filter(({ channel }) => channel === "gene-ledger:ledger-tools-open-requested").length, 0,
  );
});

test("tool IPC channels accept any tool window but reject the main window", async () => {
  const f = fixture();
  await openToolWindow(f, { tool: "fields", projectId: "p1" });
  const fields = f.windows[2];
  await assert.rejects(async () => f.handlers.get("gene-ledger:ledger-tools-ready")(f.senderFor(f.windows[0])));
  await assert.rejects(async () => f.handlers.get("gene-ledger:ledger-tools-changed")(
    f.senderFor(f.windows[0]), { projectId: "p1", action: "fields" },
  ));
  // sender 校验只看窗口身份：同一工具窗口重复就绪也是合法调用。
  await f.handlers.get("gene-ledger:ledger-tools-ready")(f.senderFor(fields));
  await f.handlers.get("gene-ledger:ledger-tools-ready")(f.senderFor(fields));
});

test("tool changes fan out to main window (and quick entry for fields) with an acked queue", async () => {
  const f = fixture();
  await openToolWindow(f, { tool: "fields", projectId: "p1" });
  const fields = f.windows[2];
  const main = f.windows[0];
  const quick = f.windows[1];
  await f.handlers.get("gene-ledger:quick-entry-ready")(f.senderFor(quick));
  await f.handlers.get("gene-ledger:ledger-tools-changed")(
    f.senderFor(fields), { projectId: "p1", action: "fields" },
  );
  const forwarded = main.sends.find(({ channel }) => channel === "gene-ledger:ledger-tools-changed");
  assert.equal(forwarded.payload.action, "fields");
  assert.ok(forwarded.payload.revision >= 1);
  const quickNotify = quick.sends.find(({ channel }) => channel === "gene-ledger:quick-entry-fields-changed");
  assert.equal(quickNotify.payload.projectId, "p1");

  let pending = await f.handlers.get("gene-ledger:get-pending-tool-changes")(f.senderFor(main));
  assert.equal(JSON.stringify(pending), JSON.stringify([
    { projectId: "p1", revision: forwarded.payload.revision, action: "fields" },
  ]));
  await f.handlers.get("gene-ledger:acknowledge-tool-changes")(f.senderFor(main), pending);
  pending = await f.handlers.get("gene-ledger:get-pending-tool-changes")(f.senderFor(main));
  assert.equal(pending.length, 0);
});

test("locate request forwards the payload and surfaces the main window without stealing focus", async () => {
  const f = fixture();
  await openToolWindow(f, { tool: "find-replace", projectId: "p1" });
  const findReplace = f.windows[2];
  const main = f.windows[0];
  await f.handlers.get("gene-ledger:locate-ledger-record")(
    f.senderFor(findReplace), { projectId: "p1", recordId: "r1", fieldId: "f1" },
  );
  const located = main.sends.find(({ channel }) => channel === "gene-ledger:ledger-tools-locate-record");
  // vm 沙箱里的对象原型与测试环境不同，改用 JSON 形态比较。
  assert.equal(JSON.stringify(located.payload), JSON.stringify({ projectId: "p1", recordId: "r1", fieldId: "f1" }));
  // 置顶但不抢焦点：showInactive 浮现主表，show/focus 不参与（那是抢焦点路径）。
  assert.equal(main.isVisible(), true);
  assert.equal(main.showInactiveCalls, 1);
  assert.equal(main.restoreCalls ?? 0, 0);
  assert.equal(main.showCalls ?? 0, 0);
  assert.equal(main.focusCalls ?? 0, 0);
  // 最小化状态下先还原再置顶。
  main.isMinimized = () => true;
  await f.handlers.get("gene-ledger:locate-ledger-record")(
    f.senderFor(findReplace), { projectId: "p1", recordId: "r2", fieldId: "f2" },
  );
  assert.equal(main.restoreCalls, 1);
  assert.equal(main.showInactiveCalls, 2);
  await assert.rejects(async () => f.handlers.get("gene-ledger:locate-ledger-record")(
    f.senderFor(findReplace), { projectId: "", recordId: "r1" },
  ));
});

test("bounds persist into per-tool settings slots and quick entry keeps its own", async () => {
  const f = fixture();
  await openToolWindow(f, { tool: "fields", projectId: "p1" });
  await openToolWindow(f, { tool: "find-replace", projectId: "p1" });
  await openToolWindow(f, { tool: "reorder", projectId: "p1" });
  const [, quick, fields, findReplace, reorder] = f.windows;
  fields.normalBounds = { x: 11, y: 22, width: 1080, height: 760 };
  findReplace.normalBounds = { x: 55, y: 56, width: 560, height: 680 };
  reorder.normalBounds = { x: 33, y: 34, width: 720, height: 560 };
  quick.normalBounds = { x: 5, y: 6, width: 820, height: 680 };
  quick.emit("close", { preventDefault() {} });
  fields.emit("close", { preventDefault() {} });
  findReplace.emit("close", { preventDefault() {} });
  reorder.emit("close", { preventDefault() {} });
  await f.settle();
  const last = f.settingsWrites.at(-1);
  assert.equal(last.toolWindowBounds.fields.x, 11);
  assert.equal(last.toolWindowBounds["find-replace"].x, 55);
  assert.equal(last.toolWindowBounds.reorder.x, 33);
  assert.equal(last.quickEntryBounds.x, 5);
});

test("legacy single-window bounds migrate into the fields slot", () => {
  const normalizeStoredBoundsMap = loadNormalizeStoredBoundsMap();
  const migrated = normalizeStoredBoundsMap({ x: 1, y: 2, width: 1080, height: 760 });
  assert.equal(migrated.fields.x, 1);
  assert.equal(migrated.reorder, null);
  assert.equal(migrated["find-replace"], null);
  const fresh = normalizeStoredBoundsMap({
    fields: { x: 9, y: 9, width: 100, height: 100 }, reorder: null,
  });
  assert.equal(fresh.fields.x, 9);
  assert.equal(fresh["find-replace"], null);
  const garbage = normalizeStoredBoundsMap("oops");
  assert.equal(garbage.fields, null);
  assert.equal(garbage.reorder, null);
  assert.equal(garbage["find-replace"], null);
});

test("application quit also closes every tool window before stopping the backend", async () => {
  const f = fixture({ choices: [0, 0, 0, 0] });
  await openToolWindow(f, { tool: "fields", projectId: "p1" });
  await openToolWindow(f, { tool: "find-replace", projectId: "p1" });
  await openToolWindow(f, { tool: "reorder", projectId: "p1" });
  f.app.quit();
  await f.settle();
  assert.deepEqual(f.windows.map((window) => window.destroyed), [true, true, true, true, true]);
  assert.equal(f.calls.filter((call) => call === "exit").length, 1);
  assert.ok(f.calls.includes("clipboard-cleanup"));
});
