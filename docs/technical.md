# 基因检测台账管理系统 — 技术文档

> 本文档描述当前已完成版本的实现、边界和运维方式。接口、路径和限制以仓库代码为准。

## 1. 总体架构

```text
Electron 主进程
  ├─ 单实例与窗口生命周期
  ├─ 主窗口与快速录入置顶辅助窗口
  ├─ 随机 loopback 端口
  ├─ 原生保存/选目录对话框
  ├─ 白名单 IPC 与发送者校验
  ├─ 启动 Python sidecar
  │     └─ FastAPI / Uvicorn（127.0.0.1:<随机端口>）
  │           ├─ SQLAlchemy 2 + SQLite
  │           ├─ DOCX Open XML（zipfile + lxml）与 Word/WPS COM 打印
  │           ├─ XLSX Open XML 生成（手写，无第三方 Excel 库）
  │           └─ SQLite 完整业务备份调度器
  └─ 剪贴板跟随：以后端可执行文件的 --clipboard-listener 独立模式
        运行 helper 进程（无 HTTP、不打开业务数据库）
```

Electron 负责桌面边界和文件对话框，Vue 前端只通过 HTTP API 和 preload 暴露的少量桌面能力工作。后端在启动时初始化目录、数据库会话、打印服务和数据库备份调度器；正常退出时先生成退出备份，再关闭打印服务和数据库连接。剪贴板跟随 helper 由 Electron 主进程（`clipboard-follow.cjs`）管理生命周期，与快速录入窗口按会话通信。

生产桌面版从 `frontend/dist/index.html` 加载 hash 路由；开发模式由 Vite `127.0.0.1:5173` 提供页面并代理 `/api`。后端构建了前端静态目录时也可直接提供 `/`，旧的 `/app` 路径重定向到根路径。

## 2. 技术栈

| 层级 | 实现 |
|---|---|
| 桌面容器 | Electron 43、electron-builder、NSIS |
| 前端 | Vue 3、TypeScript、Vite 7（生产构建关闭 sourcemap）、Pinia、Vue Router |
| UI | Element Plus 2.14.3（主台账使用 Table V2）、Tailwind CSS 4（未启用 Preflight） |
| 图表与图标 | ECharts 6（SVG 渲染）、`@lucide/vue` |
| 后端 | Python 3.13、FastAPI、Uvicorn、Pydantic v2（经 pydantic-settings）、lxml、python-multipart |
| 持久化 | SQLAlchemy 2、SQLite、Alembic |
| Excel | XLSX 手写 Open XML 生成（`POST /api/exports/workbook`，导入已移除） |
| 文档与打印 | DOCX Open XML（zipfile + lxml）、pywin32 COM、Word/WPS |
| 任务 | Python `asyncio` 数据库备份调度器 |
| 测试与质量 | pytest、HTTPX、Vitest/jsdom、vue-tsc、Ruff、node:test |
| Windows 发布 | GitHub Actions、PyInstaller sidecar、Electron 安装包 |

前端和后端版本号保持一致（当前 2.4.15），分别位于 `frontend/package.json` 与 `backend/pyproject.toml`，后端 `/api/health` 返回同一版本。

## 3. 启动模式与目录布局

### 3.1 Electron 桌面启动

`frontend/electron/main.cjs` 的启动顺序如下：

1. 获取单实例锁，读取 `app.getPath("userData")/settings/desktop-settings.json` 中的绝对 `dataDirectory`。
2. 首次启动通过原生目录选择框取得业务数据目录；取消选择则退出。
3. 申请空闲的 `127.0.0.1` 端口，开发模式启动 `backend/desktop/launcher.py`（优先 `.venv` 内的 Python，可用 `GENE_LEDGER_PYTHON` 覆盖），打包模式启动 `resources/backend/GeneLabLedgerBackend.exe`。
4. 通过命令行传递 `--host`、`--port`、`--data-dir`，并注入 `GENE_LEDGER_SHUTDOWN_TOKEN`；轮询 `/api/health`，最多等待 20 秒。
5. 创建启用 `contextIsolation`、禁用 `nodeIntegration`、启用 `sandbox` 的主 `BrowserWindow`，把后端地址、数据目录和窗口类型作为 preload 参数传入。
6. 主台账通过白名单 IPC 按需创建或复用快速录入 `BrowserWindow`。辅助窗使用独立 `/quick-entry` hash 路由、默认始终置顶、允许缩放，并把窗口的位置和大小持久化到 `desktop-settings.json`；它不使用 modal 或父子窗口关系，因此不会阻塞主窗口。

