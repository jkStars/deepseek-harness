import { describe, expect, it } from 'vitest'
import { renderUsageDashboard } from '../src/dashboard.ts'
import { parseTokenUsageStatsQuery } from '../src/index.ts'

describe('token usage stats dashboard', () => {
  it('renders a self-contained dashboard with every visualization seat', () => {
    const html = renderUsageDashboard()
    expect(html).toContain('<!doctype html>')
    expect(html).toContain('Token 用量统计')
    expect(html).toContain('id="cost"')
    expect(html).toContain('id="requests"')
    expect(html).toContain('id="totalTokens"')
    expect(html).toContain('id="series"')
    expect(html).toContain('id="breakdown"')
    expect(html).toContain('id="modelRows"')
    expect(html).toContain('class="bar"')
    expect(html).toContain('/api/token-usage-stats')
  })

  it('parses supported query parameters and ignores invalid numbers', () => {
    expect(parseTokenUsageStatsQuery(new URLSearchParams(
      'from=1723680000000&to=1723766400000&model=deepseek-v4-flash&granularity=hour',
    ))).toEqual({
      from: 1723680000000,
      to: 1723766400000,
      model: 'deepseek-v4-flash',
      granularity: 'hour',
    })
    expect(parseTokenUsageStatsQuery(new URLSearchParams('from=not-a-number&granularity=week')))
      .toEqual({})
  })
})
