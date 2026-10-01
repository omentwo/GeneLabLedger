const { test } = require("node:test");
const assert = require("node:assert/strict");
const { WindowCloseCoordinator } = require("../window-close.cjs");

function fixture({ busy = false, choices = ["save", "save"], saveFails = false, inspectFails = false } = {}) {
  const windows = [{ id: 1 }, { id: 2, hidden: true }];
  const locked = new Set(), released = [], saved = [], messages = [], committed = [];
  const coordinator = new WindowCloseCoordinator({
    inspect: async (window) => {
      locked.add(window.id);
      if (inspectFails && window.id === 2) throw new Error("renderer unavailable");
      return { dirty: true, busy };
    },
    save: async (window) => { saved.push(window.id); return { saved: !saveFails, dirty: saveFails, busy: false }; },
    release: (window) => { locked.delete(window.id); released.push(window.id); },
    confirm: async () => { assert.equal(locked.size, 2); return choices.shift(); },
    blocked: async (message) => messages.push(message),
  });
  const commit = async (targets) => committed.push(targets.map((window) => window.id));
  return { windows, coordinator, commit, locked, released, saved, messages, committed };
}

test("checks and saves both main and hidden quick-entry drafts before any shutdown", async () => {
  const f = fixture();
  assert.equal(await f.coordinator.request(f.windows, f.commit), true);
  assert.deepEqual(f.saved, [1, 2]);
  assert.deepEqual(f.committed, [[1, 2]]);
  assert.deepEqual(f.released, []);
});

test("cancel in the second window keeps both windows and releases both locks", async () => {
  const f = fixture({ choices: ["save", "cancel"] });
  assert.equal(await f.coordinator.request(f.windows, f.commit), false);
  assert.deepEqual(f.saved, [1]);
  assert.deepEqual(f.committed, []);
  assert.equal(f.locked.size, 0);
  assert.deepEqual(f.released, [1, 2]);
});

test("in-flight saves and failed saves never shut down the backend", async () => {
  for (const options of [{ busy: true }, { saveFails: true }, { inspectFails: true }]) {
    const f = fixture(options);
    assert.equal(await f.coordinator.request(f.windows, f.commit), false);
    assert.deepEqual(f.committed, []);
    assert.equal(f.locked.size, 0);
    assert.equal(f.messages.length, 1);
  }
});

test("explicit discard closes without saving and repeated shortcuts share one request", async () => {
  const f = fixture({ choices: ["discard", "discard"] });
  const first = f.coordinator.request(f.windows, f.commit);
  assert.equal(f.coordinator.request(f.windows, f.commit), first);
  assert.equal(await first, true);
  assert.deepEqual(f.saved, []);
  assert.equal(f.committed.length, 1);
});

test("a different window close cannot inherit another request's approval", async () => {
  const f = fixture({ choices: ["cancel"] });
  const pending = f.coordinator.request(f.windows, f.commit);
  assert.equal(await f.coordinator.request([f.windows[1]], f.commit), false);
  await pending;
  assert.deepEqual(f.committed, []);
});

test("waits for delayed inspection before releasing after another renderer fails", async () => {
  const f = fixture({ inspectFails: true });
  const original = f.coordinator.inspect;
  f.coordinator.inspect = async (window) => {
    if (window.id === 1) await new Promise((resolve) => setTimeout(resolve, 5));
    return original(window);
  };
  await f.coordinator.request(f.windows, f.commit);
  assert.equal(f.locked.size, 0);
});
