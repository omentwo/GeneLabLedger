# Univer 测试数据库策略

## 原则

- 本次迁移没有数据库 schema 变更，不执行 `drop_all`、删除 SQLite 文件或覆盖现有 `ledger.db`。
- 需要验证写入时，先复制业务数据目录到独立目录，例如 `backend/data/univer-test/`。
- 启动后端时设置 `GENE_LEDGER_DATA_DIR` 指向副本；桌面版可在“数据与设置”中切换目录并重启。
- 生产数据目录只用于只读核对，测试编辑、删除、底色和编号回写均落到副本。

## 推荐步骤

1. 关闭正在使用业务数据库的测试实例，备份数据库和 `templates` 目录。
2. 复制整个数据目录，确保 `ledger.db`、报告模板和导出目录一起存在。
3. 用副本启动后端，打开台账并确认项目、字段、记录和已有底色可加载。
4. 在 Univer 中测试选区、编辑、复制粘贴、撤销/重做、锁定、列宽、底色和清除底色。
5. 测试实验编排编号回写、报告打印、手动/自动导出和项目隔离。
6. 对比业务目录文件哈希或修改时间，确认生产数据库没有写入。

## API 边界

- workbook：`univerAPI.createWorkbook`、`FWorkbook.save`/`getSnapshot`。
- 选区：`FWorkbook.onSelectionChange`。
- 值变化：`univerAPI.Event.SheetValueChanged`。
- 样式和区域：`FWorksheet.getRange`、`FRange.setBackground`、`setValueForCell`。
- 底色和列宽：`FWorkbook.onCommandExecuted` 监听 Univer 原生命令。

禁止通过 Element Plus 表格实例、`querySelector` 或浏览器拖动事件替代表格行为。
