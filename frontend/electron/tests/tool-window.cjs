const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// 与 main-window-close.cjs 同一套 vm 测试骨架，扩展点：
// - FakeWindow 记录构造选项、setAlwaysOnTop 调用与 webContents.send 明细；
// - fs mock 捕获 desktop-settings.json 写入，验证快速录入/工具窗口 bounds 分槽；
// - 导出 createToolWindow / showToolWindow 并把 dataDirectory 指到测试目录。
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
    show() { this.visible = true; }
    focus() {}
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
    setTimeout, clearTimeout, Buffer, URL, URLSearchParams,
  };
  const source = fs.readFileSync(path.resolve(__dirname, "../main.cjs"), "utf8");
  vm.runInNewContext(`${source}
dataDirectory = "test-data-dir";
module.exports = { createMainWindow, createQuickEntryWindow, createToolWindow, showToolWindow, registerDesktopHandlers };`, context);
  const api = context.module.exports;
  api.registerDesktopHandlers();
  api.createMainWindow();
  api.createQuickEntryWindow({ projectId: "p1", selectedFieldIds: [] });
  const senderFor = (window) => ({ sender: window.contents, senderFrame: window.contents.mainFrame });
  return { app, windows, calls, handlers, settingsWrites, senderFor, settle: async () => { for (let i = 0; i < 4; i += 1) await new Promise(setImmediate); } };
}

function openToolWindow(f, payload = { tool: "fields", projectId: "p1" }) {
  return f.handlers.get("gene-ledger:open-ledger-tools")(f.senderFor(f.windows[0]), payload);
}

test("tool window opens without topmost or parent and reuses the single instance", async () => {
  const f = fixture();
  await openToolWindow(f);
  assert.equal(f.windows.length, 3);
  const tool = f.windows[2];
  assert.equal(tool.options.alwaysOnTop, undefined);
  assert.equal(tool.options.parent, undefined);
  assert.equal(tool.options.modal, undefined);
  assert.deepEqual(tool.alwaysOnTopCalls, []);
  assert.ok(String(tool.options.title).includes("台账工具"));
  assert.ok(String(tool.loadedUrl).includes("/ledger-tools?tool=fields&project=p1"));

  // 未就绪时重复打开只保留 pendingContext，不建新窗口。
  await openToolWindow(f, { tool: "find-replace", projectId: "p1" });
  assert.equal(f.windows.length, 3);
  assert.equal(tool.sends.filter(({ channel }) => channel === "gene-ledger:ledger-tools-open-requested").length, 0);

  await f.handlers.get("gene-ledger:ledger-tools-ready")(f.senderFor(tool));
  assert.equal(tool.sends.filter(({ channel }) => channel === "gene-ledger:ledger-tools-open-requested").length, 1);

  await openToolWindow(f, { tool: "reorder", projectId: "p2" });
  const requested = tool.sends.filter(({ channel }) => channel === "gene-ledger:ledger-tools-open-requested");
  assert.equal(requested.length, 2);
  assert.equal(requested[1].payload.tool, "reorder");
  assert.equal(f.windows.length, 3);
});

test("tool IPC channels only accept the tool window as sender", async () => {
  const f = fixture();
  await openToolWindow(f);
  const tool = f.windows[2];
  await assert.rejects(async () => f.handlers.get("gene-ledger:ledger-tools-ready")(f.senderFor(f.windows[0])));
  await assert.rejects(async () => f.handlers.get("gene-ledger:ledger-tools-changed")(
    f.senderFor(f.windows[0]), { projectId: "p1", action: "fields" },
  ));
  await assert.rejects(async () => f.handlers.get("gene-ledger:locate-ledger-record")(
    f.senderFor(f.windows[0]), { projectId: "p1", recordId: "r1" },
  ));
  // 就绪之前 channel 也必须拒绝（sender 是工具窗口但 handler 顺序无关，这里仅验证主窗口路径）。
  await assert.rejects(async () => f.handlers.get("gene-ledger:locate-ledger-record")(
    f.senderFor(f.windows[0]), { projectId: "p1", recordId: "r1", fieldId: "f1" },
  ));
  assert.ok(tool);
});

test("tool changes fan out to main window (and quick entry for fields) with an acked queue", async () => {
  const f = fixture();
  await openToolWindow(f);
  const tool = f.windows[2];
  const main = f.windows[0];
  const quick = f.windows[1];
  await f.handlers.get("gene-ledger:quick-entry-ready")(f.senderFor(quick));
  await f.handlers.get("gene-ledger:ledger-tools-changed")(
    f.senderFor(tool), { projectId: "p1", action: "fields" },
  );
  const forwarded = main.sends.find(({ channel }) => channel === "gene-ledger:ledger-tools-changed");
  assert.equal(forwarded.payload.action, "fields");
  assert.ok(forwarded.payload.revision >= 1);
  const quickNotify = quick.sends.find(({ channel }) => channel === "gene-ledger:quick-entry-fields-changed");
  assert.equal(quickNotify.payload.projectId, "p1");
  assert.ok(quick);

  let pending = await f.handlers.get("gene-ledger:get-pending-tool-changes")(f.senderFor(main));
  assert.equal(JSON.stringify(pending), JSON.stringify([
    { projectId: "p1", revision: forwarded.payload.revision, action: "fields" },
  ]));
  await f.handlers.get("gene-ledger:acknowledge-tool-changes")(f.senderFor(main), pending);
  pending = await f.handlers.get("gene-ledger:get-pending-tool-changes")(f.senderFor(main));
  assert.equal(pending.length, 0);
});

test("locate request raises the main window and forwards the payload", async () => {
  const f = fixture();
  await openToolWindow(f);
  const tool = f.windows[2];
  const main = f.windows[0];
  await f.handlers.get("gene-ledger:locate-ledger-record")(
    f.senderFor(tool), { projectId: "p1", recordId: "r1", fieldId: "f1" },
  );
  const located = main.sends.find(({ channel }) => channel === "gene-ledger:ledger-tools-locate-record");
  // vm 沙箱里的对象原型与测试环境不同，改用 JSON 形态比较。
  assert.equal(JSON.stringify(located.payload), JSON.stringify({ projectId: "p1", recordId: "r1", fieldId: "f1" }));
  await assert.rejects(async () => f.handlers.get("gene-ledger:locate-ledger-record")(
    f.senderFor(tool), { projectId: "", recordId: "r1" },
  ));
});

test("quick entry and tool window bounds persist into separate settings slots", async () => {
  const f = fixture();
  await openToolWindow(f);
  const tool = f.windows[2];
  const quick = f.windows[1];
  tool.normalBounds = { x: 11, y: 22, width: 1080, height: 760 };
  quick.normalBounds = { x: 5, y: 6, width: 820, height: 680 };
  quick.emit("close", { preventDefault() {} });
  tool.emit("close", { preventDefault() {} });
  await f.settle();
  const last = f.settingsWrites.at(-1);
  assert.equal(last.toolWindowBounds.x, 11);
  assert.equal(last.quickEntryBounds.x, 5);
});

test("application quit also closes the tool window before stopping the backend", async () => {
  const f = fixture({ choices: [0, 0, 0] });
  await openToolWindow(f);
  f.app.quit();
  await f.settle();
  assert.deepEqual(f.windows.map((window) => window.destroyed), [true, true, true]);
  assert.equal(f.calls.filter((call) => call === "exit").length, 1);
  assert.ok(f.calls.includes("clipboard-cleanup"));
});
