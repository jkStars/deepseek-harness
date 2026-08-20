import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import TokenUsageStats from '@deepseek-ai/dsh-token-usage-stats'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { apply, inject, name } from '../src/index.ts'

let context: Context | undefined

async function boot(): Promise<{ ctx: Context; base: string }> {
  const ctx = new Context()
  context = ctx
  await ctx.plugin(SessionStore)
  await ctx.plugin(TokenUsageStats)
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await ctx.plugin({ name, inject, apply })
  const port = ctx.webServer.port
  return { ctx, base: `http://127.0.0.1:${port}` }
}

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
})

describe('token usage stats web routes', () => {
  it('serves the JSON snapshot and the dashboard page through the real webserver', async () => {
    const { base } = await boot()
    const json = await fetch(`${base}/api/token-usage-stats?granularity=hour`)
    expect(json.status).toBe(200)
    expect(json.headers.get('content-type')).toContain('application/json')
    const snapshot = (await json.json()) as { totals: { requestCount: number } }
    expect(snapshot.totals.requestCount).toBe(0)

    const page = await fetch(`${base}/token-usage-stats`)
    expect(page.status).toBe(200)
    expect(page.headers.get('content-type')).toContain('text/html')
    const html = await page.text()
    expect(html).toContain('Token 用量统计')
    expect(html).toContain('/api/token-usage-stats')
  })

  it('answers 400 for a series range beyond the bucket cap', async () => {
    const { ctx, base } = await boot()
    // Give the service records so the series is actually materialized; an
    // empty snapshot short-circuits before the bucket-cap check.
    const session = ctx.sessions.create()
    session.append('request/header', {
      header: { config: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } },
      reason: 'initial',
    })
    const response = await fetch(`${base}/api/token-usage-stats?from=0&granularity=hour`)
    expect(response.status).toBe(400)
    expect(response.headers.get('content-type')).toContain('application/json')
    const body = (await response.json()) as { error: string }
    expect(body.error).toMatch(/bucket limit/)
  })
})
