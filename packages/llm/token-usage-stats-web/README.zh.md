# @deepseek-ai/dsh-token-usage-stats-web

[English](README.md) | 中文

`@deepseek-ai/dsh-token-usage-stats` 的 Web 面板。插件注入 `webServer` 和
`tokenUsageStats`，注册两个精确路由：

- `/token-usage-stats` — 自包含 HTML 仪表盘。展示成本、API 请求次数、token
  总量、输入/输出/缓存构成、按模型明细，以及按小时或按天的 token 趋势图。
- `/api/token-usage-stats` — 面板使用的 JSON 数据源。支持 `from`、`to`、
  `model` 和 `granularity=hour|day` 查询参数。

仪表盘是请求时生成的静态 HTML/CSS/JS，不参与已构建的 React 客户端，也不需要
前端重新构建。

## 组合

该插件随 Web bundle 加载：

```yaml
- id: token-usage-stats-web
  name: '@deepseek-ai/dsh-token-usage-stats-web'
```

在没有 `webServer` 的组合中（例如 headless），插件会保持挂起。

## 模型体验

无，因为插件只是通过 HTTP 提供已经记录的统计数据，不添加提示词、消息、
schema、流或工具结果。

#### KV Cache 影响

无；本插件既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **独立页面，而不是应用内 React 标签页** — 仪表盘地址为 `/token-usage-stats`，
  尚未加入会话视图切换环。
- **没有认证或授权** — 面板继承组合中 webserver 暴露的信任边界；LAN 部署应
  绑定回环地址或使用反向代理保护。
- **仅内存数据** — 页面展示与 `ctx.tokenUsageStats` 相同的进程内快照。
