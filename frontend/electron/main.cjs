const { app, BrowserWindow, Menu, dialog, ipcMain, screen } = require("electron");
const { execFile, spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { ClipboardFollower } = require("./clipboard-follow.cjs");
const { WindowCloseCoordinator } = require("./window-close.cjs");

const APP_TITLE = "基因检测台账";
const CONFIG_FILENAME = "desktop-settings.json";
const BACKEND_EXECUTABLE = "GeneLabLedgerBackend.exe";
const MAX_EXPORT_BYTES = 256 * 1024 * 1024;
const QUICK_ENTRY_MIN_WIDTH = 620;
const QUICK_ENTRY_MIN_HEIGHT = 460;
const QUICK_ENTRY_DEFAULT_WIDTH = 820;
const QUICK_ENTRY_DEFAULT_HEIGHT = 680;

let mainWindow = null;
let quickEntryWindow = null;
let quickEntryRendererReady = false;
let quickEntryPendingContext = null;
let quickEntryChangeRevision = 0;
const pendingQuickEntryProjectChanges = new Map();
let backendProcess = null;
let backendUrl = "";
let backendShutdownToken = "";
let dataDirectory = "";
let alwaysOnTop = false;
let quickEntryBounds = null;
let quickEntryBoundsTimer = null;
let quitting = false;
const closeGuardReady = new Set();
const approvedWindowCloses = new Set();
const pendingCloseRequests = new Map();
const closeCoordinator = new WindowCloseCoordinator({
  inspect: (window) => requestRendererCloseState(window, "inspect"),
  save: (window) => requestRendererCloseState(window, "save"),
  release: (window) => {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send("gene-ledger:close-request", { requestId: crypto.randomUUID(), action: "release" });
    }
  },
  confirm: async (window) => {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    const result = await dialog.showMessageBox(window, {
      type: "warning",
      title: "关闭前保存修改",
      message: window === quickEntryWindow ? "快速录入中有未保存的草稿。" : "台账中有未保存的修改。",
      detail: "选择保存后关闭，或放弃未保存内容。取消会保留窗口和草稿。",
      buttons: ["保存后关闭", "放弃修改", "取消"],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    });
    return ["save", "discard", "cancel"][result.response];
  },
  blocked: (message) => {
    const options = { type: "warning", title: "暂未关闭", message, buttons: ["返回修改"] };
    const owner = BrowserWindow.getFocusedWindow?.() ?? [quickEntryWindow, mainWindow]
      .find((window) => window && !window.isDestroyed() && window.isVisible());
    return owner ? dialog.showMessageBox(owner, options) : dialog.showMessageBox(options);
  },
});

function closeIpcWindow(event) {
  const window = [mainWindow, quickEntryWindow].find((candidate) =>
    candidate && !candidate.isDestroyed() && candidate.webContents.id === event.sender.id);
  if (!window || (event.senderFrame && event.senderFrame !== event.sender.mainFrame)) {
    throw new Error("拒绝来自非业务窗口的关闭调用");
  }
  return window;
}

function requestRendererCloseState(window, action) {
  if (window.isDestroyed()) return Promise.resolve({ dirty: false, busy: false, saved: true });
  // A window that has not mounted yet cannot contain a user draft.
  if (!closeGuardReady.has(window.webContents.id)) {
    return Promise.resolve({ dirty: false, busy: false, saved: true });
  }
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const timer = setTimeout(() => {
      pendingCloseRequests.delete(requestId);
      reject(new Error("窗口未能及时确认保存状态，已保留窗口，请稍后重试。"));
    }, action === "save" ? 120_000 : 10_000);
    pendingCloseRequests.set(requestId, { senderId: window.webContents.id, resolve, reject, timer });
    window.webContents.send("gene-ledger:close-request", { requestId, action });
  });
}

function registerWindowCloseProtection(window, main = false) {
  const windowId = window.id;
  const senderId = window.webContents.id;
  window.on("close", (event) => {
    if (approvedWindowCloses.has(window.id)) return;
    event.preventDefault();
    if (main) void requestApplicationClose();
    else void closeCoordinator.request([window], () => closeApprovedWindow(window));
  });
  window.on("closed", () => {
    closeGuardReady.delete(senderId);
    approvedWindowCloses.delete(windowId);
  });
  window.webContents.on("render-process-gone", () => {
    for (const [requestId, request] of pendingCloseRequests) {
      if (request.senderId !== senderId) continue;
      clearTimeout(request.timer);
      pendingCloseRequests.delete(requestId);
      request.reject(new Error("窗口进程异常，无法确认草稿状态，已取消关闭。"));
    }
  });
}

