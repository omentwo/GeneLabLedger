# Univer 数据契约

## 工作簿范围

- 一个活动项目对应一个 workbook，只加载该项目的字段和记录。
- 切换项目时 dispose 旧 workbook，再按新的 `project_id` 创建快照。
- workbook 行列索引只用于界面定位；任何保存、删除、锁定或报告操作都使用业务 ID。

## 映射

| Univer 信息 | 业务字段 | 规则 |
| --- | --- | --- |
| 第 0 行 | 字段 label | 冻结表头，不作为记录 |
| 第 `index + 1` 行 | `ProjectRecord.id` | 通过当前 props 行数组映射，不能持久化为主键 |
| 第 `columnIndex` 列 | `FieldDefinition.id` | 通过字段 ID 保存，不使用表头文字作唯一标识 |
| 行底色 | `ProjectRecord.highlight_color` | 十六进制色值；空值表示清除 |
| 锁定行 | `ProjectRecord.locked` | 前端恢复本地编辑，后端继续强制校验 |
| 实验编号 | `experiment_number` | 实验编排页面完成后通过既有 API 回写 |

## 编辑与同步

1. `FWorkbook.onSelectionChange` 将当前 range 的数据行去重后发出 `selection-change`。
2. `SheetValueChanged` 读取受影响 FRange 的值，按行列映射发出 `cell-change`。
3. `LedgerView` 对普通记录调用 `updateRecord`；草稿行先走既有创建逻辑；锁定行恢复原值。
4. 服务端返回规范化记录后重新写回 workbook，避免只相信本地值。
5. 复制、粘贴、撤销和重做都由 Univer 产生值变化事件；数据库记录删除仍由业务工具栏确认后调用删除 API。

## 底色与列宽

- 用户使用 Univer 原生 Fill color 或清除底色命令。
- `onCommandExecuted` 读取命令范围，将颜色和记录 ID 发给 `setRecordsHighlight`；后端返回值再同步回工作簿。
- 用户拖动列边界或设置列宽时，组件发出 `column-resize`，由项目字段 API 持久化 `width`。
- 旧的自定义颜色面板、底色 CSS、输入框宽高和行距设置不再参与渲染。

## 导入导出与业务操作

Excel 导入预览/提交、手动导出、报告打印、自动导出和实验编号回写继续使用现有业务 API；这些功能不把 Univer 行号写入数据库，也不改变 `project_id` 隔离规则。
