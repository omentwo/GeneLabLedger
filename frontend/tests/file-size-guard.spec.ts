import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * 台账前端文件体量守卫（拆分收工线）。
 *
 * LedgerView 已从 9567 行降到 ~6.3k（表格卡按 P2-9 决策永久留在容器）。
 * 与早期"贴住现状"的阈值不同，这里是**收工线**：以下各条全部达标后
 * 结构拆分即告完成，后续只等 bug 驱动再动，不再为行数而拆——
 *
 * 1. LedgerView ≤ 6350：收尾三项（pasteGrid 拆分、loadRecords 下沉）后的
 *    实际落点（6289）+ 少量余量。提交/校验面板逻辑与视图状态强耦合，
 *    留在容器内是有意为之，不是欠账。
 * 2. 单个顶层函数 ≤ 160：贴住 handleGridKeydown（156，键盘交互热区，
 *    已知豁免项）；pasteGrid 拆分后为 145。
 * 3. composable 实例 ≤ 18：当前 17。继续拆会把"单文件太长"变成
 *    "依赖太散"，超过该值说明拆过头了。
 * 4. 区块组件 ≤ 400、composables ≤ 800：防 god-file 回潮。
 *    useLedgerCellSave（719）是唯一接近上限的模块——约定：下一个需要
 *    改动 cellSave 的功能顺带抽出共享脚手架 useCellSaveCommit（乐观更新
 *    → 失败回滚 → 历史 → 错误面板；注意 saveField 单请求路径与
 *    saveFieldWithPreview 批量预览路径语义不同，不要合并），完成后把
 *    本阈值降到 600。
 *
 * 合理的功能增长请显式调整阈值并在 PR 里说明。
 */
const root = path.resolve(fileURLToPath(import.meta.url), "../..");

function lineCount(relativePath: string): number {
  return readFileSync(path.join(root, relativePath), "utf8").split("\n").length;
}

function scriptLines(): string[] {
  const source = readFileSync(path.join(root, "src/views/LedgerView.vue"), "utf8");
  const start = source.indexOf("<script");
  const end = source.indexOf("</script>");
  return source.slice(start, end).split("\n");
}

/** 顶层声明跨度近似函数长度（下一个顶层声明之前都属于当前函数）。 */
function topLevelFunctionLengths(): Array<{ name: string; lines: number }> {
  const lines = scriptLines();
  const declaration = /^(?:async )?function \w+|^(?:export )?const |^let |^watch\(|^onMounted|^onBeforeUnmount|^type |^interface |^import /;
  const starts: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (declaration.test(lines[index] ?? "")) starts.push(index);
  }
  const lengths: Array<{ name: string; lines: number }> = [];
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index];
    if (start === undefined) continue;
    const match = lines[start]?.match(/^(?:async )?function (\w+)/);
    if (!match) continue;
    const next = starts[index + 1] ?? lines.length;
    lengths.push({ name: match[1] ?? "", lines: next - start });
  }
  return lengths;
}

describe("ledger file size guard", () => {
  it("LedgerView 保持在收工线内（表格卡留守后的实际落点 + 少量余量）", () => {
    expect(lineCount("src/views/LedgerView.vue")).toBeLessThanOrEqual(6350);
  });

  it("LedgerView 单个顶层函数不超过 160 行（handleGridKeydown 为已知豁免）", () => {
    for (const { name, lines } of topLevelFunctionLengths()) {
      expect(lines, `function ${name}`).toBeLessThanOrEqual(160);
    }
  });

  it("LedgerView 的 composable 实例数不超过 18（防依赖过散）", () => {
    const instances = scriptLines().join("\n").match(/= use[A-Z]\w*\(/g) ?? [];
    expect(instances.length).toBeLessThanOrEqual(18);
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