function closeApprovedWindow(window) {
  if (window.isDestroyed()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const windowId = window.id;
    const finish = (error) => {
      clearTimeout(timer);
      window.removeListener("closed", closed);
      contents.removeListener("will-prevent-unload", prevented);
      if (error) {
        approvedWindowCloses.delete(windowId);
        reject(error);
      } else resolve();
    };
    const contents = window.webContents;
    const closed = () => {
      clearTimeout(timer);
      contents.removeListener("will-prevent-unload", prevented);
      resolve();
    };
    const prevented = () => finish(new Error("窗口取消了关闭，未保存内容仍保留。"));
    const timer = setTimeout(() => finish(new Error("窗口尚未完成关闭，后台服务已保留，请稍后重试。")), 15_000);
    window.once("closed", closed);
    contents.once("will-prevent-unload", prevented);
    approvedWindowCloses.add(windowId);
    window.close();
  });
}

function requestApplicationClose(restart = false) {
  if (quitting) return Promise.resolve(false);
  const windows = [mainWindow, quickEntryWindow].filter((window) => window && !window.isDestroyed());
  return closeCoordinator.request(windows, async () => {
    // Backend shutdown and relaunch happen only after every window approved.
    quitting = true;
    try {
      // Complete native unload/closed events before stopping HTTP services.
      for (const window of [...windows].reverse()) await closeApprovedWindow(window);
    } catch (error) {
      quitting = false;
      throw error;
    }
    if (restart) app.relaunch();
    await Promise.allSettled([clipboardFollower.close(), stopBackend()]);
    app.exit(0);
  });
}
const clipboardFollower = new ClipboardFollower({
  command: () => app.isPackaged ? packagedBackendCommand() : developmentBackendCommand(),
  onEvent: (payload) => {
    if (
      quickEntryWindow && !quickEntryWindow.isDestroyed() && quickEntryRendererReady &&
      !quickEntryWindow.webContents.isDestroyed() &&
      (payload.type !== "clipboard" || (quickEntryWindow.isVisible() && !quickEntryWindow.isMinimized()))
    ) {
      quickEntryWindow.webContents.send("gene-ledger:clipboard-follow-event", payload);
    }
  },
});

function pauseClipboardFollow(reason) {
  const context = clipboardFollower.session;
  if (context) void clipboardFollower.stop(context.sessionId, reason);
}

function normalizeStoredBounds(value) {
  if (!value || typeof value !== "object") return null;
  const x = Number(value.x);
  const y = Number(value.y);
  const width = Number(value.width);
  const height = Number(value.height);
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
    return null;
  }
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
  };
}

function settingsDirectory() {
  return path.join(app.getPath("userData"), "settings");
}

function settingsPath() {
  return path.join(settingsDirectory(), CONFIG_FILENAME);
}

function readDesktopSettings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
    return {
      dataDirectory:
        typeof parsed.dataDirectory === "string" && path.isAbsolute(parsed.dataDirectory)
          ? path.resolve(parsed.dataDirectory)
          : "",
      alwaysOnTop: parsed.alwaysOnTop === true,
      quickEntryBounds: normalizeStoredBounds(parsed.quickEntryBounds),
    };
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.error("桌面设置读取失败", error);
    }
  }
  return { dataDirectory: "", alwaysOnTop: false, quickEntryBounds: null };
}

