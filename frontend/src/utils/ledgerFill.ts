import type { FieldDefinition, ProjectRecord } from "@/types/api";

type NormalizedGridRange = { rowStart: number; rowEnd: number; columnStart: number; columnEnd: number };
type GridPasteEntry = { rowOffset: number; columnOffset: number; value: string };
export type GridFillMode = "series" | "copy";

const NUMERIC_PATTERN = /^[-+]?(?:\d+\.?\d*|\.\d+)$/;

const BUILT_IN_TEXT_SERIES: readonly (readonly string[])[] = [
  ["周一", "周二", "周三", "周四", "周五", "周六", "周日"],
  ["周一", "周二", "周三", "周四", "周五", "周六", "周天"],
  ["星期一", "星期二", "星期三", "星期四", "星期五", "星期六", "星期日"],
  ["星期一", "星期二", "星期三", "星期四", "星期五", "星期六", "星期天"],
  ["1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月"],
  ["一月", "二月", "三月", "四月", "五月", "六月", "七月", "八月", "九月", "十月", "十一月", "十二月"],
  ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
  ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
  ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
  ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
];

function positiveModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

function seriesPosition(
  length: number,
  targetIndex: number,
): { boundaryIndex: number; distance: number; stepPair: [number, number] | null } {
  if (targetIndex < 0) {
    return {
      boundaryIndex: 0,
      distance: targetIndex,
      stepPair: length > 1 ? [0, 1] : null,
    };
  }
  return {
    boundaryIndex: length - 1,
    distance: targetIndex - (length - 1),
    stepPair: length > 1 ? [length - 2, length - 1] : null,
  };
}

function formatFilledInteger(value: bigint, sample: string): string {
  const sampleDigits = sample.replace(/^[-+]/, "");
  const negative = value < 0n;
  const absoluteDigits = (negative ? -value : value).toString().padStart(sampleDigits.length, "0");
  if (negative) return `-${absoluteDigits}`;
  return sample.startsWith("+") ? `+${absoluteDigits}` : absoluteDigits;
}

function filledIntegerSeriesValue(values: string[], targetIndex: number): string | null {
  if (!values.every((value) => /^[-+]?\d+$/.test(value))) return null;
  const numbers = values.map((value) => BigInt(value));
  const position = seriesPosition(values.length, targetIndex);
  const step = position.stepPair
    ? numbers[position.stepPair[1]]! - numbers[position.stepPair[0]]!
    : 1n;
  const next = numbers[position.boundaryIndex]! + step * BigInt(position.distance);
  return formatFilledInteger(next, values[position.boundaryIndex]!);
}

function filledNumericSeriesValue(values: string[], targetIndex: number): string | null {
  if (!values.every((value) => NUMERIC_PATTERN.test(value))) return null;
  const numbers = values.map(Number);
  if (!numbers.every(Number.isFinite)) return null;
  const position = seriesPosition(values.length, targetIndex);
  const step = position.stepPair
    ? numbers[position.stepPair[1]]! - numbers[position.stepPair[0]]!
    : 1;
  const next = numbers[position.boundaryIndex]! + step * position.distance;
  return Number.isInteger(next) ? String(next) : String(Number(next.toFixed(10)));
}

type TextNumberPart = { prefix: string; digits: string; suffix: string };

function splitLastNumber(value: string): TextNumberPart | null {
  const match = value.match(/^(.*?)(\d+)(\D*)$/u);
  return match ? { prefix: match[1]!, digits: match[2]!, suffix: match[3]! } : null;
}

function filledTextNumberSeriesValue(values: string[], targetIndex: number): string | null {
  const parts = values.map(splitLastNumber);
  if (parts.some((part) => !part)) return null;
  const typedParts = parts as TextNumberPart[];
  const { prefix, suffix } = typedParts[0]!;
  if (!typedParts.every((part) => part.prefix === prefix && part.suffix === suffix)) return null;

  const numbers = typedParts.map((part) => BigInt(part.digits));
  const position = seriesPosition(values.length, targetIndex);
  const step = position.stepPair
    ? numbers[position.stepPair[1]]! - numbers[position.stepPair[0]]!
    : 1n;
  const next = numbers[position.boundaryIndex]! + step * BigInt(position.distance);
  const sample = typedParts[position.boundaryIndex]!.digits;
  const negative = next < 0n;
  const digits = (negative ? -next : next).toString().padStart(sample.length, "0");
  return `${prefix}${negative ? "-" : ""}${digits}${suffix}`;
}

function wrappedSeriesStep(from: number, to: number, length: number): number {
  let step = to - from;
  if (step > length / 2) step -= length;
  if (step < -length / 2) step += length;
  return step;
}

function filledBuiltInTextSeriesValue(values: string[], targetIndex: number): string | null {
  const series = BUILT_IN_TEXT_SERIES.find((candidate) =>
    values.every((value) => candidate.includes(value)),
  );
  if (!series) return null;
  const indexes = values.map((value) => series.indexOf(value));
  const position = seriesPosition(values.length, targetIndex);
  const step = position.stepPair
    ? wrappedSeriesStep(
        indexes[position.stepPair[0]]!,
        indexes[position.stepPair[1]]!,
        series.length,
      )
    : 1;
  return series[
    positiveModulo(indexes[position.boundaryIndex]! + step * position.distance, series.length)
  ]!;
}

