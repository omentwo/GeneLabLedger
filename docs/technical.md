# 基因检测台账管理系统 — 技术设计

## 1. 运行架构

```text
Electron main
  ├─ single instance
  ├─ BrowserWindow (sandbox + contextIsolation)
  ├─ preload allowlist IPC
  ├─ Windows Save/Open Directory dialogs
  └─ spawn Python sidecar
        └─ FastAPI/Uvicorn @ 127.0.0.1:<random>
              ├─ SQLAlchemy / SQLite
              ├─ DOCX Open XML + Word/WPS print worker
              ├─ XLSX Open XML import/export
              └─ auto-export scheduler
```

生产前端通过 `file://.../dist/index.html` 和 hash 路由加载；开发前端由 Vite 提供并代理 `/api`。Electron 将随机后端 URL和当前数据目录通过 `additionalArguments` 交给 preload。后端允许 `null` 文件源及两个本地 Vite origin 的 CORS，请求仍只能到 loopback。

主进程拒绝新窗口，生产导航只允许确切的打包入口，IPC 验证发送者必须是主窗口。渲染进程没有 Node.js 权限。

## 2. 技术栈

| 层级 | 实现 |
|---|---|
| 桌面 | Electron 43、electron-builder、NSIS |
| 前端 | Vue 3、TypeScript、Vite 7、Pinia、Vue Router |
| UI | Element Plus + Tailwind CSS 4（无 Preflight） |
| 后端 | Python 3.13、FastAPI、Uvicorn、Pydantic v2 |
| 数据 | SQLAlchemy 2、SQLite、Alembic |
| Office | DOCX Open XML、pywin32 COM Word/WPS 打印 |
| Excel | 标准库 zipfile/XML 的 XLSX 写入和读取 |
| 测试 | pytest/HTTPX、Vitest/jsdom、vue-tsc、Ruff |
| 发布 | GitHub Actions：Nuitka 或 PyInstaller sidecar + Electron |

## 3. 数据目录与启动

Electron 设置文件位于 Electron `userData/settings/desktop-settings.json`，只保存绝对 `dataDirectory`。首次启动若没有配置，必须通过原生目录选择框获得用户选择。

Python sidecar 入口：

```text
GeneLabLedgerBackend.exe --host 127.0.0.1 --port <port> --data-dir <absolute-path>
```

`Settings` 由 `data_dir` 推导：

```text
<data_dir>/ledger.db
<data_dir>/templates/
<data_dir>/temp/reports/
<data_dir>/exports/
```

设置页更改目录只原子写配置，重启后生效，不迁移旧数据。

## 4. 核心数据模型

```text
Project
  ├─ FieldDefinition ── FieldOption
  ├─ ProjectRecord ── RecordValue
  └─ ReportTemplate ── ReportTemplateVersion ── ReportMapping

ExperimentPlan ── ExperimentPlanItem ── ProjectRecord
AutoExportTask ── AutoExportRun
AuditLog
AppSetting
```

### ProjectRecord

| 字段 | 说明 |
|---|---|
| `id` | UUID 主键 |
| `project_id` | 所属项目 |
| `pathology_number` | 普通可重复字段，带查询索引 |
| `status` | 待实验/已完成，用户手工维护 |
| `experiment_date` | 台账实验日期，与编排无关联 |
| `experiment_number` | 可空、全局唯一；台账 UI 只读 |
| `report_generated` | 独立人工标记 |
| `locked` | 写入和删除保护 |

不存在 `Case` 表或 `(case_id, project_id)` 唯一关系。同病理号记录之间没有数据库关联。

### ExperimentPlan / ExperimentPlanItem

`ExperimentPlan` 保存自由 `prefix` 和最近回写时间。条目通过 `(plan_id, record_id)` 与 `(plan_id, position)` 唯一约束维护顺序。显示编号在序列化时计算为 `{prefix}-{position}`，计划表不另存一份实验编号。

回写事务：

1. 再次确认所有条目状态为“待实验”；
2. 计算编号长度与编排外冲突；
3. 将目标记录旧编号暂置 NULL 并 flush，避免交换顺序触发唯一约束；
4. 写入最终编号、更新时间与审计；
5. 不修改状态、日期或编排条目。

## 5. API

### Records