function writeDesktopSettings(
  nextDirectory,
  nextAlwaysOnTop = alwaysOnTop,
  nextQuickEntryBounds = quickEntryBounds,
) {
  const directory = path.resolve(nextDirectory);
  fs.mkdirSync(settingsDirectory(), { recursive: true });
  const temporaryPath = `${settingsPath()}.tmp`;
  fs.writeFileSync(
    temporaryPath,
    `${JSON.stringify(
      {
        dataDirectory: directory,
        alwaysOnTop: Boolean(nextAlwaysOnTop),
        quickEntryBounds: normalizeStoredBounds(nextQuickEntryBounds),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  fs.renameSync(temporaryPath, settingsPath());
  return directory;
}

async function showDirectoryPicker(initialDirectory, title) {
  const fallback = app.getPath("documents");
  const defaultPath =
    initialDirectory && fs.existsSync(initialDirectory) ? initialDirectory : fallback;
  const result = await dialog.showOpenDialog(mainWindow ?? undefined, {
    title,
    defaultPath,
    buttonLabel: "选择此目录",
    properties: ["openDirectory", "createDirectory", "promptToCreate"],
  });
  return result.canceled ? null : path.resolve(result.filePaths[0]);
}

async function ensureDataDirectory() {
  const configured = readDesktopSettings().dataDirectory;
  if (configured) {
    fs.mkdirSync(configured, { recursive: true });
    return configured;
  }

  await dialog.showMessageBox({
    type: "info",
    title: "选择数据存放位置",
    message: "首次启动需要选择数据库和模板的存放目录。",
    detail: "此目录可以位于本机磁盘或可靠的共享盘；软件不会把业务数据库放进安装目录。",
    buttons: ["选择目录"],
  });
  const selected = await showDirectoryPicker("", "选择基因检测台账数据目录");
  if (!selected) return null;
  fs.mkdirSync(selected, { recursive: true });
  return writeDesktopSettings(selected);
}

function findAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function developmentBackendCommand() {
  const backendRoot = path.resolve(__dirname, "../../backend");
  const configuredPython = process.env.GENE_LEDGER_PYTHON;
  const virtualEnvironmentPython = path.join(backendRoot, ".venv", "Scripts", "python.exe");
  const executable =
    configuredPython || (fs.existsSync(virtualEnvironmentPython) ? virtualEnvironmentPython : "python");
  return {
    executable,
    args: [path.join(backendRoot, "desktop", "launcher.py")],
    cwd: backendRoot,
  };
}

function packagedBackendCommand() {
  const executable = path.join(process.resourcesPath, "backend", BACKEND_EXECUTABLE);
  if (!fs.existsSync(executable)) {
    throw new Error(`找不到 Python 后端：${executable}`);
  }
  return { executable, args: [], cwd: path.dirname(executable) };
}

function appendBackendLog(data) {
  const logsDirectory = app.getPath("logs");
  fs.mkdirSync(logsDirectory, { recursive: true });
  fs.appendFileSync(path.join(logsDirectory, "backend.log"), data);
}

async function startBackend() {
  const port = await findAvailablePort();
  const command = app.isPackaged ? packagedBackendCommand() : developmentBackendCommand();
  backendUrl = `http://127.0.0.1:${port}`;
  backendShutdownToken = crypto.randomBytes(32).toString("hex");
  backendProcess = spawn(
    command.executable,
    [
      ...command.args,
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--data-dir",
      dataDirectory,
    ],
    {
      cwd: command.cwd,
      env: {
        ...process.env,
        GENE_LEDGER_SHUTDOWN_TOKEN: backendShutdownToken,
      },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  backendProcess.stdout?.on("data", appendBackendLog);
  backendProcess.stderr?.on("data", appendBackendLog);
  backendProcess.once("exit", (code) => {
    backendProcess = null;
    if (!quitting) {
      dialog.showErrorBox("本机后端已停止", `Python 后端意外退出（代码 ${code ?? "未知"}）。`);
      app.quit();
    }
  });
  await waitForBackend();
}

function backendReady() {
  return new Promise((resolve) => {
    const request = http.get(`${backendUrl}/api/health`, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.setTimeout(500, () => request.destroy());
    request.once("error", () => resolve(false));
  });
}

async function waitForBackend() {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (backendProcess?.exitCode != null) break;
    if (await backendReady()) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("Python 后端启动超时，请查看后端日志。");
}

function assertTrustedIpcSender(event) {
  if (!mainWindow || event.sender.id !== mainWindow.webContents.id) {
    throw new Error("拒绝来自非主窗口的桌面调用");
  }
}

function assertQuickEntryIpcSender(event) {
  if (
    !quickEntryWindow ||
    quickEntryWindow.isDestroyed() ||
    event.sender.id !== quickEntryWindow.webContents.id
  ) {
    throw new Error("拒绝来自非快速录入窗口的桌面调用");
  }
}

function normalizeIdList(value) {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .filter((item) => typeof item === "string")
        .map((item) => item.trim())
        .filter((item) => item && item.length <= 160)
        .slice(0, 200),
    ),
  ];
}

function normalizeQuickEntryContext(payload) {
  return {
    projectId:
      typeof payload?.projectId === "string" ? payload.projectId.trim().slice(0, 160) : "",
    selectedFieldIds: normalizeIdList(payload?.selectedFieldIds),
    pinnedFieldIds: normalizeIdList(payload?.pinnedFieldIds),
  };
}

function rendererRoutePath(context) {
  const params = new URLSearchParams();
  if (context.projectId) params.set("project", context.projectId);
  if (context.selectedFieldIds.length) params.set("fields", context.selectedFieldIds.join(","));
  if (context.pinnedFieldIds.length) params.set("pinned", context.pinnedFieldIds.join(","));
  const query = params.toString();
  return `/quick-entry${query ? `?${query}` : ""}`;
}

function configureRendererNavigation(targetWindow) {
  targetWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const packagedEntryUrl = pathToFileURL(path.join(__dirname, "../dist/index.html")).href;
  const developmentUrl = process.env.VITE_DEV_SERVER_URL || "http://127.0.0.1:5173";
  const guardNavigation = (event, url) => {
    let allowed = false;
    try {
      allowed = app.isPackaged
        ? url === packagedEntryUrl || url.startsWith(`${packagedEntryUrl}#`)
        : new URL(url).origin === new URL(developmentUrl).origin;
    } catch {
      allowed = false;
    }
    if (!allowed) event.preventDefault();
  };
  targetWindow.webContents.on("will-navigate", guardNavigation);
  targetWindow.webContents.on("will-redirect", guardNavigation);
}

function loadRendererWindow(targetWindow, routePath = "") {
  if (app.isPackaged) {
    const options = routePath ? { hash: routePath } : undefined;
    return targetWindow.loadFile(path.join(__dirname, "../dist/index.html"), options);
  }
  const developmentUrl = (process.env.VITE_DEV_SERVER_URL || "http://127.0.0.1:5173").replace(
    /\/$/,
    "",
  );
  return targetWindow.loadURL(routePath ? `${developmentUrl}/#${routePath}` : developmentUrl);
}

function restoredQuickEntryBounds() {
  const saved = normalizeStoredBounds(quickEntryBounds);
  if (!saved) {
    return { width: QUICK_ENTRY_DEFAULT_WIDTH, height: QUICK_ENTRY_DEFAULT_HEIGHT };
  }
  const workArea = screen.getDisplayMatching(saved).workArea;
  const width = Math.min(
    workArea.width,
    Math.max(QUICK_ENTRY_MIN_WIDTH, saved.width),
  );
  const height = Math.min(
    workArea.height,
    Math.max(QUICK_ENTRY_MIN_HEIGHT, saved.height),
  );
  return {
    width,
    height,
    x: Math.min(Math.max(saved.x, workArea.x), workArea.x + workArea.width - width),
    y: Math.min(Math.max(saved.y, workArea.y), workArea.y + workArea.height - height),
  };
}

function persistQuickEntryBounds() {
  if (!quickEntryWindow || quickEntryWindow.isDestroyed()) return;
  quickEntryBounds = normalizeStoredBounds(quickEntryWindow.getNormalBounds());
  if (dataDirectory) writeDesktopSettings(dataDirectory, alwaysOnTop, quickEntryBounds);
}

function scheduleQuickEntryBoundsPersistence() {
  if (quickEntryBoundsTimer) clearTimeout(quickEntryBoundsTimer);
  quickEntryBoundsTimer = setTimeout(() => {
    quickEntryBoundsTimer = null;
    persistQuickEntryBounds();
  }, 400);
}

function createQuickEntryWindow(context) {
  const bounds = restoredQuickEntryBounds();
  quickEntryRendererReady = false;
  quickEntryPendingContext = null;
  quickEntryWindow = new BrowserWindow({
    title: "快速录入 · 基因检测台账",
    ...bounds,
    minWidth: QUICK_ENTRY_MIN_WIDTH,
    minHeight: QUICK_ENTRY_MIN_HEIGHT,
    resizable: true,
    alwaysOnTop: true,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#f7f8fa",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: [
        `--gene-ledger-backend-url=${backendUrl}`,
        `--gene-ledger-data-directory=${dataDirectory}`,
        "--gene-ledger-window-kind=quick-entry",
      ],
    },
  });
  quickEntryWindow.setAlwaysOnTop(true, "floating");
  registerWindowCloseProtection(quickEntryWindow);
  quickEntryWindow.webContents.on("before-input-event", (event, input) => {
    if ((input.control || input.meta) && String(input.key).toLowerCase() === "w") {
      event.preventDefault();
      quickEntryWindow?.close();
    }
  });
  configureRendererNavigation(quickEntryWindow);
  quickEntryWindow.webContents.on("did-start-navigation", (details) => {
    if (!details.isMainFrame || details.isSameDocument) return;
    pauseClipboardFollow("窗口正在重新加载，请重新确认本条");
    quickEntryRendererReady = false;
  });
  quickEntryWindow.webContents.on("render-process-gone", () => {
    quickEntryRendererReady = false;
    void clipboardFollower.close();
  });
  quickEntryWindow.on("hide", () => pauseClipboardFollow("窗口已隐藏，接收已暂停"));
  quickEntryWindow.on("minimize", () => pauseClipboardFollow("窗口已最小化，接收已暂停"));
  quickEntryWindow.once("ready-to-show", () => {
    if (!quickEntryWindow || quickEntryWindow.isDestroyed()) return;
    quickEntryWindow.setAlwaysOnTop(true, "floating");
    quickEntryWindow.show();
    quickEntryWindow.moveTop();
    quickEntryWindow.focus();
  });
  quickEntryWindow.on("move", scheduleQuickEntryBoundsPersistence);
  quickEntryWindow.on("resize", scheduleQuickEntryBoundsPersistence);
  quickEntryWindow.on("close", persistQuickEntryBounds);
  quickEntryWindow.on("closed", () => {
    void clipboardFollower.close();
    if (quickEntryBoundsTimer) clearTimeout(quickEntryBoundsTimer);
    quickEntryBoundsTimer = null;
    quickEntryRendererReady = false;
    quickEntryPendingContext = null;
    quickEntryWindow = null;
  });
  void loadRendererWindow(quickEntryWindow, rendererRoutePath(context));
}

