# @deepseek-ai/dsh-token-usage-stats

[English](README.md) | 中文

聚合当前进程中所有会话的 token 消耗、API 请求次数和可选成本分析。插件注册
`ctx.tokenUsageStats` 服务，将持久的 `session/event` 流折叠为按模型统计的总量
和按时间分桶的序列，供仪表盘或 CLI 渲染。

本包与 `@deepseek-ai/dsh-token-meter` 互补：token-meter 测量单个会话当前的上下文
压力；本服务回答跨会话的“我们一共消耗了多少”。

## 配置

```yaml
- id: token-usage-stats
  name: '@deepseek-ai/dsh-token-usage-stats'
  config:
    currency: CNY
    pricing:
      deepseek-v4-flash:
        uncachedInputPerMillion: 0.5
        cacheReadPerMillion: 0.1
        cacheWritePerMillion: 0
        outputPerMillion: 2
```

- `currency` — 可选，包含在快照中的货币标签。
- `pricing` — 可选，按模型 ID 配置的价目表。每个费率以每百万 token 计。
  没有定价条目的模型不报告成本，而不是报告虚假的 0。

未知配置键会在加载时被拒绝。

## 服务

`ctx.tokenUsageStats.snapshot(query?)` 返回一个独立的不可变快照：

```ts
interface TokenUsageStatsSnapshot {
  currency?: string
  totals: UsageTotals
  models: ModelUsage[]
  series: UsageSeriesPoint[]
}
```

`UsageTotals` 包含 `requestCount`、`uncachedInputTokens`、`cacheReadTokens`、
`cacheWriteTokens`、`outputTokens`、`totalTokens` 和可选的 `cost`。

查询选项：

- `from` / `to` — 包含边界的 Unix epoch 毫秒时间戳。
- `model` — 只统计指定模型 ID。
- `granularity` — `'hour'`（默认）或 `'day'` 序列分桶。

## 计数规则

- **API 请求次数** 来自 `request/header` 事件，每个派发的模型调用计一次。
- **Token 分桶** 来自 `assistant/chunk` 的 usage 样本和最终 `assistant/message`
  事件中提供方报告的 `TokenUsage`。同一 `(turn, step)` 的后续样本会替换早期样本，
  因此 usage chunk 后跟最终消息不会被重复计数。
- **时间分桶** 使用 UTC 事件时间戳。
- **成本** 仅在配置了对应模型定价时根据配置计算；没有定价条目的模型不贡献成本。

## 模型体验

无，因为本插件只计算已经记录的会话事件的宿主侧读模型，不接触提示词、消息、
schema、流或工具结果。

#### KV Cache 影响

无；本插件既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **恢复依赖已组合的持久化后端** — 挂载 `ctx.sessionPersistence` 后，启动时会重放
  所有已持久化的会话日志，因此历史用量在进程重启后仍会保留；没有后端时只统计
  活跃会话。
- **请求次数近似已派发的调用** — `request/header` 在网络派发前记录；在到达提供方
  之前失败的调用仍会计为一次请求尝试。
- **定价是静态的** — 费率只在插件加载时读取一次；提供方定价变化需要重载。
