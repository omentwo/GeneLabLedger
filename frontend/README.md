# 新版前端

这是与旧版 `index-v2.html` 并行运行的 Vue 3 前端。业务数据全部通过同一个
FastAPI 后端读写，不使用浏览器本地存储保存台账。

## 技术栈

- Vue 3 + TypeScript
- Vite
- Vue Router
- Pinia
- Element Plus
- Vitest

## 开发与检查

```powershell
npm.cmd install
npm.cmd run typecheck
npm.cmd run test
npm.cmd run build
```

开发服务器默认运行在 `http://127.0.0.1:5173/app/`，并把 `/api` 代理到
`http://127.0.0.1:8000`。

生产构建写入 `frontend/dist/`。FastAPI 启动时如果发现该目录，会提供：

- 新版入口：`http://127.0.0.1:8000/app/`
- 旧版回退入口：`http://127.0.0.1:8000/`

## 迁移保护

- 旧版文件不由新版构建覆盖。
- 实验编排只使用后端返回的项目记录 ID 和实验运行 ID，不根据病理号或当前项目猜测归属。
- 锁定记录使用只读控件，因此可选择、复制，但不能修改。
- Excel 多单元格粘贴直接保存，不创建浏览器确认框。
- 不同项目导出到独立工作表，使用各自项目表头。

