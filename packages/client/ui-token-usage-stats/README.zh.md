# @deepseek-ai/dsh-client-ui-token-usage-stats

[English](README.md) | 中文

Token 用量仪表盘的浏览器侧入口：在侧边栏设置按钮上方注册一个
`sidebar.footer.action`。侧边栏展开时显示“用量统计”按钮；折叠为 56px 轨道时
显示柱状图图标。点击后会在当前应用内弹出模态框，内嵌宿主注册的
`/token-usage-stats` 页面，因此桌面端用户无需离开当前窗口。

## 模型体验

无，因为插件只渲染模态框触发器和内嵌统计页面，不接触提示词、消息、
schema、流或工具结果。

#### KV Cache 影响

无；本插件既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **通过 iframe 内嵌，而不是原生 React 仪表盘** — 模态框内嵌宿主页面，
  因此依赖宿主 webserver 提供 `/token-usage-stats`。
- **入口没有能力徽标或实时总数** — 底栏行是静态触发器，不轮询
  `/api/token-usage-stats`。
