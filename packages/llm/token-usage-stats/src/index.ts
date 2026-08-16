/**
 * Cross-session token usage, request count, and optional cost analytics.
 *
 * @module @deepseek-ai/dsh-token-usage-stats
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { deepFreeze } from '@deepseek-ai/dsh-llm'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type {
  ModelPricing,
  ModelUsage,
  TokenUsageStatsConfig,
  TokenUsageStatsQuery,
  TokenUsageStatsSnapshot,
  UsageSeriesPoint,
  UsageTotals,
} from './types.ts'

export type * from './types.ts'

/** One provider-reported usage sample retained for one session step. */
interface UsageRecord {
  readonly time: number
  readonly provider: string
  readonly model: string
  readonly turn: number
  readonly step: number
  readonly usage: TokenUsage
}

/** One dispatched model request retained for request-count bucketing. */
interface RequestRecord {
  readonly time: number
  readonly provider: string
  readonly model: string
}

/** Per-session replay cursor and current route facts. */
interface SessionState {
  consumedEvents: number
  provider: string | undefined
  model: string | undefined
}

/** Validated plugin configuration. */
interface ResolvedConfig {
  readonly currency?: string
  readonly pricing: Readonly<Record<string, Readonly<ModelPricing>>>
}

/** Local mutable face used while building readonly public values. */
type Mutable<T> = { -readonly [K in keyof T]: T[K] }

const PRICING_KEYS = new Set([
  'uncachedInputPerMillion',
  'cacheReadPerMillion',
  'cacheWritePerMillion',
  'outputPerMillion',
])

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/** Reject stale or misspelled keys and malformed pricing before defaults can hide them. */
function validateConfig(config: TokenUsageStatsConfig): ResolvedConfig {
  if (typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('TokenUsageStatsConfig: config must be an object')
  }
  const allowed = new Set(['currency', 'pricing'])
  for (const key of Object.keys(config)) {
    if (!allowed.has(key)) {
      throw new Error(`TokenUsageStatsConfig: unknown key "${key}"`)
    }
  }

  const currency = config.currency
  if (currency !== undefined && (typeof currency !== 'string' || currency.length === 0)) {
    throw new Error('TokenUsageStatsConfig: currency must be a non-empty string')
  }

  const pricing: Record<string, ModelPricing> = {}
  if (config.pricing !== undefined) {
    if (typeof config.pricing !== 'object' || Array.isArray(config.pricing)) {
      throw new Error('TokenUsageStatsConfig: pricing must be a record')
    }
    for (const [model, value] of Object.entries(config.pricing)) {
      if (model.length === 0) {
        throw new Error('TokenUsageStatsConfig: pricing model must be a non-empty string')
      }
      if (typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`TokenUsageStatsConfig: pricing for "${model}" must be an object`)
      }
      for (const key of Object.keys(value)) {
        if (!PRICING_KEYS.has(key)) {
          throw new Error(`TokenUsageStatsConfig: pricing for "${model}" has unknown key "${key}"`)
        }
      }
      const price: Mutable<ModelPricing> = {}
      if (value.uncachedInputPerMillion !== undefined) {
        if (!isNonNegativeFinite(value.uncachedInputPerMillion)) {
          throw new Error(`TokenUsageStatsConfig: pricing "${model}.uncachedInputPerMillion" must be a non-negative finite number`)
        }
        price.uncachedInputPerMillion = value.uncachedInputPerMillion
      }
      if (value.cacheReadPerMillion !== undefined) {
        if (!isNonNegativeFinite(value.cacheReadPerMillion)) {
          throw new Error(`TokenUsageStatsConfig: pricing "${model}.cacheReadPerMillion" must be a non-negative finite number`)
        }
        price.cacheReadPerMillion = value.cacheReadPerMillion
      }
      if (value.cacheWritePerMillion !== undefined) {
        if (!isNonNegativeFinite(value.cacheWritePerMillion)) {
          throw new Error(`TokenUsageStatsConfig: pricing "${model}.cacheWritePerMillion" must be a non-negative finite number`)
        }
        price.cacheWritePerMillion = value.cacheWritePerMillion
      }
      if (value.outputPerMillion !== undefined) {
        if (!isNonNegativeFinite(value.outputPerMillion)) {
          throw new Error(`TokenUsageStatsConfig: pricing "${model}.outputPerMillion" must be a non-negative finite number`)
        }
        price.outputPerMillion = value.outputPerMillion
      }
      pricing[model] = deepFreeze(price)
    }
  }

  return deepFreeze({
    ...(currency === undefined ? {} : { currency }),
    pricing: deepFreeze(pricing),
  })
}

/** Floor a timestamp to a UTC hour or day boundary. */
function startOfBucket(time: number, granularity: 'hour' | 'day'): number {
  const date = new Date(time)
  if (granularity === 'day') {
    date.setUTCHours(0, 0, 0, 0)
  } else {
    date.setUTCMinutes(0, 0, 0)
  }
  return date.getTime()
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    tokenUsageStats: TokenUsageStats
  }
}