function showQuickEntryWindow(payload) {
  const context = normalizeQuickEntryContext(payload);
  if (!quickEntryWindow || quickEntryWindow.isDestroyed()) {
    createQuickEntryWindow(context);
    return;
  }
  quickEntryPendingContext = context;
  if (quickEntryWindow.isMinimized()) quickEntryWindow.restore();
  quickEntryWindow.setAlwaysOnTop(true, "floating");
  quickEntryWindow.show();
  quickEntryWindow.moveTop();
  quickEntryWindow.focus();
  if (quickEntryRendererReady) {
    quickEntryWindow.webContents.send(
      "gene-ledger:quick-entry-open-requested",
      quickEntryPendingContext,
    );
    quickEntryPendingContext = null;
  }
}

function focusMainWindowFromQuickEntry() {
  if (quickEntryWindow && !quickEntryWindow.isDestroyed()) quickEntryWindow.hide();
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  return true;
}

function windowState() {
  return {
    isMaximized: Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isMaximized()),
    alwaysOnTop,
  };
}

function notifyWindowState() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("gene-ledger:window-state-changed", windowState());
  }
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    title: APP_TITLE,
    width: 1360,
    height: 820,
    minWidth: 1000,
    minHeight: 640,
    frame: false,
    thickFrame: true,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#f7f8fa",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: [
        `--gene-ledger-backend-url=${backendUrl}`,
        `--gene-ledger-data-directory=${dataDirectory}`,
        "--gene-ledger-window-kind=main",
      ],
    },
  });
  mainWindow.setAlwaysOnTop(alwaysOnTop);
  registerWindowCloseProtection(mainWindow, true);
  mainWindow.on("maximize", notifyWindowState);
  mainWindow.on("unmaximize", notifyWindowState);
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.webContents.on("before-input-event", (event, input) => {
    if (
      (input.control || input.meta) &&
      input.shift &&
      String(input.key).toLowerCase() === "t"
    ) {
      event.preventDefault();
      applyAlwaysOnTop(!alwaysOnTop);
      return;
    }
    if ((input.control || input.meta) && String(input.key).toLowerCase() === "w") {
      event.preventDefault();
      mainWindow.close();
    }
  });
  configureRendererNavigation(mainWindow);
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  void loadRendererWindow(mainWindow);
}

