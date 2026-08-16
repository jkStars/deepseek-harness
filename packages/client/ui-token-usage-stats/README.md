# @deepseek-ai/dsh-client-ui-token-usage-stats

English | [中文](README.zh.md)

Browser-side entry for the token usage dashboard: one `sidebar.footer.action`
row above Settings. Expanded, it shows a `用量统计` button; on the collapsed
56px rail it shows a bar-chart glyph. Clicking opens an in-page modal that
embeds the host-registered `/token-usage-stats` page, so desktop users never
leave the application window.

## Model Experience

None, as the plugin only renders a modal trigger and an embedded analytics
page; it touches no prompt, message, schema, stream, or tool result.

#### KV Cache effect

None; this plugin neither assembles nor sends provider requests.

## Known Limitations and Deferred Work

- **Embedded via iframe, not a native React dashboard** — the modal frames the
  host page, so it depends on the host webserver serving `/token-usage-stats`.
- **No capability badge or live totals on the entry** — the footer row is a
  static trigger and does not poll `/api/token-usage-stats`.
