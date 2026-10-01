import type { FieldDefinition } from "@/types/api";
import type { ClipboardFollowContext, ClipboardFollowEvent } from "@/types/electron";
import { isClipboardEntryField, normalizeQuickEntryFieldValue } from "@/utils/quickEntry";

export type ClipboardFollowStatus = "waiting" | "listening" | "paused" | "complete";
type ClipboardValueEvent = Extract<ClipboardFollowEvent, { type: "clipboard" }>;
type FillResult = { kind: "filled"; field: FieldDefinition; value: string }
  | { kind: "blocked"; message: string } | { kind: "ignored" };
interface FollowStep {
  index: number;
  fieldId: string;
  previous?: string;
  filled?: string;
}

export function normalizeClipboardEntryValue(field: FieldDefinition, text: string): string {
  const value = normalizeQuickEntryFieldValue(field, text);
  if (field.data_type === "number" && value && (
    !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value) || !Number.isFinite(Number(value))
  )) throw new Error(`${field.label}必须是有效数字`);
  const options = field.options.map((option) => option.value);
  if (field.data_type === "select" && field.system_key !== "status" && options.length && !options.includes(value)) {
    throw new Error(`${field.label}未包含在备选项中，请修正或跳过`);
  }
  return value;
}

export class ClipboardFollowSession {
  context: ClipboardFollowContext | null = null;
  fieldIds: string[] = [];
  index = 0;
  status: ClipboardFollowStatus = "waiting";
  message = "确认本条后开始接收";
  history: FollowStep[] = [];
  pending: ClipboardValueEvent | null = null;
  lastEventId = 0;
  lastFilledFieldId = "";

  get nextFieldId(): string { return this.fieldIds[this.index] ?? ""; }

  reset(message = "确认本条后开始接收"): void {
    this.context = null;
    this.fieldIds = [];
    this.index = 0;
    this.history = [];
    this.pending = null;
    this.lastEventId = 0;
    this.lastFilledFieldId = "";
    this.status = "waiting";
    this.message = message;
  }

  start(context: ClipboardFollowContext, fieldIds: string[], resume = false): void {
    const sameRecord = this.context?.projectId === context.projectId && this.context?.recordId === context.recordId;
    if (!resume || !sameRecord) this.reset();
    this.context = { ...context };
    this.pending = null;
    this.fieldIds = [...fieldIds];
    this.lastEventId = 0;
    this.status = this.nextFieldId ? "listening" : "complete";
    this.message = this.nextFieldId ? "在其他软件复制信息即可填入当前项" : "本条已完成，请检查后保存";
  }

  pause(message = "接收已暂停，继续后请重新复制"): void {
    this.status = "paused";
    this.message = message;
  }

  matches(event: ClipboardFollowContext): boolean {
    return Boolean(this.context && Object.keys(this.context).every((key) =>
      this.context?.[key as keyof ClipboardFollowContext] === event[key as keyof ClipboardFollowContext]));
  }

  receive(event: ClipboardValueEvent, fields: FieldDefinition[], values: Record<string, string>, overwrite: boolean): FillResult {
    if (this.status !== "listening" || !this.matches(event) || event.eventId <= this.lastEventId) {
      return { kind: "ignored" };
    }
    this.lastEventId = event.eventId;
    if (!event.text.trim()) return { kind: "ignored" };
    return this.fill(event, fields, values, overwrite);
  }

  fill(event: ClipboardValueEvent, fields: FieldDefinition[], values: Record<string, string>, overwrite: boolean): FillResult {
    const field = fields.find((item) => item.id === this.nextFieldId);
    if (!field || !isClipboardEntryField(field)) {
      this.pause("当前表头已不可用，请重新设置粘贴顺序");
      return { kind: "blocked", message: this.message };
    }
    let value: string;
    try {
      value = normalizeClipboardEntryValue(field, event.text);
    } catch (error) {
      this.pending = null;
      this.pause(error instanceof Error ? error.message : "字段内容无效");
      return { kind: "blocked", message: this.message };
    }
    const previous = values[field.id] ?? "";
    if (!overwrite && previous.trim() && previous !== value) {
      this.pending = { ...event };
      this.pause(`${field.label}已有内容，请覆盖当前项或跳过`);
      return { kind: "blocked", message: this.message };
    }
    this.pending = null;
    this.history.push({ index: this.index, fieldId: field.id, previous, filled: value });
    this.lastFilledFieldId = field.id;
    this.advance();
    return { kind: "filled", field, value };
  }

  overwritePending(fields: FieldDefinition[], values: Record<string, string>): FillResult {
    const pending = this.pending;
    if (!pending || !this.matches(pending) || this.status !== "paused") return { kind: "ignored" };
    this.status = "listening";
    return this.fill(pending, fields, values, true);
  }

  advance(): void {
    this.index += 1;
    this.status = this.nextFieldId ? "listening" : "complete";
    this.message = this.nextFieldId ? "在其他软件复制信息即可填入当前项" : "本条已完成，请检查后保存";
  }

  skip(): void {
    if (!this.context || !this.nextFieldId) return;
    this.history.push({ index: this.index, fieldId: this.nextFieldId });
    this.pending = null;
    this.advance();
  }

  undo(values: Record<string, string>): { fieldId: string; value: string } | null {
    const step = this.history[this.history.length - 1];
    if (!step) return null;
    if (
      step.filled !== undefined &&
      values[step.fieldId] !== step.filled &&
      values[step.fieldId] !== step.previous
    ) {
      this.pause("上一项已手动修改，保留该修改；可重新开始录入");
      return null;
    }
    this.history.pop();
    this.index = step.index;
    this.pending = null;
    this.lastFilledFieldId = "";
    this.pause("已撤回至上一项，请重新复制");
    return step.previous === undefined ? null : { fieldId: step.fieldId, value: step.previous };
  }
}
