# @deepseek-ai/dsh-token-usage-stats-web

English | [中文](README.zh.md)

Web surface for `@deepseek-ai/dsh-token-usage-stats`. The plugin injects
`webServer` and `tokenUsageStats` and registers two exact routes:

- `/token-usage-stats` — self-contained HTML dashboard. It shows cost, API
  request count, token totals, input/output/cache breakdown, per-model rows,
  and an hourly or daily token series chart.
- `/api/token-usage-stats` — JSON feed consumed by that page. Supports
  `from`, `to`, `model`, and `granularity=hour|day` query parameters.

The dashboard is static HTML/CSS/JS generated at request time; it does not
participate in the built React client and needs no frontend rebuild.

## Composition

The plugin is part of the web bundle:

```yaml
- id: token-usage-stats-web
  name: '@deepseek-ai/dsh-token-usage-stats-web'
```

It stays pending in compositions without `webServer` (for example headless).

## Model Experience

None, as the plugin only serves already-logged analytics over HTTP and adds no
prompt, message, schema, stream, or tool result.

#### KV Cache effect

None; this plugin neither assembles nor sends provider requests.

## Known Limitations and Deferred Work

- **Separate page, not an in-app React tab** — the dashboard is reached at
  `/token-usage-stats` instead of the conversation view ring.
- **No authentication or authorization** — it inherits whatever trust boundary
  the composed webserver exposes; bind loopback or add a reverse proxy for LAN
  deployments.
- **In-memory data only** — the page reflects the same process-local snapshot
  as `ctx.tokenUsageStats`.
