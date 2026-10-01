const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough, Writable } = require("node:stream");
const { ClipboardFollower } = require("../clipboard-follow.cjs");

const context = { sessionId: "s1", projectId: "p1", recordId: "r1" };
function fixture({ autoReady = true } = {}) {
  const events = [], commands = [], children = [];
  const spawnProcess = (_executable, args, options) => {
    assert.equal(args.at(-1), "--clipboard-listener");
    assert.equal(options.windowsHide, true);
    assert.deepEqual(options.stdio, ["pipe", "pipe", "ignore"]);
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.exitCode = null;
    child.signalCode = null;
    child.emitPayload = (value) => child.stdout.write(JSON.stringify(value) + "\n");
    child.stdin = new Writable({ write(chunk, _encoding, callback) {
      const command = JSON.parse(chunk.toString());
      commands.push(command);
      queueMicrotask(() => child.emitPayload({ type: "reply", requestId: command.requestId, result: { sequence: 20 } }));
      callback();
    }});
    child.kill = () => { child.exitCode = 0; child.emit("exit", 0); };
    children.push(child);
    if (autoReady) queueMicrotask(() => child.emitPayload({ type: "ready" }));
    return child;
  };
  const follower = new ClipboardFollower({ command: () => ({ executable: "python", args: ["launcher.py"], cwd: "test" }),
    onEvent: (event) => events.push(event), spawnProcess });
  const emit = (payload) => children.at(-1).emitPayload(payload);
  return { follower, events, commands, children, emit };
}

test("only current project/record/session updates are forwarded", async () => {
  const f = fixture();
  try {
    await f.follower.start(context);
    const value = { ...context, type: "clipboard", text: "患者姓名", sequence: 21, eventId: 1 };
    f.emit({ ...value, sessionId: "old" });
    f.emit({ ...value, projectId: "other" });
    f.emit({ ...value, recordId: "other" });
    f.emit(value);
    assert.equal(f.events.length, 1);
    assert.equal(f.events[0].text, "患者姓名");
    await f.follower.stop(context.sessionId);
    f.emit(value);
    assert.equal(f.events.length, 1);
  } finally { await f.follower.close(); }
});

test("a stale stop does not cancel the next record", async () => {
  const f = fixture();
  try {
    await f.follower.start(context);
    const next = { ...context, sessionId: "s2", recordId: "r2" };
    await f.follower.start(next);
    await f.follower.stop("s1");
    assert.deepEqual(f.follower.session, next);
    assert.equal(f.commands.filter((command) => command.action === "stop").length, 0);
  } finally { await f.follower.close(); }
});

test("internal writes do not arm a recording session", async () => {
  const f = fixture();
  try {
    await f.follower.writeInternal("下一条病理号");
    assert.equal(f.follower.session, null);
    assert.equal(f.commands[0].action, "write-internal");
    assert.equal(f.commands[0].text, "下一条病理号");
  } finally { await f.follower.close(); }
});

test("manual paste is restricted to the active session", async () => {
  const f = fixture();
  try {
    await f.follower.start(context);
    await assert.rejects(f.follower.accept("old"), /已结束/);
    await f.follower.accept("s1");
    assert.equal(f.commands.at(-1).action, "accept");
    assert.equal(f.commands.at(-1).sessionId, "s1");
  } finally { await f.follower.close(); }
});

test("pause during startup prevents the old start from reaching the helper", async () => {
  const f = fixture({ autoReady: false });
  const start = assert.rejects(f.follower.start(context), /已变化/);
  const stop = f.follower.stop("s1");
  f.emit({ type: "ready" });
  await Promise.all([start, stop]);
  assert.equal(f.commands.filter((command) => command.action === "start").length, 0);
  await f.follower.close();
});

test("helper exit pauses the active session and can be restarted", async () => {
  const f = fixture();
  try {
    await f.follower.start(context);
    f.children[0].kill();
    assert.equal(f.follower.session, null);
    assert.equal(f.events[0].type, "stopped");
    await f.follower.start({ ...context, sessionId: "s2" });
    assert.equal(f.children.length, 2);
  } finally { await f.follower.close(); }
});

test("oversized and malformed messages are ignored", async () => {
  const f = fixture();
  try {
    await f.follower.start(context);
    f.children[0].stdout.write("not JSON\n");
    f.emit({ ...context, type: "clipboard", sequence: 21, eventId: 1, text: "x".repeat(32769) });
    f.emit({ ...context, type: "clipboard", sequence: 21, eventId: -1, text: "值" });
    assert.deepEqual(f.events, []);
    await assert.rejects(f.follower.writeInternal("x".repeat(32769)), /无效/);
  } finally { await f.follower.close(); }
});

test("read failures stop further forwarding", async () => {
  const f = fixture();
  try {
    await f.follower.start(context);
    f.emit({ ...context, type: "error", message: "failed" });
    f.emit({ ...context, type: "clipboard", sequence: 22, eventId: 2, text: "迟到内容" });
    assert.equal(f.events.length, 1);
    assert.equal(f.events[0].type, "stopped");
    assert.equal(f.follower.session, null);
  } finally { await f.follower.close(); }
});
