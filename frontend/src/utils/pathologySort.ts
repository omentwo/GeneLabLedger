interface PathologyParts {
  prefix: string;
  year: number;
  serial: number;
  remainder: string;
}

function parsePathologyNumber(value: string): PathologyParts | null {
  const match = value.trim().match(/^([A-Za-z]*)(\d+)-(\d+)(.*)$/);
  if (!match) return null;
  return {
    prefix: match[1]!.toUpperCase(),
    year: Number(match[2]!),
    serial: Number(match[3]!),
    remainder: match[4]!,
  };
}

export function comparePathologyNumbers(left: string, right: string): number {
  const a = parsePathologyNumber(left);
  const b = parsePathologyNumber(right);
  if (!a || !b) {
    return left.localeCompare(right, "zh-CN", {
      numeric: true,
      sensitivity: "base",
    });
  }
  if (a.prefix !== b.prefix) {
    if (!a.prefix) return -1;
    if (!b.prefix) return 1;
    return a.prefix.localeCompare(b.prefix, "en", { sensitivity: "base" });
  }
  if (a.year !== b.year) return a.year - b.year;
  if (a.serial !== b.serial) return a.serial - b.serial;
  return a.remainder.localeCompare(b.remainder, "zh-CN", {
    numeric: true,
    sensitivity: "base",
  });
}