桌面 launcher 显式设置 `auto_create_schema=True`，因此桌面首次运行可以直接创建当前 ORM 结构。`backend/app/config.py` 中的默认值是 `False`；直接以 `app.main:app` 运行的开发/服务进程应先执行 Alembic 迁移。

Ctrl+W、标题栏关闭、应用退出和重启共用关闭保护：主窗口关闭前同时检查台账修改与快速录入草稿，包括隐藏的快速录入窗口。检查期间暂停剪贴板跟随并暂时禁止编辑；有正在保存的请求时取消关闭，完成后可重试。有草稿时提供保存、放弃、取消。保存失败或取消会恢复编辑并保留后台服务；关闭时保存快速录入不会跳到下一条或启动新的监听。各窗口完成正常卸载后，才停止监听和后端并退出；重启也在关闭获得同意后才安排。

### 3.2 业务数据目录

```text
<data_dir>/
├─ ledger.db                         SQLite 数据库
├─ templates/<template_id>/vN.docx   报告模板版本
├─ temp/reports/<print-id>/          打印期间的临时 DOCX
└─ backups/YYYY-MM-DD/*.glbkp        默认完整业务备份目录
```

设置页更换目录只原子更新桌面设置文件，重启后生效，不搬移旧数据库或模板。后端 `Settings.ensure_directories()` 负责创建上述目录。

## 4. 数据模型与完整性

```text
Project
  ├─ FieldDefinition ── FieldOption
  ├─ ProjectRecord ── RecordValue
  └─ ReportTemplate ── ReportTemplateVersion ── ReportMapping

LedgerTemplate   全局台账表头模板
AuditLog
AppSetting
```

| 模型 | 关键字段与约束 |
|---|---|
| `Project` | UUID 主键；名称唯一；保存顺序、是否参与实验编排，以及默认开启的同项目病理号重复提醒开关 |
| `FieldDefinition` | 项目内 `key`、`system_key` 唯一；支持 text/number/date/select、宽度、隐藏和新记录默认值；核心字段不可删除 |
| `FieldOption` | 同一字段的选项值唯一，保存排序 |
| `ProjectRecord` | UUID 主键；以项目内 `position` 保存稳定行序；`pathology_number` 可重复并建索引；`block_number` 可空并独立建索引；`experiment_number` 可空且可重复；保存状态、实验日期、报告标记、锁定标记和整行/单元格底色 |
| `RecordValue` | 记录与自定义字段的组合唯一；值以文本保存并由字段定义解释 |
| `ReportTemplate` / `Version` | 项目内模板名称唯一；版本号在模板内唯一；版本保存 DOCX 路径和占位符快照 |
| `ReportMapping` | 同一模板版本的占位符唯一；来源为字段、组合病理号、固定值、当前日期、实验编号、空白或未映射 |
| `LedgerTemplate` | 名称唯一；以 JSON 保存整套字段定义，供新建项目选择，不与具体项目绑定 |
| `AuditLog` | 保存 actor、动作、实体、详情 JSON 和 UTC 时间 |
| `AppSetting` | 以 key 保存 JSON 或字符串设置 |

SQLite 连接建立时执行 `PRAGMA foreign_keys=ON`，未启用 WAL。删除和更新通过外键、唯一约束及服务层校验共同保证一致性。核心业务规则包括：