- `GET/POST /api/records`
- `GET/PATCH/DELETE /api/records/{record_id}`
- `PUT /api/records/{record_id}/lock`
- `POST /api/records/{record_id}/assign-project`
- `PUT /api/records/report-status`
- `POST /api/records/bulk-delete/preview`
- `POST /api/records/bulk-delete/execute`

### Experiment plans

- `GET/POST /api/experiments/plans`
- `GET/PATCH/DELETE /api/experiments/plans/{plan_id}`
- `POST /api/experiments/plans/{plan_id}/items`
- `DELETE /api/experiments/plans/{plan_id}/items/{item_id}`
- `PUT /api/experiments/plans/{plan_id}/order`
- `POST /api/experiments/plans/{plan_id}/apply`

### Import/export

- `POST /api/exports/workbook`
- `POST /api/imports/workbook/preview`（multipart）
- `POST /api/imports/workbook/commit`

工作簿隐藏列用 1 起始序号写入 `<cols hidden="1">`。导入读取 workbook relationships、shared strings、inline strings、布尔和数字单元格，不解压文件到磁盘；限制单成员 50 MiB、总解压 100 MiB、上传 20 MiB。

预览按字段 label/key 映射。UUID 决定 create/update，commit 重新验证项目、锁、UUID 和实验编号，并在单事务中写记录值与审计。

### Reports

- 模板、版本与映射接口保留。
- `GET /api/printers`
- `GET /api/print-engines`
- `POST /api/reports/print`

没有报告文档下载接口。`print-*` 临时目录在 `finally` 中删除。

### Auto export

自动任务 API 保留 CRUD、立即执行、运行历史和 Cron 校验。后端不再提供 tkinter 目录选择；目录由 Electron IPC 获取后作为普通字符串保存。

## 6. Excel 保存边界

`/api/exports/workbook` 只生成 XLSX 字节。前端调用 `exportWorkbook`：

- Electron：把 ArrayBuffer 发给 `gene-ledger:save-workbook`；主进程验证大小和文件名，调用 `showSaveDialog`，再写入确认后的路径。
- 浏览器开发：创建 Blob URL 和 `<a download>` 回退。

自动导出完全不走这条 IPC，由后端写任务目录。

## 7. 日期与时区

- `Asia/Shanghai`：报告 current_date、自动任务调度/命名、统计面板当前日期、创建/更新日期批删边界、界面时间显示。
- UTC：数据库 `created_at/updated_at`、审计和任务时间戳。
- `experiment_date` 是不含时区的业务日期。

## 8. 数据库迁移

`f3b7c9d2e410` 是测试阶段的破坏性结构迁移：删除旧 ExperimentBatch/ExperimentRun，复制 Case 病理号到 ProjectRecord，移除 Case，并创建 ExperimentPlan 表。旧测试数据库会在本次重构后删除；该迁移不提供 downgrade，禁止把它直接用于未备份的生产数据。

新安装由 `auto_create_schema=True` 创建当前结构。开发环境可使用 Alembic：

```powershell
cd backend
uv run alembic upgrade head
```

## 9. 测试与发布

完成所有代码修改后统一运行：

```powershell
cd backend
uv run ruff check .
uv run pytest

cd ../frontend
npm run typecheck
npm run test
npm run build
```

Electron JavaScript可额外使用 `node --check` 做语法检查。不得在本机执行 Nuitka、PyInstaller 或 Electron 安装包构建。

GitHub 工作流：

- `windows-release.yml`：Nuitka standalone sidecar → `backend/dist/backend-sidecar` → electron-builder。
- `windows-pyinstaller.yml`：PyInstaller spec sidecar → 同一目录 → electron-builder。

二者发布不同命名的安装包资产，验证两个 Python 打包路径都能装入相同 Electron 壳。

## 10. 代码位置

```text
backend/app/models.py                 ORM
backend/app/api/records.py            台账与批删
backend/app/api/experiments.py        实验编排单
backend/app/api/imports.py            Excel 导入
backend/app/api/exports.py            Excel 字节流
backend/app/api/reports.py            模板与直接打印
backend/app/services/workbook_import.py XLSX 读取
backend/desktop/launcher.py           Python sidecar
frontend/electron/main.cjs            Electron 生命周期与原生对话框
frontend/electron/preload.cjs         白名单桥接
frontend/src/views/LedgerView.vue     台账、导入、批删
frontend/src/views/ExperimentsView.vue 编排与导出
frontend/src/views/SettingsView.vue   数据目录
```
