# Univer 数据契约

## 工作簿范围

- 一个活动项目对应一个 Univer workbook。
- workbook 中只加载当前项目的字段和记录，不混入其他项目数据。
- 切换项目时先 dispose 当前 workbook，再加载新项目快照。
- 项目 ID 由页面状态提供，不能从可见单元格内容推断。

## 行映射

| Univer 信息 | 业务字段 | 规则 |
| --- | --- | --- |
| 行索引 | `ProjectRecord.id` | 只用于界面定位，保存必须使用 UUID |
| 项目范围 | `ProjectRecord.project_id` | 所有更新、删除、报告操作校验项目归属 |
| 锁定状态 | `ProjectRecord.locked` | 锁定记录不可编辑、删除或导入覆盖 |
| 底色 | `ProjectRecord.highlight_color` | 使用十六进制颜色，空值表示清除底色 |
| 实验编号 | `ProjectRecord.experiment_number` | 编排完成后由批量接口回写 |

## 列映射

| Univer 信息 | 业务字段 | 备注 |
| --- | --- | --- |
| 列索引 | `FieldDefinition.id` | 不使用列标题作为唯一标识 |
| 系统字段 | `pathology_number`、`status`、`experiment_date` 等 | 通过固定 system key 映射 |
| 自定义字段 | `RecordValue.field_id` + `value_text` | 保存时提交字段 ID 和规范化文本 |
| 字段类型 | `text`、`number`、`date`、`select` | 下拉、日期和数字校验由数据契约统一转换 |

## 编辑与粘贴

1. `SheetEditEnded` 产生单元格修改时，先根据行列映射取得 record ID 和 field ID。
2. 单个单元格调用记录更新接口，并处理锁定、冲突和错误提示。
3. 多单元格粘贴先解析为二维值，再按记录 ID 聚合，调用批量导入提交接口。
4. 保存成功后重新应用服务端规范化值，不能只相信工作簿本地值。
5. 删除记录必须弹出业务确认，并调用记录删除接口；不得用普通 `deleteCells` 代替。

## 导出契约

手动导出仍使用现有 `WorkbookSheet` 结构：`name`、`headers`、`rows` 和隐藏列信息。Univer 快照只作为表格展示数据的来源，最终导出仍由后端或现有桌面保存桥完成。

## 限制

- 首版沿用现有导入文件大小、字段数量和记录数量限制。
- 超大数据集应分页加载或使用虚拟化，不把所有项目数据无条件复制到浏览器内存。
- 所有批量请求都应记录失败行和服务端错误，支持重试而不是静默丢失。

