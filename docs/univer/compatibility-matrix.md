# Univer 兼容性矩阵

| 功能 | 迁移后的实现 | 状态 |
| --- | --- | --- |
| 单元格编辑 | Univer Facade + `updateRecord` | 已接入 |
| 多选/键盘导航/复制粘贴/撤销 | Univer 原生选区与命令 | 已接入 |
| 列宽 | Univer 列宽命令 + 字段 `width` API | 已接入 |
| 底色/清除底色 | Univer 原生 Fill color/Reset + `highlight_color` API | 已接入 |
| 锁定记录 | Univer 本地恢复 + 后端锁定校验 | 已接入 |
| 记录删除 | 业务工具栏确认后调用删除 API | 已保留 |
| 状态与报告状态 | 业务工具栏调用记录 API | 已保留 |
| 实验编排/编号回写 | `ExperimentsView.vue` 与现有 API | 已保留 |
| 报告打印 | DOCX/WPS/Word 服务 | 已保留 |
| 手动 Excel 导出 | 现有导出 API | 已保留 |
| 自动导出 | 现有调度器 | 已保留 |
| 项目隔离 | 每个项目独立 workbook，API 继续校验 `project_id` | 已保留 |
| 输入框宽高/记录间距设置 | Univer 行高、列宽和对齐能力 | 已移除旧设置 |
| 当前 SQLite 数据库 | 不迁移、不清空、不重建 | 保持不变 |

## 回滚

迁移不保留前端新旧表格开关。回滚使用上一版 Git 标签或安装包；恢复时不删除当前业务数据库。
