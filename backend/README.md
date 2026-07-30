# 后端架构

## 技术选择

- Python 3.13
- FastAPI
- SQLAlchemy 2 + SQLite
- Alembic
- pywin32：Microsoft Word / WPS COM 自动化打印
- pywebview：Windows 桌面窗口与生命周期

## 本地启动

```powershell
uv sync --dev
uv run alembic upgrade head
uv run uvicorn app.main:app --host 127.0.0.1 --port 8000
```

依赖安装完成后，也可以双击 `start_backend.cmd` 启动。

系统页面：`http://127.0.0.1:8000/`

接口文档：`http://127.0.0.1:8000/docs`

首次启动只创建 `TB`、`BRAFV600E` 两个项目和“日期、病理号、状态”三个核心字段，
不会写入演示台账记录。

## 文件目录

- `data/ledger.db`：SQLite 数据库
- `data/templates/`：永久保存的 Word 模板版本
- `data/temp/reports/`：生成或打印期间使用的临时 DOCX；响应完成后立即删除
- `data/exports/`：自动导出的默认目录；可在每个任务中改为其他 Windows 绝对路径

## 当前前端已接入

- 项目、项目顺序和独立表头
- 表头增删、顺序、列宽和备选项
- 台账新增、直接编辑/粘贴、批量状态、整行锁定
- 同一病理号关联多个项目
- 按实验日期读取与保存实验编排、重复实验
- Word 模板版本、占位符映射、批量 Word 生成与 Office 直接打印
- 实验编排导出表头设置
- 多个自动导出任务：预设周期或 5 段 Cron、失败重试、成功文件保留份数、XLSX/XLS
- 日志审计列表与关键词搜索

新版前端的安装、构建与检查命令见 `../frontend/README.md`。修改新版前端源码后，
先在 `frontend` 目录运行 `npm.cmd run build`，FastAPI 会直接提供新的生产构建。