/**
 * Replay-aware cross-session usage analytics service.
 *
 * The service observes `session/event`, replays already-live sessions on mount,
 * and keeps per-step usage samples so a later final `assistant/message` replaces
 * an earlier usage chunk instead of double counting. Request counts come from
 * `request/header` events.
 */
export class TokenUsageStats extends Service {
  static inject = ['sessions']
  // Schemastery preserves untrusted loader keys on an empty object schema;
  // validateConfig rejects unknown keys and validates nested pricing manually.
  static Config: z<TokenUsageStatsConfig> = z.object({})

  private readonly config: ResolvedConfig
  private readonly usageByStep = new Map<string, number>()
  private readonly usageRecords: UsageRecord[] = []
  private readonly requestRecords: RequestRecord[] = []
  private readonly states = new WeakMap<Session, SessionState>()
  private readonly persistedSeq = new Map<SessionId, number>()

  constructor(ctx: Context, config: TokenUsageStatsConfig = {}) {
    super(ctx, 'tokenUsageStats')
    this.config = validateConfig(config)

    for (const session of ctx.sessions.list()) this._sync(session)
    ctx.inject(['sessionPersistence'], (persistenceCtx) => {
      void this._rehydrate(persistenceCtx.sessionPersistence).catch((error: unknown) => {
        this.ctx.logger.warn(`token usage stats: rehydration failed: ${String(error)}`)
      })
    })
    ctx.on('session/event', (session) => {
      this._sync(session)
    })
  }

  /**
   * Return a detached immutable analytics snapshot.
   * @param query - optional time/model/granularity filters.
   * @returns aggregate totals, per-model totals, and time-bucketed series.
   */
  snapshot(query: TokenUsageStatsQuery = {}): TokenUsageStatsSnapshot {
    const from = query.from
    const to = query.to
    const model = query.model
    const granularity = query.granularity ?? 'hour'
    const inRange = (time: number): boolean =>
      (from === undefined || time >= from) && (to === undefined || time <= to)
    const matches = (value: string): boolean => model === undefined || value === model

    const usageRecords = this.usageRecords.filter(record => inRange(record.time) && matches(record.model))
    const requestRecords = this.requestRecords.filter(record => inRange(record.time) && matches(record.model))

    return deepFreeze({
      ...(this.config.currency === undefined ? {} : { currency: this.config.currency }),
      totals: this._totals(usageRecords, requestRecords.length),
      models: this._models(usageRecords, requestRecords),
      series: this._series(usageRecords, requestRecords, from, to, granularity),
    })
  }

  /** Catch one session's fold up to the current durable tail. */
  private _sync(session: Session): void {
    let state = this.states.get(session)
    if (state === undefined) {
      state = {
        consumedEvents: this.persistedSeq.get(session.id) ?? 0,
        provider: undefined,
        model: undefined,
      }
      this.states.set(session, state)
    }

    while (state.consumedEvents < session.events.length) {
      // Session construction validates contiguous seqs, so the current index exists.
      // oxlint-disable-next-line typescript/no-non-null-assertion
      const event = session.events[state.consumedEvents]!
      this._foldEvent(session.id, state, event)
      state.consumedEvents += 1
    }
  }

  /**
   * Replay materialized persisted sessions so a process restart keeps the
   * aggregate. Live sessions are skipped: their constructor-time sync already
   * counted the same log, and a persisted session opened later starts its live
   * fold after the replayed seq.
   */
  private async _rehydrate(sessionPersistence: SessionPersistence): Promise<void> {
    const snapshots = await sessionPersistence.listSnapshots()
    for (const snapshot of snapshots) {
      const id = snapshot.header.id
      if (this.ctx.sessions.get(id) !== undefined) continue
      const inspection = await sessionPersistence.inspect(id)
      const state: SessionState = { consumedEvents: 0, provider: undefined, model: undefined }
      for (const event of inspection.events) {
        this._foldEvent(id, state, event)
        state.consumedEvents += 1
      }
      this.persistedSeq.set(id, inspection.events.length)
    }
  }

  /** Fold one event into route state and aggregate records. */
  private _foldEvent(session: SessionId, state: SessionState, event: SessionEvent): void {
    switch (event.type) {
      case 'request/header': {
        const config = event.data.header.config
        state.provider = config.provider
        state.model = config.model
        this._recordRequest(event.time, config.provider, config.model)
        break
      }
      case 'request/context':
        state.provider = event.data.provider
        state.model = event.data.model
        break
      case 'assistant/chunk':
        if (event.data.chunk.type === 'usage') {
          this._recordUsage(
            session,
            state,
            event.time,
            event.data.turn,
            event.data.step,
            event.data.chunk.usage,
          )
        }
        break
      case 'assistant/message':
        if (event.data.usage !== undefined) {
          this._recordUsage(
            session,
            state,
            event.time,
            event.data.turn,
            event.data.step,
            event.data.usage,
          )
        }
        break
      default:
        break
    }
  }

