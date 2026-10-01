const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function fixture({ choices = [0, 0], busy = false, saveFails = false } = {}) {
  const windows = [], calls = [], handlers = new Map();
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
      this.state = { dirty: true, busy, saved: false };
      const contents = new EventEmitter();
      Object.assign(contents, {
        id: this.id, mainFrame: {}, isDestroyed: () => this.destroyed,
        setWindowOpenHandler() {},
        send: (_channel, request) => {
          calls.push(`${this.id}:${request.action}`);
          if (request.action === "release") return;
          if (request.action === "save") this.state = { dirty: saveFails, busy: false, saved: !saveFails };
          queueMicrotask(() => handlers.get("gene-ledger:close-response")(
            { sender: contents, senderFrame: contents.mainFrame }, { requestId: request.requestId, ...this.state },
          ));
        },
      });
      this.contents = contents;
      // Electron destroys the native wrapper before 'closed' listeners run.
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
    getBounds() { return { x: 0, y: 0, width: 820, height: 680 }; }
    getNormalBounds() { return this.getBounds(); }
    setAlwaysOnTop() {}
    show() { this.visible = true; }
    focus() {}
    moveTop() {}
    loadURL() { return Promise.resolve(); }
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
      if (name === "node:fs") return { ...fs, mkdirSync() {}, writeFileSync() {}, renameSync() {} };
      return require(name);
    },
    module: { exports: {} }, __dirname: path.resolve(__dirname, ".."), process, console,
    setTimeout, clearTimeout, Buffer, URL, URLSearchParams,
  };
  const source = fs.readFileSync(path.resolve(__dirname, "../main.cjs"), "utf8");
  vm.runInNewContext(source + "\nmodule.exports = { createMainWindow, createQuickEntryWindow, registerDesktopHandlers };", context);
  const api = context.module.exports;
  api.registerDesktopHandlers();
  api.createMainWindow();
  api.createQuickEntryWindow({ projectId: "p1", selectedFieldIds: [], pinnedFieldIds: [] });
  windows.forEach((window) => handlers.get("gene-ledger:close-guard-ready")({ sender: window.contents, senderFrame: window.contents.mainFrame }));
  return { app, windows, calls, handlers, settle: async () => { for (let i = 0; i < 4; i += 1) await new Promise(setImmediate); } };
}

test("Ctrl+W reaches normal close protection and only exits after both renderers save", async () => {
  const f = fixture();
  let prevented = false;
  f.windows[0].contents.emit("before-input-event", { preventDefault() { prevented = true; } }, { control: true, key: "w" });
  await f.settle();
  assert.equal(prevented, true);
  assert.deepEqual(f.windows.map((window) => window.destroyed), [true, true]);
  assert.ok(f.calls.indexOf("2:save") < f.calls.indexOf("1:closed"));
  assert.ok(f.calls.indexOf("2:closed") < f.calls.indexOf("exit"));
  assert.equal(f.calls.filter((call) => call === "exit").length, 1);
});

test("app.quit cancellation, in-flight save and save failure keep both native windows alive", async () => {
  for (const options of [{ choices: [2] }, { busy: true }, { saveFails: true }]) {
    const f = fixture(options);
    f.app.quit();
    await f.settle();
    assert.deepEqual(f.windows.map((window) => window.destroyed), [false, false]);
    assert.equal(f.calls.includes("exit"), false);
    assert.equal(f.calls.includes("clipboard-cleanup"), false);
    assert.ok(f.calls.includes("1:release") && f.calls.includes("2:release"));
  }
});

test("closing only quick entry preserves the main window and does not quit the application", async () => {
  const f = fixture({ choices: [1] });
  f.windows[1].close();
  await f.settle();
  assert.deepEqual(f.windows.map((window) => window.destroyed), [false, true]);
  assert.equal(f.calls.includes("1:inspect"), false);
  assert.equal(f.calls.includes("exit"), false);
});

test("restart is scheduled only after drafts approve closing", async () => {
  const f = fixture({ choices: [2] });
  await f.handlers.get("gene-ledger:restart")({ sender: f.windows[0].contents });
  assert.equal(f.calls.includes("relaunch"), false);
  assert.equal(f.calls.includes("exit"), false);
});
