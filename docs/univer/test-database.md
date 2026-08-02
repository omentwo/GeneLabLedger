# Univer 测试数据库策略

## 原则

- 不对当前业务 SQLite 数据库执行迁移、清空、重建或删除。
- 不把当前业务数据库作为 Univer 正式迁移目标。
- 测试时使用独立的测试数据目录，例如 `backend/data/univer-test/`，或使用当前数据库的只读副本。
- 测试产生的编辑、删除、底色和编号回写只能写入测试数据库；测试结束可以直接销毁测试目录，不影响当前业务数据。

## 数据装载

1. 先备份当前数据库和模板目录。
2. 将当前数据库复制到测试目录，或使用后端种子数据创建全新的测试库。
3. 通过现有项目/记录 API 读取测试数据，转换成 `IWorkbookData`，再调用 `univerAPI.createWorkbook(workbookData)`。
4. 在 Univer 中完成表格操作，使用 Univer 事件和命令收集变更。
5. 需要验证保存时，只调用测试环境的记录 API，不连接当前业务数据目录。

## Univer API 边界

表格层必须使用 Univer API：

- 工作簿和快照：`createWorkbook`、`FWorkbook.getSnapshot`。
- 单元格/区域：`FWorksheet.getRange`、Facade 的值和样式 API。
- 选区：`SelectionChanged`、active range 和 range list。
- 编辑与粘贴：`SheetEditEnded`、`ClipboardPasted` 以及相应命令事件。
- 底色：`sheet.command.set-background-color` 和清除底色命令。
- 删除、排序、筛选和撤销：Univer 的 range/worksheet 命令。

禁止通过 Element Plus 表格实例、`querySelector` 直接改单元格、或用浏览器 DOM 拖动逻辑替代表格行为。

## 验收标准

- 现有业务数据库文件的修改时间和内容在测试前后不变。
- 测试数据库可以完整加载项目、字段、记录和底色。
- Univer 的多选、复制粘贴、底色和删除行为只影响测试库。
- 关闭测试版本后，当前业务版本仍可正常打开原数据库。