  /** Record one provider usage sample, replacing any earlier same-step sample. */
  private _recordUsage(
    sessionId: SessionId,
    state: SessionState,
    time: number,
    turn: number,
    step: number,
    usage: TokenUsage,
  ): void {
    const key = `${sessionId}:${turn}:${step}`
    const record: UsageRecord = {
      time,
      provider: state.provider ?? 'unknown',
      model: state.model ?? 'unknown',
      turn,
      step,
      usage,
    }
    const existingIndex = this.usageByStep.get(key)
    if (existingIndex !== undefined) {
      this.usageRecords[existingIndex] = record
    } else {
      this.usageByStep.set(key, this.usageRecords.length)
      this.usageRecords.push(record)
    }
  }

  /** Record one dispatched request for count bucketing. */
  private _recordRequest(time: number, provider: string, model: string): void {
    this.requestRecords.push({ time, provider, model })
  }

  /** Compute cost for one usage record, or undefined when no price is configured. */
  private _costFor(model: string, usage: TokenUsage): number | undefined {
    const price = this.config.pricing[model]
    if (price === undefined) return undefined
    return (
      usage.inputTokens * (price.uncachedInputPerMillion ?? 0)
      + (usage.cacheReadTokens ?? 0) * (price.cacheReadPerMillion ?? 0)
      + (usage.cacheWriteTokens ?? 0) * (price.cacheWritePerMillion ?? 0)
      + usage.outputTokens * (price.outputPerMillion ?? 0)
    ) / 1_000_000
  }

  /** Aggregate a set of usage records and a request count. */
  private _totals(usageRecords: readonly UsageRecord[], requestCount: number): UsageTotals {
    const totals: Mutable<UsageTotals> = {
      requestCount,
      uncachedInputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    }
    let cost: number | undefined
    for (const record of usageRecords) {
      totals.uncachedInputTokens += record.usage.inputTokens
      totals.cacheReadTokens += record.usage.cacheReadTokens ?? 0
      totals.cacheWriteTokens += record.usage.cacheWriteTokens ?? 0
      totals.outputTokens += record.usage.outputTokens
      const recordCost = this._costFor(record.model, record.usage)
      if (recordCost !== undefined) cost = (cost ?? 0) + recordCost
    }
    totals.totalTokens = totals.uncachedInputTokens
      + totals.cacheReadTokens
      + totals.cacheWriteTokens
      + totals.outputTokens
    if (cost !== undefined) totals.cost = cost
    return totals
  }

  /** Group usage and request records by provider/model pair. */
  private _models(
    usageRecords: readonly UsageRecord[],
    requestRecords: readonly RequestRecord[],
  ): ModelUsage[] {
    const grouped = new Map<string, {
      provider: string
      model: string
      requestCount: number
      usageRecords: UsageRecord[]
    }>()
    for (const record of requestRecords) {
      const key = `${record.provider}\u0000${record.model}`
      let group = grouped.get(key)
      if (group === undefined) {
        group = { provider: record.provider, model: record.model, requestCount: 0, usageRecords: [] }
        grouped.set(key, group)
      }
      group.requestCount += 1
    }
    for (const record of usageRecords) {
      const key = `${record.provider}\u0000${record.model}`
      let group = grouped.get(key)
      if (group === undefined) {
        group = { provider: record.provider, model: record.model, requestCount: 0, usageRecords: [] }
        grouped.set(key, group)
      }
      group.usageRecords.push(record)
    }
    return [...grouped.values()].map(group => ({
      provider: group.provider,
      model: group.model,
      totals: this._totals(group.usageRecords, group.requestCount),
    }))
  }

  /** Bucket filtered records into contiguous UTC hour/day bins. */
  private _series(
    usageRecords: readonly UsageRecord[],
    requestRecords: readonly RequestRecord[],
    from: number | undefined,
    to: number | undefined,
    granularity: 'hour' | 'day',
  ): UsageSeriesPoint[] {
    if (usageRecords.length === 0 && requestRecords.length === 0) return []

    const times = [
      ...usageRecords.map(record => record.time),
      ...requestRecords.map(record => record.time),
    ]
    const minTime = Math.min(...times)
    const maxTime = Math.max(...times)
    const start = from ?? minTime
    const end = to ?? maxTime
    const bucketSize = granularity === 'day' ? 86_400_000 : 3_600_000
    const firstStart = startOfBucket(start, granularity)
    const bucketCount = Math.max(1, Math.floor((end - firstStart) / bucketSize) + 1)
    const buckets = Array.from({ length: bucketCount }, (_, index) => ({
      startTime: firstStart + index * bucketSize,
      usageRecords: [] as UsageRecord[],
      requestCount: 0,
    }))

    for (const record of usageRecords) {
      const index = Math.min(buckets.length - 1, Math.max(0, Math.floor((record.time - firstStart) / bucketSize)))
      buckets[index]?.usageRecords.push(record)
    }
    for (const record of requestRecords) {
      const index = Math.min(buckets.length - 1, Math.max(0, Math.floor((record.time - firstStart) / bucketSize)))
      const bucket = buckets[index]
      if (bucket !== undefined) {
        bucket.requestCount += 1
      }
    }

    return buckets.map(bucket => ({
      startTime: bucket.startTime,
      endTime: bucket.startTime + bucketSize,
      totals: this._totals(bucket.usageRecords, bucket.requestCount),
    }))
  }
}

export default TokenUsageStats
