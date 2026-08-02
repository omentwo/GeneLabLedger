const { app, BrowserWindow, Menu, dialog, ipcMain } = require("electron");
const { execFile, spawn } = require("node:child_process");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const APP_TITLE = "基因检测台账";
const CONFIG_FILENAME = "desktop-settings.json";
const BACKEND_EXECUTABLE = "GeneLabLedgerBackend.exe";
const MAX_EXPORT_BYTES = 256 * 1024 * 1024;

let mainWindow = null;
let backendProcess = null;
let backendUrl = "";
let dataDirectory = "";
let quitting = false;

function settingsDirectory() {
  return path.join(app.getPath("userData"), "settings");
}

function settingsPath() {
  return path.join(settingsDirectory(), CONFIG_FILENAME);
}

function readDesktopSettings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
    if (typeof parsed.dataDirectory === "string" && path.isAbsolute(parsed.dataDirectory)) {
      return { dataDirectory: path.resolve(parsed.dataDirectory) };
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.error("桌面设置读取失败", error);
    }
  }
  return { dataDirectory: "" };
}

function writeDesktopSettings(nextDirectory) {
  const directory = path.resolve(nextDirectory);
  fs.mkdirSync(settingsDirectory(), { recursive: true });
  const temporaryPath = `${settingsPath()}.tmp`;
  fs.writeFileSync(
    temporaryPath,
    `${JSON.stringify({ dataDirectory: directory }, null, 2)}\n`,
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

function createMainWindow() {
  mainWindow = new BrowserWindow({
    title: APP_TITLE,
    width: 1360,
    height: 820,
    minWidth: 1000,
    minHeight: 640,
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
      ],
    },
  });
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.webContents.on("before-input-event", (event, input) => {
    if ((input.control || input.meta) && String(input.key).toLowerCase() === "w") {
      event.preventDefault();
      app.quit();
    }
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
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
  mainWindow.webContents.on("will-navigate", guardNavigation);
  mainWindow.webContents.on("will-redirect", guardNavigation);
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  if (app.isPackaged) {
    void mainWindow.loadFile(path.join(__dirname, "../dist/index.html"));
  } else {
    void mainWindow.loadURL(developmentUrl);
  }
}

function normalizeExportData(data) {
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  throw new Error("导出数据格式无效");
}

function registerDesktopHandlers() {
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
      "选择自动导出目录",
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
    const saved = writeDesktopSettings(selected);
    return { changed: true, directory: saved };
  });

  ipcMain.handle("gene-ledger:restart", (event) => {
    assertTrustedIpcSender(event);
    app.relaunch();
    app.exit(0);
  });
}

function stopBackend() {
  const processToStop = backendProcess;
  backendProcess = null;
  if (!processToStop) return Promise.resolve();

  processToStop.removeAllListeners("exit");
  return new Promise((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      resolve();
    };
    processToStop.once("exit", finish);

    if (processToStop.exitCode != null || processToStop.signalCode != null) {
      finish();
      return;
    }

    if (process.platform === "win32" && processToStop.pid) {
      execFile(
        "taskkill",
        ["/PID", String(processToStop.pid), "/T", "/F"],
        { windowsHide: true },
        (error) => {
          if (error) {
            try {
              processToStop.kill();
            } catch {
              // The process may already have exited between taskkill and fallback.
            }
          }
          if (processToStop.exitCode != null || processToStop.signalCode != null) finish();
        },
      );
    } else {
      try {
        processToStop.kill("SIGTERM");
      } catch {
        finish();
      }
    }

    setTimeout(finish, 5000);
  });
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
  if (quitting) {
    event.preventDefault();
    return;
  }
  event.preventDefault();
  quitting = true;
  void stopBackend().finally(() => app.exit(0));
});

app.on("window-all-closed", () => {
  app.quit();
});
