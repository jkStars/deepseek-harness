import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createMessage } from '@deepseek-ai/dsh-llm'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import SessionStore, { canonicalHeader } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import TokenUsageStats from '@deepseek-ai/dsh-token-usage-stats'
import type { TokenUsageStatsConfig } from '@deepseek-ai/dsh-token-usage-stats'

async function harness(config: TokenUsageStatsConfig = {}): Promise<{
  ctx: Context
  session: Session
}> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(TokenUsageStats, config)
  return { ctx, session: ctx.sessions.create() }
}

function startStep(session: Session, turn: number, step: number): void {
  session.append('step/start', { turn, step })
}

function appendHeader(session: Session, provider: string, model: string): void {
  session.append('request/header', {
    header: canonicalHeader({ config: { provider, model } }),
    reason: 'initial',
  })
}

function appendUsageChunk(
  session: Session,
  usage: TokenUsage,
  turn: number,
  step: number,
): number {
  return session.append('assistant/chunk', { turn, step, chunk: { type: 'usage', usage } }).seq
}

function appendFinalUsage(
  session: Session,
  usage: TokenUsage,
  provider: string,
  model: string,
  turn: number,
  step: number,
  sourceSeqs: number[] = [],
): void {
  session.append('assistant/message', {
    turn,
    step,
    message: createMessage({
      role: 'assistant',
      content: [],
      source: { kind: 'model', provider, model },
    }),
    usage,
  }, { surfaceOp: 'append', sourceEventSeqs: sourceSeqs })
  session.append('step/end', { turn, step })
}

describe('TokenUsageStats', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-15T00:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('replays sessions that were live before plugin load', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create()
    startStep(session, 1, 1)
    appendHeader(session, 'deepseek-official', 'deepseek-v4-flash')
    appendFinalUsage(session, {
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheWriteTokens: 5,
    }, 'deepseek-official', 'deepseek-v4-flash', 1, 1)
    await ctx.plugin(TokenUsageStats)

    const snapshot = ctx.tokenUsageStats.snapshot()
    expect(snapshot.totals.requestCount).toBe(1)
    expect(snapshot.totals.totalTokens).toBe(155)
  })

  it('serves totals, models, and series from the service', async () => {
    const { ctx, session } = await harness()
    const usage = {
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheWriteTokens: 5,
    }
    startStep(session, 1, 1)
    appendHeader(session, 'deepseek-official', 'deepseek-v4-flash')
    appendFinalUsage(session, usage, 'deepseek-official', 'deepseek-v4-flash', 1, 1)

    const snapshot = ctx.tokenUsageStats.snapshot()
    expect(snapshot.totals.requestCount).toBe(1)
    expect(snapshot.totals.uncachedInputTokens).toBe(100)
    expect(snapshot.totals.cacheReadTokens).toBe(30)
    expect(snapshot.totals.cacheWriteTokens).toBe(5)
    expect(snapshot.totals.outputTokens).toBe(20)
    expect(snapshot.totals.totalTokens).toBe(155)
    expect(snapshot.models).toHaveLength(1)
    expect(snapshot.models[0]).toMatchObject({
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      totals: {
        requestCount: 1,
        uncachedInputTokens: 100,
        outputTokens: 20,
        totalTokens: 155,
      },
    })
    expect(snapshot.series).toHaveLength(1)
    expect(snapshot.series[0]?.totals.requestCount).toBe(1)
    expect(snapshot.series[0]?.totals.totalTokens).toBe(155)
  })

  it('replaces an earlier usage chunk with the finalized message usage', async () => {
    const { ctx, session } = await harness()
    startStep(session, 1, 1)
    appendHeader(session, 'deepseek-official', 'deepseek-v4-flash')
    const source = appendUsageChunk(session, {
      inputTokens: 10,
      outputTokens: 2,
      cacheReadTokens: 3,
    }, 1, 1)
    vi.setSystemTime(new Date('2026-08-15T00:01:00.000Z'))
    appendFinalUsage(session, {
      inputTokens: 12,
      outputTokens: 4,
      cacheReadTokens: 8,
      cacheWriteTokens: 1,
    }, 'deepseek-official', 'deepseek-v4-flash', 1, 1, [source])

    const snapshot = ctx.tokenUsageStats.snapshot()
    expect(snapshot.totals.requestCount).toBe(1)
    expect(snapshot.totals.uncachedInputTokens).toBe(12)
    expect(snapshot.totals.cacheReadTokens).toBe(8)
    expect(snapshot.totals.cacheWriteTokens).toBe(1)
    expect(snapshot.totals.outputTokens).toBe(4)
    expect(snapshot.totals.totalTokens).toBe(25)
  })

  it('computes optional cost from configured pricing', async () => {
    const { ctx, session } = await harness({
      currency: 'CNY',
      pricing: {
        'deepseek-v4-flash': {
          uncachedInputPerMillion: 1,
          cacheReadPerMillion: 0.5,
          cacheWritePerMillion: 0.25,
          outputPerMillion: 2,
        },
      },
    })
    startStep(session, 1, 1)
    appendHeader(session, 'deepseek-official', 'deepseek-v4-flash')
    appendFinalUsage(session, {
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      cacheReadTokens: 200_000,
      cacheWriteTokens: 100_000,
    }, 'deepseek-official', 'deepseek-v4-flash', 1, 1)

    const snapshot = ctx.tokenUsageStats.snapshot()
    expect(snapshot.currency).toBe('CNY')
    expect(snapshot.totals.cost).toBeDefined()
    const cost = snapshot.totals.cost
    if (cost !== undefined) {
      expect(cost).toBeCloseTo(1 + 0.1 + 0.025 + 1, 10)
    }
  })

  it('rejects unknown configuration keys', async () => {
    await expect(harness({ unknown: true } as unknown as TokenUsageStatsConfig))
      .rejects.toThrow('TokenUsageStatsConfig: unknown key "unknown"')
  })
})
