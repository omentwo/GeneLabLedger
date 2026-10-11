interface PathologyParts {
  prefix: string;
  year: number;
  serial: number;
  remainder: string;
}

// Sorting re-parses the same pathology numbers for every comparison; memoize
// per raw value so a sort pass parses each distinct number once.
const PARSE_CACHE_MAX_ENTRIES = 10_000;
const parseCache = new Map<string, PathologyParts | null>();

function parsePathologyNumber(value: string): PathologyParts | null {
  const cached = parseCache.get(value);
  if (cached !== undefined) return cached;
  const match = value.trim().match(/^([A-Za-z]*)(\d+)-(\d+)(.*)$/);
  const parsed: PathologyParts | null = match
    ? {
        prefix: match[1]!.toUpperCase(),
        year: Number(match[2]!),
        serial: Number(match[3]!),
        remainder: match[4]!,
      }
    : null;
  if (parseCache.size >= PARSE_CACHE_MAX_ENTRIES) parseCache.clear();
  parseCache.set(value, parsed);
  return parsed;
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