function normalizeExportData(data) {
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  throw new Error("导出数据格式无效");
}

function registerDesktopHandlers() {
  ipcMain.handle("gene-ledger:close-guard-ready", (event) => {
    closeIpcWindow(event);
    closeGuardReady.add(event.sender.id);
  });
  ipcMain.handle("gene-ledger:close-response", (event, response) => {
    closeIpcWindow(event);
    const request = pendingCloseRequests.get(response?.requestId);
    if (!request || request.senderId !== event.sender.id) return;
    if (typeof response.dirty !== "boolean" || typeof response.busy !== "boolean" || typeof response.saved !== "boolean") {
      throw new Error("关闭状态无效");
    }
    clearTimeout(request.timer);
    pendingCloseRequests.delete(response.requestId);
    request.resolve({ dirty: response.dirty, busy: response.busy, saved: response.saved });
  });
  ipcMain.handle("gene-ledger:clipboard-follow-start", (event, context) => {
    assertQuickEntryIpcSender(event);
    if (process.platform !== "win32") throw new Error("剪贴板跟随仅支持 Windows 桌面版");
    if (!quickEntryWindow.isVisible() || quickEntryWindow.isMinimized()) {
      throw new Error("请先显示快速录入窗口");
    }
    quickEntryRendererReady = true;
    return clipboardFollower.start(context);
  });
  ipcMain.handle("gene-ledger:clipboard-follow-stop", (event, sessionId) => {
    assertQuickEntryIpcSender(event);
    return clipboardFollower.stop(sessionId);
  });
  ipcMain.handle("gene-ledger:clipboard-follow-accept", (event, sessionId) => {
    assertQuickEntryIpcSender(event);
    return clipboardFollower.accept(sessionId);
  });
  ipcMain.handle("gene-ledger:clipboard-write-internal", (event, text) => {
    assertQuickEntryIpcSender(event);
    if (process.platform !== "win32") throw new Error("此剪贴板服务仅支持 Windows");
    return clipboardFollower.writeInternal(text);
  });
  ipcMain.handle("gene-ledger:save-workbook", async (event, payload) => {
    assertTrustedIpcSender(event);
    const requestedName = path.basename(String(payload?.filename || "台账.xlsx"));
    const filename = requestedName.toLowerCase().endsWith(".xlsx")
      ? requestedName
      : `${requestedName}.xlsx`;
    const data = normalizeExportData(payload?.data);
    if (!data.length || data.length > MAX_EXPORT_BYTES) throw new Error("导出文件大小无效");
    const result = await dialog.showSaveDialog(mainWindow ?? undefined, {
      title: "另存为 Excel",
      defaultPath: path.join(app.getPath("downloads"), filename),
      buttonLabel: "保存",
      filters: [{ name: "Excel 工作簿", extensions: ["xlsx"] }],
      properties: ["createDirectory", "showOverwriteConfirmation"],
    });
    if (result.canceled || !result.filePath) return { saved: false, path: "" };
    await fsp.writeFile(result.filePath, data, { flag: "w" });
    return { saved: true, path: result.filePath };
  });

  ipcMain.handle("gene-ledger:choose-directory", async (event, initialDirectory) => {
    assertTrustedIpcSender(event);
    const selected = await showDirectoryPicker(
      typeof initialDirectory === "string" ? initialDirectory : "",
      "选择文件夹",
    );
    return { selected: Boolean(selected), directory: selected || "" };
  });

  ipcMain.handle("gene-ledger:change-data-directory", async (event) => {
    assertTrustedIpcSender(event);
    const selected = await showDirectoryPicker(dataDirectory, "选择新的业务数据目录");
    if (!selected || selected === dataDirectory) {
      return { changed: false, directory: dataDirectory };
    }
    fs.mkdirSync(selected, { recursive: true });
    const saved = writeDesktopSettings(selected, alwaysOnTop);
    dataDirectory = saved;
    return { changed: true, directory: saved };
  });

  ipcMain.handle("gene-ledger:choose-backup-file", async (event, initialDirectory) => {
    assertTrustedIpcSender(event);
    const defaultPath =
      typeof initialDirectory === "string" && fs.existsSync(initialDirectory)
        ? initialDirectory
        : app.getPath("documents");
    const result = await dialog.showOpenDialog(mainWindow ?? undefined, {
      title: "选择完整业务备份包",
      defaultPath,
      buttonLabel: "选择并恢复",
      properties: ["openFile"],
      filters: [
        { name: "基因检测台账完整备份", extensions: ["glbkp"] },
        { name: "所有文件", extensions: ["*"] },
      ],
    });
    return {
      selected: !result.canceled && result.filePaths.length > 0,
      path: result.canceled ? "" : path.resolve(result.filePaths[0] || ""),
    };
  });

  ipcMain.handle("gene-ledger:get-always-on-top", (event) => {
    assertTrustedIpcSender(event);
    return mainWindow?.isAlwaysOnTop?.() ?? alwaysOnTop;
  });

  ipcMain.handle("gene-ledger:set-always-on-top", (event, value) => {
    assertTrustedIpcSender(event);
    return applyAlwaysOnTop(value);
  });

  ipcMain.handle("gene-ledger:get-window-state", (event) => {
    assertTrustedIpcSender(event);
    return windowState();
  });

  ipcMain.handle("gene-ledger:open-quick-entry", (event, payload) => {
    assertTrustedIpcSender(event);
    if (closeCoordinator.pending || quitting) throw new Error("请先完成当前关闭操作");
    showQuickEntryWindow(payload);
  });

  ipcMain.handle("gene-ledger:focus-main-window", (event) => {
    assertQuickEntryIpcSender(event);
    return focusMainWindowFromQuickEntry();
  });

  ipcMain.handle("gene-ledger:quick-entry-ready", (event) => {
    assertQuickEntryIpcSender(event);
    quickEntryRendererReady = true;
    if (quickEntryPendingContext && quickEntryWindow && !quickEntryWindow.isDestroyed()) {
      quickEntryWindow.webContents.send(
        "gene-ledger:quick-entry-open-requested",
        quickEntryPendingContext,
      );
      quickEntryPendingContext = null;
    }
  });

  ipcMain.handle("gene-ledger:quick-entry-changed", (event, payload) => {
    assertQuickEntryIpcSender(event);
    const projectId =
      typeof payload?.projectId === "string" ? payload.projectId.trim().slice(0, 160) : "";
    const recordId =
      typeof payload?.recordId === "string" ? payload.recordId.trim().slice(0, 160) : "";
    const action = payload?.action === "update" ? "update" : "create";
    if (!projectId || !recordId) throw new Error("快速录入变更通知无效");
    const revision = ++quickEntryChangeRevision;
    pendingQuickEntryProjectChanges.set(projectId, revision);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("gene-ledger:quick-entry-changed", {
        projectId,
        recordId,
        action,
        revision,
      });
    }
  });

  ipcMain.handle("gene-ledger:get-pending-quick-entry-changes", (event) => {
    assertTrustedIpcSender(event);
    return [...pendingQuickEntryProjectChanges.entries()].map(([projectId, revision]) => ({
      projectId,
      revision,
    }));
  });

  ipcMain.handle("gene-ledger:acknowledge-quick-entry-changes", (event, changes) => {
    assertTrustedIpcSender(event);
    if (!Array.isArray(changes)) return;
    changes.forEach((change) => {
      const projectId =
        typeof change?.projectId === "string" ? change.projectId.trim().slice(0, 160) : "";
      const revision = Number(change?.revision);
      if (!projectId || !Number.isSafeInteger(revision) || revision <= 0) return;
      const pendingRevision = pendingQuickEntryProjectChanges.get(projectId);
      if (pendingRevision !== undefined && pendingRevision <= revision) {
        pendingQuickEntryProjectChanges.delete(projectId);
      }
    });
  });

  ipcMain.handle("gene-ledger:quick-entry-fields-changed", (event, payload) => {
    assertTrustedIpcSender(event);
    const projectId =
      typeof payload?.projectId === "string" ? payload.projectId.trim().slice(0, 160) : "";
    if (!projectId) throw new Error("快速录入表头变更通知无效");
    if (
      quickEntryRendererReady &&
      quickEntryWindow &&
      !quickEntryWindow.isDestroyed()
    ) {
      quickEntryWindow.webContents.send("gene-ledger:quick-entry-fields-changed", { projectId });
    }
  });

  ipcMain.handle("gene-ledger:minimize-window", (event) => {
    assertTrustedIpcSender(event);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
  });

  ipcMain.handle("gene-ledger:toggle-window-maximize", (event) => {
    assertTrustedIpcSender(event);
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
    notifyWindowState();
    return mainWindow.isMaximized();
  });

  ipcMain.handle("gene-ledger:close-window", (event) => {
    assertTrustedIpcSender(event);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
  });

  ipcMain.handle("gene-ledger:restart", (event) => {
    assertTrustedIpcSender(event);
    return requestApplicationClose(true);
  });
}