- 锁定记录不能修改或删除；锁定/解锁操作本身可审计。
- 实验编号允许重复；批量编排允许记录来自多个项目，只校验记录存在、未锁定且仍为“待实验”，再按请求顺序在一个事务中写回编号。
- 病理号仍允许重复；项目开关开启时，新增和单元格批量预检只在当前项目内检查精确重复并产生可确认的 warning，不执行跨项目检查。
- 实验编排中的组合病理号由前端按 `pathology_number[-block_number]` 临时派生，用于编排显示、排序和 Excel 导出；报告映射选择 `pathology_with_block` 时由后端按同一规则临时生成。两者都不改台账中的病理号或蜡块号。
- 单元格粘贴、填充和查找替换先预检查字段类型、选项、预期旧值和锁定状态，再在一个事务中提交。
- 台账查询与 Excel 原生预览共享同一个搜索谓词（`services/records.py` 的 `record_search_filter`），单元格批量与原生预览共享同一个核心列映射（`core_record_value`），保证两边对关键字与核心字段的理解一致。

所有创建/更新时间和审计时间由应用以 UTC 生成；`experiment_date` 是不带时区的业务日期，展示和调度时转换为 `Asia/Shanghai`。

## 5. HTTP API

所有业务路由均挂载在 `/api` 下，FastAPI 自动生成 OpenAPI 描述。主要接口如下：

| 模块 | 路由 | 用途 |
|---|---|---|
| 系统 | `GET /api/health`；`GET /api/audit-logs`；`GET/PUT /api/settings/{key}` | 健康检查、审计查询、通用设置 |
| 统计 | `GET /api/dashboard/summary` | 统计面板汇总数据 |
| 项目 | `GET/POST /api/projects`；`PATCH/DELETE /api/projects/{project_id}`；`POST /api/projects/{project_id}/duplicate` | 项目列表、创建、编辑、删除、整项目复制 |
| 表头 | `GET/POST /api/projects/{project_id}/fields`；`POST /api/projects/{project_id}/fields/batch`；`PATCH/DELETE /api/projects/fields/{field_id}`；`PUT /api/projects/fields/{field_id}/options`；`PUT /api/projects/{project_id}/fields/reorder` | 动态字段、批量表头及选项管理 |
| 台账模板 | `GET/POST /api/ledger-templates`；`PATCH/DELETE /api/ledger-templates/{template_id}` | 台账表头模板的保存与维护 |
| 台账 | `GET/POST /api/records`；`GET/PATCH/DELETE /api/records/{record_id}`；`PUT /api/records/{record_id}/lock`；`PUT /api/records/report-status`；`PUT /api/records/{record_id}/cell`；`PUT /api/records/highlight`；`PUT /api/records/cell-highlights` | 记录查询、CRUD、相对目标行插入、锁定、报告标记、单格原子保存、整行与单元格底色 |
| 动态查询与批量单元格 | `POST /api/records/query`；`POST /api/records/query/ids`；`POST /api/records/cell-batches/preview`；`POST /api/records/cell-batches/commit`；`POST /api/records/replace/preview`；`POST /api/records/replace/commit` | 动态字段分批筛选排序、完整结果 ID、粘贴/填充与查找替换的预检查和原子提交 |
| 记录辅助 | `POST /api/records/by-ids`；`POST /api/records/operations/apply`；`POST /api/records/validate-new`；`POST /api/records/quick-create`；`POST /api/records/reorder-by-date/preview`；`POST /api/records/reorder-by-date/apply` | 按 ID 批量取数、批量操作应用、新增预校验、快速录入连续创建、按日期重排的预览与应用 |
| 编号 | `POST /api/records/experiment-numbers` | 实验编号原子回写 |
| 报告 | `GET/POST /api/report-templates`；`POST /api/report-templates/{template_id}/versions`；`PUT /api/report-template-versions/{version_id}/mappings`；`DELETE /api/report-templates/{template_id}`；`DELETE /api/report-template-versions/{version_id}`；`GET /api/printers`；`GET /api/print-engines`；`POST /api/reports/print`；`POST /api/report-template-versions/{version_id}/native-preview` | 模板版本、映射、打印机、直接打印和 Word/WPS 原生预览；前端默认按台账列表倒序提交所选记录，后端保持请求顺序逐份打印 |
| Excel | `POST /api/exports/workbook`；`POST /api/ledgers/{ledger_id}/native-preview`；`GET /api/native-preview/{job_id}`；`GET /api/preview/capabilities` | XLSX 生成、Word/WPS 原生预览与能力查询（导入已移除） |
| 数据库备份 | `GET/PUT /api/database-backups/settings`；`GET /api/database-backups/status`；`GET /api/database-backups`；`POST /api/database-backups/run`；`POST /api/database-backups/restore` | 自动备份设置、状态与历史、立即备份、重启恢复 |

