# Univer 台账迁移

台账主表已经迁移到 Univer 0.25.1。迁移只替换前端表格交互，不迁移或清空现有 SQLite 数据库，也不保留旧表格切换开关。

## 现在的边界

- `frontend/src/components/UniverLedgerGrid.vue` 负责当前项目 workbook 的创建、选区映射、单元格读写、列宽和原生底色命令。
- `LedgerView.vue` 负责业务 API：记录更新、锁定、删除、状态、报告入口、导入、手动导出和项目切换。
- 实验编排、实验编号回写、报告打印、自动导出和项目管理页面保持原业务实现。
- Univer 只保存当前项目的视图数据；记录 UUID、字段 ID 和 `project_id` 仍由业务 API 管理。
- 原生 Fill color/清除底色是唯一的底色入口，颜色会回写现有 `highlight_color` 字段。
- 旧的 Element Plus 主表格、拖动勾选、手写底色面板、复制粘贴解析和输入框宽高/行距设置已经删除。

## 数据库安全

本次迁移没有数据库迁移脚本，也没有删除、重建或覆盖现有 `ledger.db`。验证写入时应先复制数据目录，并通过 `GENE_LEDGER_DATA_DIR` 或桌面“数据目录”切换到副本；生产数据目录不作为迁移测试目标。

## 官方 API 基线

组件采用官方 Vue 3 preset 集成：`createUniver` + `UniverSheetsCorePreset`。实例保存在普通 TypeScript 变量中，在组件卸载时 dispose。当前版本使用的事件是：

- `FWorkbook.onSelectionChange`：将 Univer range 映射为记录列表。
- `FWorkbook.onCommandExecuted`：监听 Fill color、清除底色和列宽命令。
- `univerAPI.addEvent(univerAPI.Event.SheetValueChanged, ...)`：监听编辑、粘贴和撤销后的值变化。

参考官方文档：[Vue 集成](https://docs.univer.ai/guides/sheets/getting-started/integrations/vue)、[安装](https://docs.univer.ai/guides/sheets/getting-started/installation)、[核心能力](https://docs.univer.ai/guides/sheets/features/core)、[架构](https://docs.univer.ai/guides/recipes/architecture/univer)。

## 验证顺序

1. 在独立测试数据目录启动后端，确认项目、字段、记录和底色能加载。
2. 验证 Univer 选区、键盘/鼠标编辑、复制粘贴、锁定保护、列宽、底色和清除底色。
3. 验证实验编号回写、报告打印、手动导出、自动导出和项目隔离。
4. 执行前端 typecheck/test/build、后端 pytest，再执行 Electron Windows 打包。
