# @deepseek-ai/dsh-token-usage-stats

English | [中文](README.zh.md)

Aggregate token usage, API request counts, and optional cost analytics across
all live sessions in one process. The plugin registers the `ctx.tokenUsageStats`
service, which folds the durable `session/event` stream into per-model totals
and time-bucketed series that a dashboard or CLI can render.

This package complements `@deepseek-ai/dsh-token-meter`: token-meter measures
one session's current context pressure; this service answers cross-session
"how much did we consume" questions.

## Configuration

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

- `currency` — optional label included in snapshots.
- `pricing` — optional per-model price book. Each rate is per one million
  tokens. A model without a pricing entry reports no cost rather than a fake
  zero.

Unknown configuration keys are rejected at load.

## Service

`ctx.tokenUsageStats.snapshot(query?)` returns a detached immutable snapshot:

```ts
interface TokenUsageStatsSnapshot {
  currency?: string
  totals: UsageTotals
  models: ModelUsage[]
  series: UsageSeriesPoint[]
}
```

`UsageTotals` contains `requestCount`, `uncachedInputTokens`,
`cacheReadTokens`, `cacheWriteTokens`, `outputTokens`, `totalTokens`, and an
optional computed `cost`.

Query options:

- `from` / `to` — inclusive Unix epoch millisecond bounds.
- `model` — restrict to one model id.
- `granularity` — `'hour'` (default) or `'day'` series buckets.

## Counting rules

- **API requests** are counted from `request/header` events, one per dispatched
  model call.
- **Token buckets** come from provider-reported `TokenUsage` on
  `assistant/chunk` usage samples and finalized `assistant/message` events.
  A later sample for the same `(turn, step)` replaces the earlier sample, so a
  usage chunk followed by a final message is never double counted.
- **Time buckets** use the event timestamp in UTC.
- **Cost** is computed from configured per-model pricing only when a pricing
  entry exists for every contributing model in that scope.

## Model Experience

None, as the plugin only computes a host-side read model of already-logged
session events and touches no prompt, message, schema, stream, or tool result.

#### KV Cache effect

None; this plugin neither assembles nor sends provider requests.

## Known Limitations and Deferred Work

- **Rehydration depends on a composed persistence backend** — with
  `ctx.sessionPersistence` mounted, startup replays every materialized session
  log, so historical usage survives process restarts. Without a backend only
  live sessions are counted.
- **Request count approximates dispatched calls** — a `request/header` is logged
  before network dispatch; a call that fails before reaching the provider still
  counts as a request attempt.
- **Pricing is static** — rates are read once at plugin load; changing provider
  pricing requires a reload.