另有隐藏端点 `POST /api/desktop/shutdown`（`include_in_schema=False`），供 Electron 退出流程携带 shutdown token 调用。

兼容记录列表 `GET /api/records` 支持项目（单个或 `project_ids` 多个）、状态、实验日期、报告状态、关键字、`scope`（current/all/selected）、`include_locked` 和 `limit/offset`。实验编排候选按 `status=待实验`、报告候选默认按 `report_generated=false` 在服务端过滤，前端再按 1000 条分页循环拉取，不再整表传输后在浏览器丢弃。主台账使用复杂查询接口，按 500–10,000 条的可配置批次（默认 2,000）循环读取当前查询的全部结果，再交给 Element Plus Table V2 做固定行高虚拟渲染；界面不暴露页码。查询支持动态字段筛选、排序、锁定记录可见性和按当前排序返回的完整 ID 集合。台账、实验编排、快速录入和报告候选列表均传 `include_locked=false`，统计和导出保持包含锁定记录。未指定字段排序时按项目内 `position` 返回；创建请求可用 `insert_before_record_id` 或 `insert_after_record_id` 指定相对插入位置，其他新增路径追加到末尾。新增记录保存后，主台账按 UUID 在完整结果中定位并通过虚拟表格滚动到该行。

显示范围通过独立的 `AppSetting` 键 `ledger_range_settings` 保存 `{version: 1, mode, months, count, includeUndated}`，默认 `mode="all"`，月份与条数上限分别为 120 和 10,000。`ledgerRangeSettings.ts` 按上海当天计算含边界的业务日期范围并处理月末钳位。复杂查询的 `include_undated` 仅扩展日期区间条件；`tail_count` 在所有筛选后、分页前生效，以反向排序取 ID 的子查询选择末尾集合，再恢复原排序，`total` 和 `/query/ids` 使用同一集合。字段排序的台账尾部选择以 `applyLedgerTableView` 的自然排序比较器为准：前端移除运输查询的 `tail_count`，分批读取全部匹配候选，再排序并截取末尾，避免 SQL 文本排序及空值顺序与显示不一致。因此启用字段排序后的 N 条限制目前只减少最终保留与显示记录，不减少候选传输量；默认固定行序及月份模式可在后端限制候选。

范围内记录修改后以 100ms 合并查询刷新；刷新等待保存和活动编辑完成，并在响应应用前再次检查待保存输入及缓存代次。脏单元格用增量集合判断，范围刷新不做全量 diff。切换范围设置具有独立的待应用状态，包括从限制范围切回全部显示，防止保存设置或查询期间的新编辑被覆盖；成功应用会清理选择并滚到末尾。本地草稿不参与截尾。手动 Excel 导出构造查询时省略显示范围，保留列筛选及独立导出日期范围。

网格逐格编辑使用 `PUT /records/{record_id}/cell` 一次往返完成“校验 + 旧值比对 + 写入”，写入前仍按 `expected_value` 做乐观并发校验。只有字段校验失败（422，返回结构化 `validation_error` 与问题列表）和病理号重复警告（409，`duplicate_warning`）需要用户处理：前者直接渲染“无法保存”面板，后者退回 `cell-batches` 预检查/提交以复用同一个确认面板。批量粘贴、填充、查找替换和快速录入仍走预检查/提交两段式。

主台账的 Table V2 行缓存为 2，与实验编排的默认值一致。虚拟列携带字段引用，按 ID 定位字段使用 computed Map；每格一次生成值、错误、保存状态、编辑标记和填充预览，复用于插槽。编辑器仅为活动编辑单元格挂载。行与文字滚动进入视口时直接显示，没有入场动画（原 WAAPI 动画已在 v2.3.4 移除）。

