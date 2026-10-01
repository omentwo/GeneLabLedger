// Inspect every participating window before closing any of them. Renderers stay
// locked until the whole request succeeds, or are released together on cancel.
class WindowCloseCoordinator {
  constructor({ inspect, save, release, confirm, blocked }) {
    Object.assign(this, { inspect, save, release, confirm, blocked });
    this.pending = null;
    this.pendingKey = "";
  }

  request(windows, commit) {
    const key = windows.map((window) => window.id).sort().join(":");
    if (this.pending) return this.pendingKey === key ? this.pending : Promise.resolve(false);
    this.pendingKey = key;
    this.pending = this.run(windows, commit).finally(() => {
      this.pending = null;
      this.pendingKey = "";
    });
    return this.pending;
  }

  async run(windows, commit) {
    let committed = false;
    try {
      // allSettled ensures a delayed inspection cannot re-lock a window after
      // another window failed and cancellation released its lock.
      const results = await Promise.allSettled(windows.map((window) => this.inspect(window)));
      const failure = results.find((result) => result.status === "rejected");
      if (failure) throw failure.reason;
      const states = results.map((result) => result.value);
      if (states.some((state) => state.busy)) {
        await this.blocked("正在保存或处理台账，请等待操作完成后再关闭。");
        return false;
      }
      for (let index = 0; index < windows.length; index += 1) {
        if (!states[index].dirty) continue;
        const choice = await this.confirm(windows[index]);
        if (choice === "cancel") return false;
        if (choice === "save") {
          const result = await this.save(windows[index]);
          if (!result.saved || result.dirty || result.busy) {
            await this.blocked("修改尚未全部保存，窗口已保留。请检查校验提示或保存错误后重试。");
            return false;
          }
        } else if (choice !== "discard") {
          return false;
        }
      }
      await commit(windows);
      committed = true;
      return true;
    } catch (error) {
      await this.blocked(error instanceof Error ? error.message : "无法确认草稿状态，窗口已保留。");
      return false;
    } finally {
      if (!committed) windows.forEach((window) => this.release(window));
    }
  }
}

module.exports = { WindowCloseCoordinator };
