# 后端

FastAPI sidecar 负责台账、实验编号编排、报告直接打印、XLSX 导入导出、自动导出和审计。桌面窗口、目录选择及“另存为”属于 Electron 主进程，不由后端弹出 GUI。

## 本地启动

```powershell
uv sync --all-groups
uv run alembic upgrade head
uv run uvicorn app.main:app --host 127.0.0.1 --port 8000
```

开发模式默认使用 `backend/data`，也可设置 `GENE_LEDGER_DATA_DIR`。Electron 则总是显式传入用户选择的数据目录：

```powershell
uv run python desktop/launcher.py --host 127.0.0.1 --port 54321 --data-dir D:\GeneLedgerData
```

## 数据与临时文件

- `ledger.db`：SQLite 数据库
- `templates/`：永久 DOCX 模板版本
- `temp/reports/`：直接打印期间的临时 DOCX，打印结束立即删除
- `exports/`：自动导出的默认目录；每个任务可配置其他绝对目录

手动导出的 XLSX 由后端生成字节流，再交给 Electron Windows“另存为”。自动导出由后端直接写入任务目录并执行保留策略。

## 主要接口

- `/api/records`：独立 UUID 台账记录 CRUD、锁定、项目复制、报告状态
- `/api/records/bulk-delete/*`：按日期范围预览和原子批量删除
- `/api/experiments/plans/*`：无日期实验编排单、排序与编号回写
- `/api/imports/workbook/*`：XLSX 预览与提交
- `/api/exports/workbook`：XLSX 生成
- `/api/report-templates`、`/api/reports/print`：模板与直接打印；无报告下载接口
- `/api/auto-export/*`：定时任务、重试、运行历史与保留策略

## 验证

```powershell
uv run ruff check .
uv run pytest
```

不要在本地运行 Nuitka 或 PyInstaller；两套打包均在 GitHub Actions 中验证。