## 6. 文件处理与业务服务

`POST /records/query/ids` 始终返回当前查询范围的全部 ID，不分页；前端 ID 查询 wrapper 会剔除 `limit/offset`。查找替换预览显示范围记录数、可替换单元格数和锁定跳过数，单次最多 20,000 条 ID，超过上限会明确提示且不提交请求。预览样例只展示前 50 个单元格，实际提交使用完整预览 token。

### 6.1 XLSX

Excel 导入入口、API 和解析服务已移除；粘贴使用单元格批量预检/提交接口。

导出由 `backend/app/services/workbooks.py` 手写 Open XML 生成 XLSX，不依赖 openpyxl 等第三方库；请求模型限制最多 100 个工作表、每表 10,000 行/200 列、总计 2,000,000 个单元格。Electron 保存 IPC 将文件名规范化为 `.xlsx`，限制单次写入不超过 256 MiB，并要求用户确认保存路径。

台账原生预览与打开复用临时 XLSX 快照和 Office/WPS COM 服务。预览范围支持选中单元格、当前项目、当前筛选结果和整本台账；当前项目范围只按项目 UUID 取数，不继承页面搜索条件，并通过 `include_locked` 跟随台账“显示锁定记录”状态，关键字匹配与台账查询共用同一谓词。手动“导出 Excel”则固定包含锁定记录。

### 6.2 DOCX 与打印

`backend/app/services/docx_template.py` 用 zipfile + lxml 直接处理 DOCX Open XML，提取 `{{占位符}}` 并渲染替换值，不依赖 python-docx。模板上传默认上限为 20 MiB（`GENE_LEDGER_MAX_TEMPLATE_SIZE_MB` 可调整）；打印批次最多 100 条记录。`OfficePrintService` 将临时 DOCX 交给 COM 打印，API 返回打印数量和实际引擎，不返回文档字节。Word/WPS 引擎检测按注册表 ProgID 做结果缓存（`services/office_engines.py`，300 秒 TTL），打印与预览共用，健康检查不再每次读注册表。

### 6.3 完整业务备份与恢复

`DatabaseBackupScheduler` 默认每 1 小时使用 SQLite Online Backup API 取得一致性快照，并把 `ledger.db`、完整 `templates/` 和带 SHA-256 的 `manifest.json` 写入 `.glbkp` 压缩包。文件先在临时目录生成并校验，通过同目录 `.partial` 文件原子替换到目标位置，避免把半成品识别为有效备份。用户可在设置页选择任意可写的绝对备份目录、立即备份或选择备份包恢复。

备份按上海日期存入 `YYYY-MM-DD` 子目录。保留策略以“实际存在有效备份的日期”计数，而不是按当前日期向前减 7 个自然日：每个日期最多保留 30 份，只保留最近 7 个有备份的日期，因此默认上限为 210 份；两个参数可在设置页调整。即使软件每周只启动一天，上一次运行日也不会仅因跨过七个自然日而被清除。

桌面应用正常退出时会等待一次 `shutdown` 备份完成（可在设置页关闭）。恢复前先创建 `pre-restore` 安全备份，再校验压缩包路径、文件数量、解压大小、清单和哈希；恢复内容在受控临时目录中展开，并在后端下次启动、打开数据库之前替换数据库和模板。强制结束进程、断电及 Windows 无法通知应用的关机路径不保证触发退出备份。

## 7. 安全边界与并发行为

