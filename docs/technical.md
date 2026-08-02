# 基因检测台账管理系统 — 技术文档

> 本文档描述当前已完成版本的实现、边界和运维方式。接口、路径和限制以仓库代码为准。

## 1. 总体架构

```text
Electron 主进程
  ├─ 单实例与窗口生命周期
  ├─ 随机 loopback 端口
  ├─ 原生保存/选目录对话框
  ├─ 白名单 IPC 与发送者校验
  └─ 启动 Python sidecar
        └─ FastAPI / Uvicorn（127.0.0.1:<随机端口>）
              ├─ SQLAlchemy 2 + SQLite
              ├─ DOCX Open XML + Word/WPS COM 打印
              ├─ XLSX Open XML 解析与生成
              └─ asyncio 自动导出调度器
```

Electron 负责桌面边界和文件对话框，Vue 前端只通过 HTTP API 和 preload 暴露的少量桌面能力工作。后端在启动时初始化目录、数据库会话、打印服务和自动导出调度器；退出时停止调度器、打印服务和数据库连接。

生产桌面版从 `frontend/dist/index.html` 加载 hash 路由；开发模式由 Vite `127.0.0.1:5173` 提供页面并代理 `/api`。后端构建了前端静态目录时也可直接提供 `/`，旧的 `/app` 路径重定向到根路径。

## 2. 技术栈

| 层级 | 实现 |
|---|---|
| 桌面容器 | Electron 43、electron-builder、NSIS |
| 前端 | Vue 3、TypeScript、Vite 7、Pinia、Vue Router |
| UI | Element Plus、Tailwind CSS 4（未启用 Preflight）；台账主表格使用 Univer 0.25.1 |
| 后端 | Python 3.13、FastAPI、Uvicorn、Pydantic v2 |
| 持久化 | SQLAlchemy 2、SQLite、Alembic |
| Excel | 标准库 `zipfile`/XML 的 XLSX 读取与写入 |
| 文档与打印 | DOCX Open XML、pywin32 COM、Word/WPS |
| 任务 | Python `asyncio` 自动导出调度器 |
| 测试与质量 | pytest、HTTPX、Vitest/jsdom、vue-tsc、Ruff |
| Windows 发布 | GitHub Actions、Nuitka 或 PyInstaller sidecar、Electron 安装包 |

## 3. 启动模式与目录布局

### 3.1 Electron 桌面启动

`frontend/electron/main.cjs` 的启动顺序如下：

1. 获取单实例锁，读取 `app.getPath("userData")/settings/desktop-settings.json` 中的绝对 `dataDirectory`。
2. 首次启动通过原生目录选择框取得业务数据目录；取消选择则退出。
3. 申请空闲的 `127.0.0.1` 端口，开发模式启动 `backend/desktop/launcher.py`，打包模式启动 `resources/backend/GeneLabLedgerBackend.exe`。
4. 通过命令行传递 `--host`、`--port`、`--data-dir`，轮询 `/api/health`，最多等待 20 秒。
5. 创建启用 `contextIsolation`、禁用 `nodeIntegration`、启用 `sandbox` 的 `BrowserWindow`，把后端地址和数据目录作为 preload 参数传入。

桌面 launcher 显式设置 `auto_create_schema=True`，因此桌面首次运行可以直接创建当前 ORM 结构。`backend/app/config.py` 中的默认值是 `False`；直接以 `app.main:app` 运行的开发/服务进程应先执行 Alembic 迁移。

### 3.2 业务数据目录

```text
<data_dir>/
├─ ledger.db                         SQLite 数据库
├─ templates/<template_id>/vN.docx   报告模板版本
├─ temp/reports/<print-id>/          打印期间的临时 DOCX
└─ exports/                          默认自动导出目录
```

设置页更换目录只原子更新桌面设置文件，重启后生效，不搬移旧数据库或模板。后端 `Settings.ensure_directories()` 负责创建上述目录；自动导出任务可以写入任意已选择的绝对目录。

## 4. 数据模型与完整性

```text
Project
  ├─ FieldDefinition ── FieldOption
  ├─ ProjectRecord ── RecordValue
  └─ ReportTemplate ── ReportTemplateVersion ── ReportMapping

AutoExportTask ── AutoExportRun
AuditLog
AppSetting
```

