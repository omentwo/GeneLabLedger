import type { ProjectRecord } from "@/types/api";
import { comparePathologyNumbers } from "@/utils/pathologySort";

type SchedulingRecord = Pick<ProjectRecord, "pathology_number" | "block_number">;

/** Display-only pathology identifier used by experiment scheduling and its export. */
export function experimentPathologyNumber(record: SchedulingRecord): string {
  const pathologyNumber = record.pathology_number.trim();
  const blockNumber = record.block_number?.trim() ?? "";
  return blockNumber ? `${pathologyNumber}-${blockNumber}` : pathologyNumber;
}

export function compareExperimentPathologyNumbers(
  left: SchedulingRecord,
  right: SchedulingRecord,
): number {
  return comparePathologyNumbers(
    experimentPathologyNumber(left),
    experimentPathologyNumber(right),
  );
}
