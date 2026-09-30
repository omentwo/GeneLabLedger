# Gene Lab Ledger 前端与 Electron

## 台账剪切

- 选中单元格或范围后，按 `Ctrl+X`（Mac 为 `Cmd+X`），或右键选择“剪切”。
- 内容成功写入剪贴板后，清空并保存可编辑单元格；可用 `Ctrl+V` 粘贴，`Ctrl+Z` 撤销。
- 病理号、状态及锁定记录的内容会保留，并提示跳过原因。
- 在输入框内编辑时，`Ctrl+X` 保持原生文字剪切，只剪切选中的文字。
- 等待剪贴板写入时切换台账或修改原内容，会取消清空，保留原内容。

## 技术栈

| 分类 | 技术 |
|---|---|
| 桌面容器 | Electron、Electron Builder |
| 前端框架 | Vue 3、TypeScript、Vite |
| UI 组件 | Element Plus |
| CSS 与布局 | Tailwind CSS |
| 状态管理 | Pinia |
| 路由 | Vue Router |
| HTTP 通信 | Fetch API、FastAPI REST API |
| 桌面桥接 | Electron preload、contextIsolation、白名单 IPC |
| Excel 能力 | XLSX / Open XML |
| 测试与质量 | Vitest、Playwright、vue-tsc |
| Windows 发布 | Electron Builder、GitHub Actions |
