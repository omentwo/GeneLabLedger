# Gene Lab Ledger

## 总体架构

```text
┌──────────────────────────────────────────────────────────────┐
│ Windows 桌面进程                                             │
│                                                              │
│  pywebview / WebView2                                        │
│       │                                                      │
│       │ HTTP（仅 127.0.0.1 随机端口）                         │
│       ▼                                                      │
│  FastAPI ───────── SQLAlchemy ───────── SQLite               │
│       │                    │                                  │
│       │                    ├─ Alembic 数据库迁移              │
│       │                    └─ 审计日志                         │
│       │                                                      │
│       ├─ Vue 3 静态资源                                      │
│       ├─ DOCX Open XML 模板渲染                              │
│       ├─ XLSX Open XML 导出                                  │
│       ├─ Windows 打印机枚举                                  │
│       └─ Office 自动化打印                                   │
│            ├─ Microsoft Word：Word.Application               │
│            └─ WPS：kwps.application                          │
└──────────────────────────────────────────────────────────────┘
```

前端生产构建由 FastAPI 同源提供。桌面启动器负责选择本机端口、启动后端、创建桌面窗口，并在窗口关闭时停止后端及进程内调度器。

## 技术栈

| 层级 | 技术 |
|---|---|
| 桌面容器 | pywebview、Windows WebView2 |
| 前端 | Vue 3、TypeScript、Vite、Vue Router、Pinia、Element Plus |
| 后端 | Python 3.13、FastAPI、Uvicorn、Pydantic |
| 数据访问 | SQLAlchemy 2、Alembic、SQLite |
| Word | DOCX/Open XML 占位符渲染、Microsoft Word/WPS COM 自动化 |
| Excel | XLSX/Open XML |
| 测试 | pytest、HTTPX、Vitest、Playwright |
| 质量检查 | Ruff、vue-tsc |

## 目录结构

```text
gene-lab-ledger-enhanced/
├─ backend/
│  ├─ app/
│  │  ├─ api/                 REST 接口
│  │  ├─ services/            文档、打印、导出和调度服务
│  │  ├─ models.py            ORM 模型
│  │  ├─ schemas.py           API 数据结构
│  │  ├─ database.py          数据库会话
│  │  └─ main.py              FastAPI 生命周期与静态资源入口
│  ├─ desktop/
│  │  └─ launcher.py          Windows 桌面生命周期入口
│  ├─ migrations/             Alembic 迁移
│  └─ tests/                  后端测试
├─ frontend/
│  ├─ src/
│  │  ├─ api/                 API 客户端
│  │  ├─ components/          通用组件
│  │  ├─ layouts/             桌面布局
│  │  ├─ stores/              Pinia 状态
│  │  ├─ views/               页面模块
│  │  └─ router/              客户端路由
│  └─ tests/                  前端测试
└─ README.md
```

## 运行时边界

- HTTP 服务只绑定 `127.0.0.1`，不监听局域网地址。
- 前端与后端位于同一桌面进程生命周期内。
- SQLite、模板及导出配置保存到 `%LOCALAPPDATA%\GeneLabLedger`。
- DOCX 打印在隔离的子进程中调用 Office；任务完成或超时后清理临时文档和 Office 实例。
- 自动导出调度器由 FastAPI 生命周期管理；关闭桌面窗口时停止，不驻留托盘。
- 打印机列表来自当前 Windows 的打印后台处理程序，不写入安装包。

## 核心数据关系

```text
Case（病理号）
  └─ ProjectRecord（项目台账记录）
       ├─ RecordValue（动态表头值）
       ├─ ExperimentRun（实验编排条目）
       └─ ReportTemplateVersion + ReportMapping（报告映射）

Project（检测项目）
  ├─ FieldDefinition（项目表头）
  ├─ ProjectRecord
  └─ ReportTemplate

AutoExportTask
  └─ AutoExportRun
```

## 进程退出顺序

```text
关闭桌面窗口
  → 停止接受新的打印任务
  → 终止未完成的隔离打印子进程
  → 停止自动导出调度器
  → 结束 Uvicorn
  → 销毁 WebView2 前端窗口
  → 释放单实例锁
```
