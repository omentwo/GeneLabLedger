import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * 台账前端文件体量守卫（防回潮棘轮）。
 *
 * LedgerView 已从 9567 行降到 ~6.3k（表格卡按 P2-9 决策永久留在容器）。
 * 2026-10 口径调整：行数只约束 <script>（样式与模板不是逻辑复杂度，
 * 总行数不再设限）；"容器内主题数量"改用顶层函数数冻结来约束——
 *
 * 1. LedgerView <script> ≤ 4900：脚本实际落点（4646）+ 给下一个功能
 *    让路的余量。样式与模板可以自由增长，逻辑体量到线即须外移。
 * 2. 顶层函数数 ≤ 193（只减不增）：193 个函数平均 18 行、最大 156，
 *    单点复杂度是健康的，病根是"主题挤在同一个 setup 作用域"。新增
 *    逻辑必须落入 composable 或区块组件；加一必须删一。
 * 3. 单个顶层函数 ≤ 160：贴住 handleGridKeydown（156，键盘交互热区，
 *    已知豁免项）；pasteGrid 拆分后为 149。
 * 4. 区块组件 ≤ 400、composables ≤ 800：防 god-file 回潮。
 *    useLedgerCellSave（732）是唯一接近上限的模块——约定：下一个需要
 *    改动 cellSave 的功能顺带抽出共享脚手架 useCellSaveCommit（乐观更新
 *    → 失败回滚 → 历史 → 错误面板；注意 saveField 单请求路径与
 *    saveFieldWithPreview 批量预览路径语义不同，不要合并），完成后把
 *    本阈值降到 600。
 *
 * 合理的功能增长请显式调整阈值并在 PR 里说明。
 */
const root = path.resolve(fileURLToPath(import.meta.url), "../..");

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
  it("LedgerView 脚本行数不超过 4900（样式与模板不计入逻辑体量，总行数不设限）", () => {
    expect(scriptLines().length).toBeLessThanOrEqual(4900);
  });

  it("LedgerView 单个顶层函数不超过 160 行（handleGridKeydown 为已知豁免）", () => {
    for (const { name, lines } of topLevelFunctionLengths()) {
      expect(lines, `function ${name}`).toBeLessThanOrEqual(160);
    }
  });

  it("LedgerView 顶层函数数不超过 193（只减不增：新增逻辑须落入 composable 或区块组件）", () => {
    const functions = topLevelFunctionLengths();
    expect(functions.length, `顶层函数 ${functions.length} 个`).toBeLessThanOrEqual(193);
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