- 主窗口和快速录入 BrowserWindow 均使用 `contextIsolation=true`、`nodeIntegration=false`、`sandbox=true`；渲染进程只能使用 `preload.cjs` 暴露的白名单能力。
- 渲染器自行调用 `window.open` 仍会被拒绝，生产导航只允许打包入口及其 hash 路由。普通桌面 IPC 只接受主窗口发送者；打开快速录入只允许主窗口调用，返回主程序及变更通知只允许当前快速录入窗口调用。
- 剪贴板监听只允许快速录入窗口经主进程控制。helper 以行分隔 JSON 通过 stdio 通信，不启动 HTTP 服务、不打开业务数据库；事件按会话三元组（会话/项目/记录）校验，窗口隐藏、重载、关闭或进程异常退出都会使会话立即失效。
- 后端仅绑定 `127.0.0.1`，CORS 只允许 `null` 和本地 Vite origin。当前没有用户认证，文件系统和数据目录权限由 Windows 环境负责。
- 数据库备份使用异步锁避免定时、手动、恢复前和退出备份并发；批量单元格预览 token 在提交前原子认领，事务失败时释放、成功时消费；打印和编号回写均在服务层完成关键状态复核。

## 8. 配置、迁移与数据恢复

主要环境变量使用 `GENE_LEDGER_` 前缀并支持 `backend/.env`：`APP_NAME`、`DATA_DIR`、`DATABASE_URL`、`HOST`、`PORT`、`AUTO_CREATE_SCHEMA`、`MAX_TEMPLATE_SIZE_MB`、`AUDIT_LOG_RETENTION_DAYS`、`AUDIT_LOG_MAX_ROWS`。另有代码直读的 `GENE_LEDGER_DESKTOP_MODE`（桌面模式标记）和 `GENE_LEDGER_SHUTDOWN_TOKEN`（退出端点令牌）。桌面启动通过命令行参数覆盖数据目录、主机和端口。

迁移脚本位于 `backend/migrations/versions/`。旧版自动导出的 `auto_export_tasks`/`auto_export_runs` 表在迁移链末端被删除（`drop_auto_export_tables`），桌面建表路径同样移除；删除前会先生成带 `auto-export-removal` 标记的数据库副本，数据只保留在副本文件中，既有导出的 XLSX 文件不会被自动删除。日常完整业务备份同时包含数据库和报告模板，并支持从设置页恢复。重要数据仍建议再复制到另一块磁盘或受控网络位置。台账排序和筛选由通用 `AppSetting` 中的 `ledger_layout_settings` 按项目保存，表头顺序、宽度、隐藏和默认值由 `FieldDefinition` 管理。

普通开发后端的初始化流程由 `backend/run_backend.ps1` 执行：必要时 `uv sync --dev`，构建前端，执行迁移（含迁移前 SQLite 备份），运行 `alembic upgrade head`，再启动 `uvicorn app.main:app --host 127.0.0.1 --port 8000`。桌面 launcher 使用 `auto_create_schema=True`，不应把该行为误认为 `Settings` 的默认值。

## 9. 质量检查与发布

```powershell
cd backend
uv run ruff check .
uv run pytest

cd ../frontend
npm run typecheck
npm run test
npm run build
```

后端测试覆盖 API、数据库备份/恢复、桌面 launcher、DOCX 模板和单格保存，并验证已移除的自动导出 API 不再暴露；前端测试覆盖客户端、报告 API、数据库备份 API、病理号排序、实验 API 和数据操作 API。Electron JavaScript 用 `node --test electron/tests/*.cjs` 运行，可用 `node --check` 做语法检查。

`.github/workflows/windows-pyinstaller.yml` 是唯一的发布 workflow：Node 22 `npm ci` 并运行前端测试与构建，Python 3.13 `uv sync --all-groups --locked` 后运行 ruff 和 pytest，再按 `GeneLabLedger.spec` 用 PyInstaller 构建 sidecar 到 `dist/backend-sidecar`，最后 `npm run desktop:package` 由 electron-builder 生成 NSIS 安装包并发布 Release。除 CI 外，不在本机执行 PyInstaller 或安装包构建。Vite 构建内置 ECharts 堆叠柱补丁插件，补丁找不到注入锚点时构建报错；生产构建关闭 sourcemap。

## 10. 代码位置索引

