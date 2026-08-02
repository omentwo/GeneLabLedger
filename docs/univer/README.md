# Univer 替换准备

本目录用于准备将台账表格区域替换为 Univer 的设计、数据契约和验收资料。

## 当前结论

- 本阶段只准备文档，不启用 Univer 运行时代码，也不改变现有数据库结构。
- 推荐只替换 `LedgerView.vue` 内的数据表格，保留项目导航、实验编排、报告、导入导出和自动导出页面。
- 后端数据库仍是唯一数据源。Univer 只负责表格展示、选区、编辑、复制粘贴和批量操作。
- 每个项目使用独立的 Univer 工作簿实例。切换项目时销毁旧实例并按项目重新加载数据。
- 迁移必须复用现有 SQLite 数据目录和记录，不执行清库、重建空库或删除旧记录；迁移前只做备份，迁移后通过同一 `project_id` 继续使用原数据。
- 不保留前端新旧表格切换开关。迁移验收通过后直接使用 Univer，回滚依靠 Git 标签或安装包版本，不在运行时保留旧表格分支。
- 底色使用 Univer 原生 Fill color / `sheet.command.set-background-color`，同时把颜色值同步到现有 `highlight_color` 字段，以便重新加载、报告和导出保持一致。

## 当前官方接入基线

按官方 Vue 3 集成文档，首版使用 `@univerjs/presets` + `@univerjs/preset-sheets-core` 的 preset 模式，在 `onMounted` 中调用 `createUniver`，在 `onBeforeUnmount` 中 dispose；Univer/FUniver 实例不放进 Vue 的 reactive/ref 代理中。

参考：

- <https://docs.univer.ai/guides/sheets/getting-started/integrations/vue>
- <https://docs.univer.ai/guides/sheets/getting-started/installation>
- <https://docs.univer.ai/guides/sheets/features/core>

## 文档索引

- [架构边界](./architecture.md)：现有模块与 Univer 的接入位置。
- [数据契约](./data-contract.md)：行、列、记录 ID、字段 ID 和保存规则。
- [兼容性矩阵](./compatibility-matrix.md)：现有功能替换后的保留方式和回退方案。
- [上线清单](./rollout-checklist.md)：开发、测试、Electron 打包和回滚步骤。

## 推荐实施顺序

1. 新建 `UniverLedgerGrid.vue`，以当前 `LedgerView` 的记录和字段生成工作簿快照。
2. 通过 `SelectionChanged`、`SheetEditEnded` 和 `ClipboardPasted` 等事件同步选区和修改。
3. 单元格编辑调用现有记录更新接口；多单元格粘贴调用批量导入提交接口。
4. 删除、锁定、底色、报告打印等业务动作继续经过现有业务 API，不直接依赖 Univer 的内部行号。
5. 直接替换台账表格并完成验收；回滚只使用版本标签或安装包，不增加前端旧功能开关。
