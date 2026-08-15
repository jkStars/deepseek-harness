// @vitest-environment jsdom
/**
 * Browser half of the HMR plugin: a `graph` frame whose rev differs from the
 * page's boot manifest means the plugin set changed live — the page reloads
 * once, and identical or unknown frames leave it alone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply, EVENTS_ENDPOINT, inject } from '../src/client/index.ts'

// The app declares __DSH_BOOT__ on the window contract of the modules package;
// the test window needs the same shape to author the boot manifest it compares
// against.
declare global {
  interface Window {
    __DSH_BOOT__?: { rev?: string; entries?: unknown[] }
  }
}

class FakeEventSource {
  static instances: FakeEventSource[] = []
  readonly listeners = new Map<string, Set<(event: MessageEvent<string>) => void>>()
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this)
  }
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type)!.add(listener)
  }
  removeEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    this.listeners.get(type)?.delete(listener)
  }
  dispatch(data: string): void {
    for (const listener of this.listeners.get('message') ?? []) listener({ data } as MessageEvent<string>)
  }
  close(): void {}
}

async function mount(): Promise<{ fiber: ReturnType<Context['plugin']>; reload: ReturnType<typeof vi.fn>; dispatch: (data: string) => void }> {
  const reload = vi.fn()
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: {
      reload,
      href: window.location.href,
      origin: window.location.origin,
      pathname: window.location.pathname,
      search: window.location.search,
      hash: window.location.hash,
    },
  })
  const ctx = new Context()
  ctx.provide('loader', { entries: () => [] } as never)
  ctx.provide('modules', {} as never)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  const source = FakeEventSource.instances[FakeEventSource.instances.length - 1]!
  expect(source.url).toBe(EVENTS_ENDPOINT)
  return { fiber, reload, dispatch: (data) => { source.dispatch(data) } }
}

describe('client-hmr browser half', () => {
  beforeEach(() => {
    FakeEventSource.instances = []
    vi.stubGlobal('EventSource', FakeEventSource)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    delete (window as unknown as { __DSH_BOOT__?: unknown }).__DSH_BOOT__
  })

  it('reloads the page once when the graph rev moves past the boot manifest', async () => {
    window.__DSH_BOOT__ = { rev: 'boot-rev', entries: [] }
    const { fiber, reload, dispatch } = await mount()
    try {
      // Connect-time snapshot carries the boot rev: no reload.
      dispatch(JSON.stringify({ type: 'graph', graph: { rev: 'boot-rev', entries: [] } }))
      expect(reload).not.toHaveBeenCalled()
      // A live plugin-set change moves the rev: one reload.
      dispatch(JSON.stringify({ type: 'graph', graph: { rev: 'new-rev', entries: [] } }))
      expect(reload).toHaveBeenCalledTimes(1)
      // Further frames during the reload window stay coalesced.
      dispatch(JSON.stringify({ type: 'graph', graph: { rev: 'newer-rev', entries: [] } }))
      expect(reload).toHaveBeenCalledTimes(1)
    } finally {
      await fiber.dispose()
    }
  })

  it('does not reload without a boot manifest (no baseline to compare)', async () => {
    const { fiber, reload, dispatch } = await mount()
    try {
      dispatch(JSON.stringify({ type: 'graph', graph: { rev: 'any-rev', entries: [] } }))
      expect(reload).not.toHaveBeenCalled()
    } finally {
      await fiber.dispose()
    }
  })

  it('leaves rebuilt frames and unknown frame types alone', async () => {
    window.__DSH_BOOT__ = { rev: 'boot-rev', entries: [] }
    const { fiber, reload, dispatch } = await mount()
    try {
      dispatch(JSON.stringify({ type: 'rebuilt', id: 'pkg-a', rev: 'r2' }))
      dispatch(JSON.stringify({ type: 'future-frame', anything: true }))
      dispatch(JSON.stringify({ not: 'a frame at all' }))
      expect(reload).not.toHaveBeenCalled()
    } finally {
      await fiber.dispose()
    }
  })
})