| 模型 | 关键字段与约束 |
|---|---|
| `Project` | UUID 主键；名称唯一；保存顺序和是否参与实验编排 |
| `FieldDefinition` | 项目内 `key`、`system_key` 唯一；支持 text/number/date/select；核心字段不可删除 |
| `FieldOption` | 同一字段的选项值唯一，保存排序 |
| `ProjectRecord` | UUID 主键；`pathology_number` 可重复并建索引；`experiment_number` 非空时全库唯一；保存状态、实验日期、报告标记和锁定标记 |
| `RecordValue` | 记录与自定义字段的组合唯一；值以文本保存并由字段定义解释 |
| `ReportTemplate` / `Version` | 项目内模板名称唯一；版本号在模板内唯一；版本保存 DOCX 路径和占位符快照 |
| `ReportMapping` | 同一模板版本的占位符唯一；来源为字段、固定值、当前日期、实验编号、空白或未映射 |
| `AutoExportTask` / `Run` | 任务名唯一；保存项目、绝对目录、周期、重试、保留和下一次运行时间；每次运行独立记录状态和文件路径 |
| `AuditLog` | 保存 actor、动作、实体、详情 JSON 和 UTC 时间 |
| `AppSetting` | 以 key 保存 JSON 或字符串设置 |

SQLite 连接建立时执行 `PRAGMA foreign_keys=ON`，未启用 WAL。删除和更新通过外键、唯一约束及服务层校验共同保证一致性。核心业务规则包括：

- 锁定记录不能修改、导入覆盖或删除；锁定/解锁操作本身可审计。
- 实验编号批量回写先将目标旧编号置为 `NULL` 并 `flush`，再写入新编号，避免交换编号触发唯一约束。
- Excel 导入提交会重新校验项目归属、UUID、锁定状态和全库实验编号冲突，并在一个事务中写入记录值和审计。
- 批量删除执行时比较预览得到的完整 UUID 集合；集合变化或包含锁定记录即拒绝执行。

所有创建/更新时间和审计时间由应用以 UTC 生成；`experiment_date` 是不带时区的业务日期，展示和调度时转换为 `Asia/Shanghai`。

## 5. HTTP API

所有业务路由均挂载在 `/api` 下，FastAPI 自动生成 OpenAPI 描述。主要接口如下：

| 模块 | 路由 | 用途 |
|---|---|---|
| 系统 | `GET /api/health`；`GET /api/audit-logs`；`GET/PUT /api/settings/{key}` | 健康检查、审计查询、通用设置 |
| 项目 | `GET/POST /api/projects`；`PATCH/DELETE /api/projects/{project_id}` | 项目列表、创建、编辑、删除 |
| 表头 | `GET/POST /api/projects/{project_id}/fields`；`PATCH/DELETE /api/projects/fields/{field_id}`；`PUT /api/projects/fields/{field_id}/options`；`PUT /api/projects/{project_id}/fields/reorder` | 动态字段及选项管理 |
| 台账 | `GET/POST /api/records`；`GET/PATCH/DELETE /api/records/{record_id}`；`PUT /api/records/{record_id}/lock`；`POST /api/records/{record_id}/assign-project`；`PUT /api/records/report-status` | 记录查询、CRUD、锁定、分配项目、报告标记 |
| 编号与批删 | `POST /api/records/experiment-numbers`；`POST /api/records/bulk-delete/preview`；`POST /api/records/bulk-delete/execute` | 实验编号原子回写、预览/执行批量删除 |
| 报告 | `GET/POST /api/report-templates`；`POST /api/report-templates/{template_id}/versions`；`PUT /api/report-template-versions/{version_id}/mappings`；`DELETE /api/report-templates/{template_id}`；`GET /api/printers`；`GET /api/print-engines`；`POST /api/reports/print` | 模板版本、映射、打印机和直接打印 |
| Excel | `POST /api/exports/workbook`；`POST /api/imports/workbook/preview`；`POST /api/imports/workbook/commit` | XLSX 生成、预览导入、原子提交 |
| 自动导出 | `GET /api/auto-export/config`；`GET/POST /api/auto-export/tasks`；`PUT/DELETE /api/auto-export/tasks/{task_id}`；`POST /api/auto-export/tasks/{task_id}/run`；`GET /api/auto-export/tasks/{task_id}/runs`；`POST /api/auto-export/validate-cron` | 任务配置、立即执行、历史查询、Cron 校验 |

记录列表支持项目、状态、实验日期、报告状态、关键字、`limit/offset` 分页；默认 `limit=100`，最大 1,000。

## 6. 文件处理与业务服务

### 6.1 XLSX

`backend/app/services/workbook_import.py` 直接读取 ZIP 内的 workbook relationships、shared strings、inline strings、布尔和数字单元格，不把上传包解压到磁盘。导入按表头映射到核心/自定义字段，预览阶段产出逐行 `create/update/errors`，提交阶段由 `backend/app/api/imports.py` 负责二次校验和事务。

导出由 `backend/app/services/workbooks.py` 生成 XLSX；请求模型限制最多 100 个工作表、每表 10,000 行/200 列、总计 2,000,000 个单元格。Electron 保存 IPC 将文件名规范化为 `.xlsx`，限制单次写入不超过 256 MiB，并要求用户确认保存路径。

### 6.2 DOCX 与打印