function formatFilledDate(value: string, dayOffset: number): string {
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  date.setDate(date.getDate() + dayOffset);
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join(
    "-",
  );
}

function filledSeriesValue(
  sourceValues: string[],
  targetIndex: number,
  field: FieldDefinition,
  mode: GridFillMode,
): string {
  if (!sourceValues.length) return "";
  const values = sourceValues.map((value) => value.trim());
  if (mode === "copy") {
    return sourceValues[positiveModulo(targetIndex, sourceValues.length)] ?? "";
  }
  const dateField = field.data_type === "date" || field.system_key === "experiment_date";
  if (dateField && values.every((value) => Boolean(value))) {
    try {
      const dates = values.map(normalizeDate);
      const timestamps = dates.map((date) => new Date(`${date}T00:00:00`).getTime());
      const position = seriesPosition(dates.length, targetIndex);
      const step = position.stepPair
        ? Math.round(
            (timestamps[position.stepPair[1]]! - timestamps[position.stepPair[0]]!) /
              86_400_000,
          )
        : 1;
      return formatFilledDate(dates[position.boundaryIndex]!, step * position.distance);
    } catch {
      // Fall back to text cycling when the selected values are not valid dates.
    }
  }

  const integerValue = filledIntegerSeriesValue(values, targetIndex);
  if (integerValue !== null) return integerValue;

  const numericValue = filledNumericSeriesValue(values, targetIndex);
  if (numericValue !== null) return numericValue;
  if (values.every((value) => NUMERIC_PATTERN.test(value))) {
    return sourceValues[positiveModulo(targetIndex, sourceValues.length)] ?? "";
  }

  const builtInTextValue = filledBuiltInTextSeriesValue(sourceValues, targetIndex);
  if (builtInTextValue !== null) return builtInTextValue;

  const textNumberValue = filledTextNumberSeriesValue(sourceValues, targetIndex);
  if (textNumberValue !== null) return textNumberValue;

  return sourceValues[positiveModulo(targetIndex, sourceValues.length)] ?? "";
}

export function buildGridFillEntries(
  source: NormalizedGridRange,
  target: NormalizedGridRange,
  fields: FieldDefinition[],
  rows: ProjectRecord[],
  valueFor: (record: ProjectRecord, field: FieldDefinition) => string,
  mode: GridFillMode = "series",
): GridPasteEntry[] {
  const extendsUp = target.rowStart < source.rowStart;
  const extendsDown = target.rowEnd > source.rowEnd;
  const extendsLeft = target.columnStart < source.columnStart;
  const extendsRight = target.columnEnd > source.columnEnd;
  if (!extendsUp && !extendsDown && !extendsLeft && !extendsRight) return [];

  const sourceHeight = source.rowEnd - source.rowStart + 1;
  const sourceWidth = source.columnEnd - source.columnStart + 1;
  const entries: GridPasteEntry[] = [];
  for (let rowIndex = target.rowStart; rowIndex <= target.rowEnd; rowIndex += 1) {
    for (let columnIndex = target.columnStart; columnIndex <= target.columnEnd; columnIndex += 1) {
      const isSourceCell =
        rowIndex >= source.rowStart &&
        rowIndex <= source.rowEnd &&
        columnIndex >= source.columnStart &&
        columnIndex <= source.columnEnd;
      if (isSourceCell) continue;
      const field = fields[columnIndex];
      const record = rows[rowIndex];
      if (!field || !record) continue;

      const sourceColumnIndex =
        source.columnStart + positiveModulo(columnIndex - source.columnStart, sourceWidth);
      const sourceRowIndex =
        source.rowStart + positiveModulo(rowIndex - source.rowStart, sourceHeight);
      const fillVertically = rowIndex < source.rowStart || rowIndex > source.rowEnd;
      const sourceValues = fillVertically
        ? Array.from({ length: sourceHeight }, (_, index) =>
            valueFor(rows[source.rowStart + index]!, fields[sourceColumnIndex]!),
          )
        : Array.from({ length: sourceWidth }, (_, index) =>
            valueFor(rows[sourceRowIndex]!, fields[source.columnStart + index]!),
          );
      const targetIndex = fillVertically
        ? rowIndex - source.rowStart
        : columnIndex - source.columnStart;
      entries.push({
        rowOffset: rowIndex - source.rowStart,
        columnOffset: columnIndex - source.columnStart,
        value: filledSeriesValue(sourceValues, targetIndex, field, mode),
      });
    }
  }
  return entries;
}


export function normalizeDate(value: string): string {
  const cleaned = value.trim().replace(/[/.]/g, "-");
  if (!cleaned) return "";
  const match = cleaned.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!match) throw new Error("日期格式应为 YYYY-MM-DD，例如 2026-07-27");
  const [, year, month, day] = match;
  const normalized = `${year}-${String(Number(month)).padStart(2, "0")}-${String(
    Number(day),
  ).padStart(2, "0")}`;
  const date = new Date(`${normalized}T00:00:00`);
  if (
    Number.isNaN(date.getTime()) ||
    date.getFullYear() !== Number(year) ||
    date.getMonth() + 1 !== Number(month) ||
    date.getDate() !== Number(day)
  ) {
    throw new Error("日期无效，请重新输入");
  }
  return normalized;
}

