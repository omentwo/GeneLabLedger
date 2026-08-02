# Univer 台账上线清单

## 已完成

- [x] 使用 `UniverLedgerGrid.vue` 替换台账主表格。
- [x] 通过 Facade/Command API 处理选区、编辑、粘贴、撤销后的值变化、列宽和底色。
- [x] 移除 Element Plus 主表格、拖动勾选、手写底色面板、旧表格 CSS 和输入框显示设置。
- [x] 不保留前端新旧表格切换开关。
- [x] 保留记录 UUID/字段 ID 映射、项目隔离、锁定、删除、实验编排、编号回写、报告打印、手动/自动导出。
- [x] 未修改、清空或重建现有 SQLite 数据库。

## 发布前验证

- [ ] 用独立 `GENE_LEDGER_DATA_DIR` 副本验证编辑、复制粘贴、撤销/重做、锁定、底色和清除底色。
- [ ] 验证实验编号回写、报告打印、手动导出、自动导出和多个项目互不影响。
- [ ] `npm --prefix frontend run typecheck`。
- [ ] `npm --prefix frontend test -- --run`。
- [ ] `npm --prefix frontend run build`。
- [ ] 后端 `pytest` 和 Windows Electron 打包通过。
- [ ] Windows 安装包启动、始终置顶、剪贴板和文件保存冒烟测试通过。

## 回滚

使用上一版 Git 标签或安装包回滚；不删除当前业务数据库，不恢复旧前端切换开关。
