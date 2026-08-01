# 前端与 Electron

Vue 3 前端保留 Element Plus 的表格、表单、对话框和通知能力；Tailwind CSS 负责应用壳、间距、布局和轻量视觉微调。Tailwind Preflight 已关闭，避免重置 Element Plus 的核心样式。

## 命令

```powershell
npm install
npm run dev
npm run desktop
npm run typecheck
npm run test
npm run build
```

- `npm run dev`：浏览器开发模式，`/api` 代理到 `127.0.0.1:8000`。
- `npm run desktop`：Electron 开发壳，Electron 启动 Python sidecar。
- `npm run desktop:package`：仅供 GitHub Actions 使用，不在本地执行。

## 桌面桥接

沙箱 preload 仅暴露：

- 后端随机端口 URL 与当前数据目录
- Windows Excel“另存为”
- 自动导出目录选择
- 数据目录切换与应用重启

生产构建使用 hash 路由从 `file://` 加载。浏览器开发模式没有 Electron bridge，因此手动导出回退为浏览器下载。

## 数据安全边界

- 台账记录只按 UUID 更新；病理号相同不建立关联。
- 导入必须先预览，存在全局或逐行错误时前端不允许提交。
- 批量删除必须先预览；锁定记录或集合变化时后端拒绝执行。
- 实验编号在台账只读，由实验编排回写或 Excel 数据恢复导入。
- 报告页面只提供直接打印，不提供 DOCX/ZIP 下载。