function requestBackendShutdown(url, token) {
  if (!url || !token) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (accepted) => {
      if (settled) return;
      settled = true;
      resolve(accepted);
    };
    const request = http.request(
      `${url}/api/desktop/shutdown`,
      {
        method: "POST",
        headers: { "x-gene-ledger-shutdown-token": token },
      },
      (response) => {
        response.resume();
        finish(response.statusCode === 202);
      },
    );
    request.setTimeout(1500, () => {
      finish(false);
      request.destroy();
    });
    request.once("error", () => finish(false));
    request.end();
  });
}

function waitForProcessExit(processToStop, timeoutMilliseconds) {
  if (processToStop.exitCode != null || processToStop.signalCode != null) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      processToStop.removeListener("exit", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMilliseconds);
    processToStop.once("exit", onExit);
  });
}

function forceStopBackend(processToStop) {
  if (process.platform === "win32" && processToStop.pid) {
    return new Promise((resolve) => {
      execFile(
        "taskkill",
        ["/PID", String(processToStop.pid), "/T", "/F"],
        { windowsHide: true },
        () => resolve(),
      );
    });
  }
  try {
    processToStop.kill("SIGKILL");
  } catch {
    // The process may already have exited.
  }
  return Promise.resolve();
}

async function stopBackend() {
  const processToStop = backendProcess;
  const shutdownUrl = backendUrl;
  const shutdownToken = backendShutdownToken;
  backendProcess = null;
  backendUrl = "";
  backendShutdownToken = "";
  if (!processToStop) return;

  processToStop.removeAllListeners("exit");
  if (processToStop.exitCode != null || processToStop.signalCode != null) return;

  const accepted = await requestBackendShutdown(shutdownUrl, shutdownToken);
  if (!accepted && process.platform !== "win32") {
    try {
      processToStop.kill("SIGTERM");
    } catch {
      return;
    }
  }
  const exited = await waitForProcessExit(processToStop, accepted ? 300000 : 1500);
  if (exited) return;
  await forceStopBackend(processToStop);
  await waitForProcessExit(processToStop, 2000);
}

function applyAlwaysOnTop(value) {
  alwaysOnTop = Boolean(value);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setAlwaysOnTop(alwaysOnTop);
  }
  if (dataDirectory) {
    writeDesktopSettings(dataDirectory, alwaysOnTop);
  }
  notifyWindowState();
  return alwaysOnTop;
}

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow?.isMinimized()) mainWindow.restore();
    mainWindow?.show();
    mainWindow?.focus();
  });

  app.whenReady().then(async () => {
    try {
      Menu.setApplicationMenu(null);
      app.setAppLogsPath();
      dataDirectory = await ensureDataDirectory();
      if (!dataDirectory) {
        app.quit();
        return;
      }
      const desktopSettings = readDesktopSettings();
      alwaysOnTop = desktopSettings.alwaysOnTop;
      quickEntryBounds = desktopSettings.quickEntryBounds;
      registerDesktopHandlers();
      await startBackend();
      createMainWindow();
    } catch (error) {
      dialog.showErrorBox("基因检测台账启动失败", error instanceof Error ? error.message : String(error));
      app.quit();
    }
  });
}

app.on("before-quit", (event) => {
  event.preventDefault();
  if (!quitting) void requestApplicationClose();
});

app.on("window-all-closed", () => {
  app.quit();
});
