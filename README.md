# Gene Lab Ledger

面向 Windows 单机实验室的基因检测台账应用。生产桌面版采用 Electron 承载 Vue 前端，并启动一个只监听 `127.0.0.1` 随机端口的 Python/FastAPI sidecar。

## 架构

```text
Electron 主进程
  ├─ 原生目录选择 / Excel“另存为” / 单实例 / Python 进程生命周期
  ├─ Vue 3 + TypeScript + Tailwind CSS + Element Plus
  └─ HTTP → FastAPI → SQLAlchemy → SQLite
                         ├─ DOCX 模板渲染 → Word/WPS 直接打印
                         ├─ XLSX 导入、手动导出与自动导出
                         └─ 审计日志与自动导出调度器
```

Electron 使用 `contextIsolation`、沙箱 preload 和白名单 IPC。后端地址及当前数据目录只通过启动参数暴露给渲染进程，页面不能直接访问 Node.js。

## 当前业务规则

- 每条 `ProjectRecord` 都有独立 UUID；病理号只是普通字段，可重复。修改一条记录不会联动任何同病理号记录。
- “待实验/已完成”由用户在台账手工维护。只有“待实验”记录能加入实验编排。
- 实验编排没有日期批次。用户自由填写前缀，条目按顺序显示为 `{前缀}-1`、`{前缀}-2`；点击回写只更新台账实验编号，不改日期、状态，也不锁定或关闭编排单。
- 手动 Excel 导出在 Electron 中打开 Windows“另存为”，可改名、选择目录和确认覆盖。浏览器开发模式保留普通浏览器下载作为回退。
- 自动导出继续由任务配置输出目录、自动命名、失败重试和保留策略；目录通过 Electron 原生选择框设置。
- 报告不再提供 DOCX/ZIP 下载。打印时在数据目录下生成临时 DOCX，提交给 Word/WPS 后立即清理。
- 台账可预览并导入本系统导出的 XLSX。隐藏的记录 UUID 决定精确更新；没有 UUID 的行新建记录，绝不按病理号猜测或合并。
- 台账支持按实验日期、创建日期或更新日期预览并批量删除；锁定记录阻止执行，提交时会重新校验预览 UUID。
- 当前日期、定时任务和日期范围边界统一按 `Asia/Shanghai` 解释，数据库时间戳仍以 UTC 存储。

## 数据目录

Electron 首次启动必须由用户选择业务数据目录，其中包含：

```text
<用户选择的目录>/
├─ ledger.db
├─ templates/
├─ temp/reports/
└─ exports/
```

“数据与设置”页可保存新的目录并重启切换。切换不会复制、移动或删除原数据库；用户可通过重新选择原目录切回。

## 开发

```powershell
cd backend
uv sync --all-groups
uv run uvicorn app.main:app --host 127.0.0.1 --port 8000

cd ../frontend
npm install
npm run dev
```

前端开发服务器将 `/api` 代理到 `127.0.0.1:8000`。桌面联调使用 `npm run desktop`，可通过 `GENE_LEDGER_PYTHON` 指定 Python。

常规验证：

```powershell
cd backend
uv run ruff check .
uv run pytest

cd ../frontend
npm run typecheck
npm run test
npm run build
```

Nuitka 与 PyInstaller 打包仅由 GitHub Actions 验证：

- `.github/workflows/windows-release.yml`：Nuitka sidecar + Electron 安装包
- `.github/workflows/windows-pyinstaller.yml`：PyInstaller sidecar + Electron 安装包

## 技术栈

| 层级 | 技术 |
|---|---|
| 桌面容器 | Electron |
| 前端 | Vue 3、TypeScript、Vite、Tailwind CSS、Element Plus、Pinia |
| 后端 | Python 3.13、FastAPI、Uvicorn、Pydantic |
| 数据 | SQLAlchemy 2、Alembic、SQLite |
| 文档 | DOCX/Open XML、Word/WPS COM 直接打印 |
| Excel | XLSX/Open XML 导入与导出 |
| 验证 | pytest、HTTPX、Vitest、Playwright、Ruff、vue-tsc |
