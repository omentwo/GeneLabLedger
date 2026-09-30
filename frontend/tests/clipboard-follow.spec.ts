import { describe, expect, it } from "vitest";
import type { FieldDefinition } from "@/types/api";
import type { ClipboardFollowContext, ClipboardFollowEvent } from "@/types/electron";
import { ClipboardFollowSession, normalizeClipboardEntryValue } from "@/utils/clipboardFollow";

function field(id: string, extra: Partial<FieldDefinition> = {}): FieldDefinition {
  return { id, project_id: "p", key: id, label: id, data_type: "text", system_key: null,
    is_core: false, hidden: false, sort_order: 0, width: 120, options: [], ...extra };
}
const fields = [field("name"), field("unit"), field("date", { data_type: "date" }),
  field("age", { data_type: "number" }), field("sex", { data_type: "select", options: [
    { id: "o", value: "男", sort_order: 0 },
  ] }), field("hidden", { hidden: true }), field("path", { system_key: "pathology_number" })];
const context: ClipboardFollowContext = { sessionId: "s", projectId: "p", recordId: "r" };
function event(text: string, eventId = 1, extra: Partial<ClipboardFollowContext> = {}): Extract<ClipboardFollowEvent, { type: "clipboard" }> {
  return { ...context, ...extra, type: "clipboard", text, eventId, sequence: eventId + 10, manual: false };
}
function apply(session: ClipboardFollowSession, text: string, values: Record<string, string>, id = 1, overwrite = false) {
  const result = session.receive(event(text, id), fields, values, overwrite);
  if (result.kind === "filled") values[result.field.id] = result.value;
  return result;
}

describe("clipboard follow record sessions", () => {
  it("fills in configured order, permits repeated text and stops at the last field", () => {
    const session = new ClipboardFollowSession();
    const values: Record<string, string> = {};
    session.start(context, ["unit", "name"]);
    apply(session, "同一个值", values);
    apply(session, "同一个值", values, 2);
    expect(values).toEqual({ unit: "同一个值", name: "同一个值" });
    expect(session.status).toBe("complete");
    expect(apply(session, "额外内容", values, 3).kind).toBe("ignored");
  });

  it.each(["sessionId", "projectId", "recordId"] as const)("rejects updates for a different %s", (key) => {
    const session = new ClipboardFollowSession();
    session.start(context, ["name"]);
    expect(session.receive(event("无关内容", 1, { [key]: "other" }), fields, {}, false).kind).toBe("ignored");
    expect(session.index).toBe(0);
  });

  it("ignores duplicate events and empty contents without advancing", () => {
    const session = new ClipboardFollowSession();
    session.start(context, ["name", "unit"]);
    expect(apply(session, " \n", {}, 1).kind).toBe("ignored");
    const values = {};
    apply(session, "姓名", values, 2);
    expect(apply(session, "重复通知", values, 2).kind).toBe("ignored");
    expect(session.nextFieldId).toBe("unit");
  });

  it("pause/resume retains progress and discards late events from before the pause", () => {
    const session = new ClipboardFollowSession();
    const values = {};
    session.start(context, ["name", "unit"]);
    apply(session, "姓名", values);
    session.pause();
    expect(apply(session, "暂停期间", values, 2).kind).toBe("ignored");
    session.start({ ...context, sessionId: "s2" }, ["name", "unit"], true);
    expect(session.nextFieldId).toBe("unit");
    expect(apply(session, "迟到内容", values, 3).kind).toBe("ignored");
    expect(session.receive(event("新单位", 1, { sessionId: "s2" }), fields, values, false).kind).toBe("filled");
  });

  it("protects nonempty values until an explicit overwrite and can undo the overwrite", () => {
    const session = new ClipboardFollowSession();
    const values = { name: "原姓名" };
    session.start(context, ["name", "unit"]);
    expect(apply(session, "新姓名", values).kind).toBe("blocked");
    expect(values.name).toBe("原姓名");
    expect(session.status).toBe("paused");
    const result = session.overwritePending(fields, values);
    if (result.kind === "filled") values.name = result.value;
    expect(session.nextFieldId).toBe("unit");
    expect(session.undo(values)).toEqual({ fieldId: "name", value: "原姓名" });
    expect(session.nextFieldId).toBe("name");
  });

  it("undo never destroys text manually edited after an automatic fill", () => {
    const session = new ClipboardFollowSession();
    const values = { name: "" };
    session.start(context, ["name"]);
    apply(session, "自动值", values);
    values.name = "手动值";
    expect(session.undo(values)).toBeNull();
    expect(values.name).toBe("手动值");
    expect(session.message).toContain("手动修改");
  });

  it("skip and undo skip preserve the original field contents", () => {
    const session = new ClipboardFollowSession();
    session.start(context, ["name", "unit"]);
    session.skip();
    expect(session.nextFieldId).toBe("unit");
    expect(session.undo({ name: "原姓名" })).toBeNull();
    expect(session.nextFieldId).toBe("name");
    expect(session.status).toBe("paused");
  });

  it.each([["date", "2026-02-30"], ["age", "不是数字"], ["sex", "未知"], ["hidden", "文字"], ["path", "P1"]])(
    "invalid or unavailable %s pauses at the same field", (id, text) => {
      const session = new ClipboardFollowSession();
      session.start(context, [id, "unit"]);
      expect(apply(session, text, {}).kind).toBe("blocked");
      expect(session.status).toBe("paused");
      expect(session.index).toBe(0);
      expect(apply(session, "下一个复制", {}, 2).kind).toBe("ignored");
    },
  );

  it("normalizes dates and accepts finite signed decimal numbers", () => {
    expect(normalizeClipboardEntryValue(fields[2]!, " 2026/9/30 ")).toBe("2026-09-30");
    expect(normalizeClipboardEntryValue(fields[3]!, " -1.5e2 ")).toBe("-1.5e2");
    expect(() => normalizeClipboardEntryValue(fields[3]!, "Infinity")).toThrow();
  });

  it("reset clears patient binding, pending overwrite, progress and undo history", () => {
    const session = new ClipboardFollowSession();
    session.start(context, ["name"]);
    apply(session, "新姓名", { name: "旧姓名" });
    session.reset();
    expect(session.context).toBeNull();
    expect(session.pending).toBeNull();
    expect(session.history).toEqual([]);
    expect(apply(session, "迟到内容", {}, 2).kind).toBe("ignored");
  });
});