```text
backend/app/main.py                     FastAPI 生命周期、路由挂载、静态前端
backend/app/config.py                   Settings 与业务目录
backend/app/database.py                 SQLAlchemy 引擎、SQLite 外键与建表
backend/app/models.py                   ORM 模型与约束
backend/app/api/system.py               健康、审计、设置与桌面关机
backend/app/api/projects.py             项目、动态字段、批量表头与选项
backend/app/api/records.py              台账、复杂查询、单元格批处理与编号回写
backend/app/api/exports.py              Excel 字节流导出
backend/app/api/preview.py              Excel/WPS 原生预览与能力查询
backend/app/api/reports.py              模板、映射、打印
backend/app/api/ledger_templates.py     台账表头模板
backend/app/api/dashboard.py            统计面板汇总
backend/app/api/database_backups.py     完整业务备份、历史与恢复
backend/app/services/records.py         共享搜索谓词与核心列映射
backend/app/services/workbooks.py       XLSX 生成（手写 Open XML）
backend/app/services/docx_template.py   DOCX 占位符处理（zipfile + lxml）
backend/app/services/cell_batches.py    单元格预检查、并发校验与原子提交
backend/app/services/database_backups.py SQLite 快照、打包、保留与恢复
backend/app/services/office_engines.py  Word/WPS 引擎检测与 TTL 缓存
backend/app/services/office_printing.py Word/WPS 打印
backend/app/services/office_preview.py  Excel/WPS 原生预览
backend/app/services/clipboard_listener.py 剪贴板监听（--clipboard-listener 独立模式）
backend/desktop/launcher.py             桌面 sidecar 入口
frontend/electron/main.cjs              Electron 生命周期与原生对话框
frontend/electron/preload.cjs           IPC 白名单桥接
frontend/electron/clipboard-follow.cjs  剪贴板 helper 进程与会话管理
frontend/src/router/index.ts            页面路由
frontend/src/views/QuickEntryView.vue   独立快速录入、病理号列表与剪贴板跟随
frontend/src/views/LedgerView.vue       台账容器：网格渲染、单元格编辑会话、粘贴提交与校验门禁
frontend/src/composables/               台账机制按关注点拆分的 composables：
                                        useLedgerContext（共享状态底座）、
                                        useLedgerRecords（分页拉取、缓存世代、请求票据与 loadRecords 编排）、
                                        useLedgerGridSelection（选区状态与操作）、
                                        useGridPointerDrag（拖拽、rAF 帧合并与边缘自动滚动）、
                                        useGridFillDrag（填充柄拖拽与预览）、
                                        useLedgerCellSaveState（保存五态、乐观锁版本与串行队列）、
                                        useLedgerCellSave（单格保存管线：校验、原子保存、两段式降级）、
                                        useLedgerValidationPanel（校验确认面板状态与双路提交）、
                                        useLedgerGridClipboard（复制/剪切与四重剪切快照）、
                                        useLedgerFindReplace（查找替换状态、匹配与两段式提交）、
                                        useLedgerRangeRefresh（100ms 去抖范围刷新调度）、
                                        useLedgerDraftRows / useLedgerPersistDraft（插入草稿与持久化定位）
frontend/src/components/ledger/         台账区块组件（props/emit 纯展示）：
                                        CommandCard、HighlightDialog、ContextMenu、
                                        FindReplaceDialog、SelectionBar、ValidationDialog、
                                        ReorderDialog、ExportPanel
frontend/src/utils/gridSelectionModel.ts  网格坐标纯函数与单元格键编解码
frontend/src/utils/nativePreviewJob.ts  台账/报告共享的原生预览能力与任务轮询
frontend/src/utils/quickEntry.ts        快捷字段配置、值规范化和提交载荷
frontend/src/utils/clipboardFollow.ts   剪贴板跟随状态机
frontend/src/utils/ledgerLayoutSettings.ts 按项目保存台账排序和筛选
frontend/src/utils/ledgerRangeSettings.ts  台账显示范围计算
frontend/src/utils/ledgerClipboard.ts   台账选区复制载荷与跨应用文本矩阵
frontend/src/views/                    其余业务页面
frontend/tests/file-size-guard.spec.ts 文件体量守卫（容器 ≤6800 行、组件 ≤400、composable ≤800）
```
