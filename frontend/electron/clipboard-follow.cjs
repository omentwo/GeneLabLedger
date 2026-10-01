const { spawn } = require("node:child_process");
const readline = require("node:readline");

const MAX_TEXT_LENGTH = 32768;

function normalizeClipboardContext(payload) {
  const context = {};
  for (const key of ["sessionId", "projectId", "recordId"]) {
    const value = payload?.[key];
    if (typeof value !== "string" || !value.trim() || value.length > 160) {
      throw new Error("剪贴板接收会话无效");
    }
    context[key] = value.trim();
  }
  return context;
}

class ClipboardFollower {
  constructor({ command, onEvent, spawnProcess = spawn, timeout = 5000 }) {
    this.command = command;
    this.onEvent = onEvent;
    this.spawnProcess = spawnProcess;
    this.timeout = timeout;
    this.process = null;
    this.session = null;
    this.ready = false;
    this.starting = null;
    this.pending = new Map();
    this.requestId = 0;
  }

  ensureProcess() {
    if (this.process && this.ready) return Promise.resolve(this.process);
    if (this.starting) return this.starting;
    const command = this.command();
    const child = this.spawnProcess(command.executable, [...command.args, "--clipboard-listener"], {
      cwd: command.cwd,
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"],
    });
    this.process = child;
    this.ready = false;
    this.starting = new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.failProcess(child, "剪贴板监听启动超时"), this.timeout);
      timer.unref?.();
      const lines = readline.createInterface({ input: child.stdout });
      this.startup = { child, resolve, reject, timer, lines };
      lines.on("line", (line) => {
        if (this.process !== child) return;
        if (line.length > 262144) {
          this.failProcess(child, "剪贴板内容过长，监听已停止");
          return;
        }
        let payload;
        try { payload = JSON.parse(line); } catch { return; }
        if (payload?.type === "ready") {
          clearTimeout(timer);
          this.ready = true;
          resolve(child);
          return;
        }
        if (payload?.type === "fatal") {
          this.failProcess(child, "剪贴板监听已停止，请重新开启");
          return;
        }
        if (payload?.type === "reply") {
          const pending = this.pending.get(payload.requestId);
          if (!pending || pending.child !== child) return;
          this.pending.delete(payload.requestId);
          clearTimeout(pending.timer);
          if (payload.error) pending.reject(new Error("剪贴板操作失败，请重试"));
          else pending.resolve(payload.result ?? {});
          return;
        }
        const context = this.session;
        if (!context || Object.keys(context).some((key) => payload?.[key] !== context[key])) return;
        if (payload.type === "clipboard") {
          if (
            typeof payload.text !== "string" || payload.text.length > MAX_TEXT_LENGTH ||
            !Number.isSafeInteger(payload.eventId) || payload.eventId <= 0 ||
            !Number.isSafeInteger(payload.sequence) || payload.sequence < 0
          ) return;
          this.onEvent({ ...context, type: "clipboard", text: payload.text,
            eventId: payload.eventId, sequence: payload.sequence, manual: payload.manual === true });
        } else if (payload.type === "error") {
          this.onEvent({ ...context, type: "stopped", reason: "剪贴板读取失败，已暂停；请继续后重新复制" });
          void this.stop(context.sessionId);
        }
      });
      child.once("error", () => this.failProcess(child, "剪贴板监听无法启动"));
      child.once("exit", () => this.failProcess(child, "剪贴板监听已停止，请重新开启"));
      child.stdin.on("error", () => this.failProcess(child, "剪贴板通信已停止"));
      child.stdout.on("error", () => this.failProcess(child, "剪贴板通信已停止"));
    });
    return this.starting;
  }

  failProcess(child, message) {
    if (this.process !== child) return;
    this.process = null;
    this.ready = false;
    this.starting = null;
    const context = this.session;
    this.session = null;
    const startup = this.startup;
    this.startup = null;
    if (startup?.child === child) {
      clearTimeout(startup.timer);
      startup.lines.close();
      startup.reject(new Error(message));
    }
    for (const [id, pending] of this.pending) {
      if (pending.child !== child) continue;
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
      this.pending.delete(id);
    }
    if (context) this.onEvent({ ...context, type: "stopped", reason: message });
    child.stdin?.end();
    if (child.exitCode == null && child.signalCode == null) {
      try { child.kill(); } catch { /* Only this helper is owned by the controller. */ }
    }
  }

  send(child, action, payload = {}) {
    return new Promise((resolve, reject) => {
      if (child !== this.process || !this.ready) {
        reject(new Error("剪贴板监听尚未就绪"));
        return;
      }
      const requestId = ++this.requestId;
      const timer = setTimeout(() => this.failProcess(child, "剪贴板操作超时，已暂停"), this.timeout);
      timer.unref?.();
      this.pending.set(requestId, { child, resolve, reject, timer });
      child.stdin.write(JSON.stringify({ action, ...payload, requestId }) + "\n", (error) => {
        if (error) this.failProcess(child, "剪贴板通信已停止");
      });
    });
  }

  async start(payload) {
    const context = normalizeClipboardContext(payload);
    this.session = context;
    try {
      const child = await this.ensureProcess();
      if (this.session !== context) throw new Error("剪贴板接收会话已变化");
      const result = await this.send(child, "start", context);
      if (this.session !== context) throw new Error("剪贴板接收会话已变化");
      return result;
    } catch (error) {
      if (this.session === context) this.session = null;
      throw error;
    }
  }

  async stop(sessionId, reason) {
    const context = this.session;
    if (!context || context.sessionId !== sessionId) return;
    this.session = null;
    if (reason) this.onEvent({ ...context, type: "stopped", reason });
    try {
      const child = this.process;
      if (!child) return;
      if (!this.ready) await this.starting;
      if (child === this.process && this.ready) await this.send(child, "stop", { sessionId });
    } catch { /* An exited helper cannot continue listening. */ }
  }

  async accept(sessionId) {
    if (!this.session || this.session.sessionId !== sessionId) throw new Error("剪贴板接收会话已结束");
    const child = await this.ensureProcess();
    if (this.session?.sessionId !== sessionId) throw new Error("剪贴板接收会话已变化");
    return this.send(child, "accept", { sessionId });
  }

  async writeInternal(text) {
    if (typeof text !== "string" || text.length > MAX_TEXT_LENGTH) throw new Error("剪贴板写入内容无效");
    const child = await this.ensureProcess();
    await this.send(child, "write-internal", { text });
  }

  close() {
    const child = this.process;
    if (!child) return Promise.resolve();
    this.session = null;
    this.failProcess(child, "剪贴板监听已关闭");
    return Promise.resolve();
  }
}

module.exports = { ClipboardFollower, normalizeClipboardContext };
