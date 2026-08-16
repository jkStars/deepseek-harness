/**
 * Web surface for `ctx.tokenUsageStats`: a self-contained dashboard page at
 * `/token-usage-stats` plus its JSON feed at `/api/token-usage-stats`.
 *
 * @module @deepseek-ai/dsh-token-usage-stats-web
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { TokenUsageStatsQuery } from '@deepseek-ai/dsh-token-usage-stats'
import type {} from '@deepseek-ai/dsh-token-usage-stats'
import { renderUsageDashboard } from './dashboard.ts'

/** Stable Cordis plugin name. */
export const name = 'token-usage-stats-web'
/** The dashboard needs the webserver and the analytics service it visualizes. */
export const inject = ['webServer', 'tokenUsageStats']

/** Parse one optional finite-number query parameter. */
function finiteParam(value: string | null): number | undefined {
  if (value === null || value.trim() === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * Build a snapshot query from the dashboard API's URL parameters.
 * Invalid numbers are ignored rather than guessed; an unsupported granularity
 * falls back to the service default (`hour`).
 * @param params - parsed URL search parameters.
 * @returns a validated query for {@link TokenUsageStatsQuery}.
 */
export function parseTokenUsageStatsQuery(params: URLSearchParams): TokenUsageStatsQuery {
  const from = finiteParam(params.get('from'))
  const to = finiteParam(params.get('to'))
  const model = params.get('model')
  const granularity = params.get('granularity')
  return {
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
    ...(model === null || model === '' ? {} : { model }),
    ...(granularity === 'day' || granularity === 'hour' ? { granularity } : {}),
  }
}

/**
 * Register the two exact HTTP routes. Registration is an effect, so unloading
 * this plugin removes both routes before either service disposes.
 * @param ctx - plugin context carrying the webserver and analytics service.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => {
    const removePage = ctx.webServer.register({
      kind: 'exact',
      path: '/token-usage-stats',
      handler: (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405)
          res.end()
          return
        }
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
        })
        if (req.method === 'HEAD') {
          res.end()
        } else {
          res.end(renderUsageDashboard())
        }
      },
    })
    const removeApi = ctx.webServer.register({
      kind: 'exact',
      path: '/api/token-usage-stats',
      handler: (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405)
          res.end()
          return
        }
        // node:http always sets url on server requests; `?? '/'` keeps the
        // fallback valid for the optional IncomingMessage.url type.
        const url = new URL(req.url ?? '/', 'http://x')
        const snapshot = ctx.tokenUsageStats.snapshot(parseTokenUsageStatsQuery(url.searchParams))
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        })
        if (req.method === 'HEAD') {
          res.end()
        } else {
          res.end(JSON.stringify(snapshot))
        }
      },
    })
    return () => {
      removePage()
      removeApi()
    }
  }, 'token-usage-stats-web: routes')
}
