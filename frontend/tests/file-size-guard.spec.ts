import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * 台账前端文件体量守卫（两阶段重构的收尾约束）。
 *
 * LedgerView 已从 9567 行降到 ~6.7k（表格卡按 P2-9 决策永久留在容器）；
 * 外围逻辑全部住在 ≤400 行的区块组件和 ≤800 行的 composables 里。
 * 阈值刻意贴住现状：新增体量应当落进新的组件/composable，
 * 而不是让 LedgerView 或某个模块悄悄长回“上帝文件”。
 * 合理的功能增长请显式调整阈值并在 PR 里说明。
 */
const root = path.resolve(fileURLToPath(import.meta.url), "../..");

function lineCount(relativePath: string): number {
  return readFileSync(path.join(root, relativePath), "utf8").split("\n").length;
}

describe("ledger file size guard", () => {
  it("LedgerView 保持在容器预算内（表格卡留守后的基线 + 少量余量）", () => {
    expect(lineCount("src/views/LedgerView.vue")).toBeLessThanOrEqual(6800);
  });

  it("ledger 区块组件不超过 400 行", () => {
    const dir = path.join(root, "src/components/ledger");
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".vue")) continue;
      const lines = readFileSync(path.join(dir, file), "utf8").split("\n").length;
      expect(lines, `src/components/ledger/${file}`).toBeLessThanOrEqual(400);
    }
  });

  it("ledger composables 不超过 800 行（防 god-composable 回潮）", () => {
    const dir = path.join(root, "src/composables");
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".ts")) continue;
      const lines = readFileSync(path.join(dir, file), "utf8").split("\n").length;
      expect(lines, `src/composables/${file}`).toBeLessThanOrEqual(800);
    }
  });
});