`backend/app/services/docx_template.py` 从 DOCX Open XML 提取占位符并渲染替换值。模板上传默认上限为 20 MiB（`GENE_LEDGER_MAX_TEMPLATE_SIZE_MB` 可调整）；打印批次最多 100 条记录。`OfficePrintService` 查询可用 Word/WPS 引擎并将临时 DOCX 交给 COM 打印，API 返回打印数量和实际引擎，不返回文档字节。

### 6.3 自动导出

`AutoExportScheduler` 启动时先把上次遗留的 `running` 运行标记为失败，再为启用任务补齐 `next_run_at`；主循环每 20 秒查找到期任务。周期计算先在 `Asia/Shanghai` 本地时间进行，再转成 UTC 保存。失败重试次数由任务配置控制；成功后按保留数量删除同一任务更早的成功文件，删除前校验文件仍在任务目录内。

## 7. 安全边界与并发行为

- BrowserWindow 使用 `contextIsolation=true`、`nodeIntegration=false`、`sandbox=true`；渲染进程只能使用 `preload.cjs` 暴露的保存工作簿、选择目录、切换数据目录和重启方法。
- 主进程拒绝新窗口，生产导航只允许打包入口；每个 IPC handler 校验发送者必须是当前主窗口。
- 后端仅绑定 `127.0.0.1`，CORS 只允许 `null` 和本地 Vite origin。当前没有用户认证，文件系统和数据目录权限由 Windows 环境负责。
- 自动导出同一任务使用运行中集合避免重复执行；打印、导入、批删和编号回写均在服务层完成关键状态复核。

## 8. 配置、迁移与数据恢复

主要环境变量使用 `GENE_LEDGER_` 前缀：`DATA_DIR`、`DATABASE_URL`、`HOST`、`PORT`、`AUTO_CREATE_SCHEMA`、`MAX_TEMPLATE_SIZE_MB`、`AUDIT_LOG_RETENTION_DAYS`、`AUDIT_LOG_MAX_ROWS`。桌面启动通过命令行参数覆盖数据目录、主机和端口。

迁移脚本位于 `backend/migrations/versions/`。当前迁移链包含初始结构、工作流字段、自动导出任务以及 `f3b7c9d2e410`；最后一个迁移删除旧的实验批次/运行和 Case 结构，将病理号写入 `project_records`，且明确不提供 downgrade。对已有数据库执行前必须备份 `ledger.db` 和 `templates/`。

普通开发后端的初始化流程由 `backend/run_backend.ps1` 执行：必要时 `uv sync --dev`，构建前端，运行 `alembic upgrade head`，再启动 `uvicorn app.main:app --host 127.0.0.1 --port 8000`。桌面 launcher 使用 `auto_create_schema=True`，不应把该行为误认为 `Settings` 的默认值。

## 9. 质量检查与发布

```powershell
cd backend
uv run ruff check .
uv run pytest --basetemp=..\\.pytest-tmp\\backend

cd ../frontend
npm run typecheck
npm run test -- --run
npm run build
npm run desktop:package
```

后端测试覆盖 API、自动导出、桌面 launcher、DOCX 模板和现代前端集成；前端测试覆盖客户端、报告 API、病理号排序、实验 API 和数据操作 API。Electron JavaScript 可用 `node --check` 做语法检查。

`.github/workflows/windows-release.yml` 使用 Nuitka 构建 Python sidecar，`.github/workflows/windows-pyinstaller.yml` 使用 PyInstaller；两条流水线都将 sidecar 放入 Electron `extraResources/backend`，再由 electron-builder 生成 NSIS 安装包。本机打包时使用同样的 sidecar 目录布局。

## 10. 代码位置索引

```text
backend/app/main.py                    FastAPI 生命周期、路由挂载、静态前端
backend/app/config.py                  Settings 与业务目录
backend/app/database.py                SQLAlchemy 引擎与 SQLite 外键
backend/app/models.py                  ORM 模型与约束
backend/app/api/system.py              健康、审计、设置
backend/app/api/projects.py            项目、动态字段与选项
backend/app/api/records.py             台账、编号、锁定、批量删除
backend/app/api/imports.py              Excel 预览与提交
backend/app/api/exports.py              Excel 字节流导出
backend/app/api/reports.py              模板、映射、打印
backend/app/api/auto_exports.py         自动导出任务与运行历史
backend/app/services/workbook_import.py XLSX 解析
backend/app/services/workbooks.py       XLSX 生成
backend/app/services/docx_template.py   DOCX 占位符处理
backend/app/services/auto_exports.py    调度、执行、重试、保留
backend/app/services/office_printing.py Word/WPS 打印
backend/desktop/launcher.py             桌面 sidecar 入口
frontend/electron/main.cjs              Electron 生命周期与原生对话框
frontend/electron/preload.cjs           IPC 白名单桥接
frontend/src/router/index.ts            页面路由
frontend/src/components/UniverLedgerGrid.vue Univer 台账 workbook 与 API 映射
frontend/src/views/                    各业务页面
```
