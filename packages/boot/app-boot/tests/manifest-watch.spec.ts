/**
 * Live profile-manifest watching: `dsh plugin add/remove` rewrites the
 * profile's package.json mid-run; the watch recomposes the bundle patch stack
 * and transactionally reapplies it through the root Include, with bounded
 * retry while pnpm is still materializing a listed bundle.
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Hmr from '@deepseek-ai/cordis-plugin-hmr'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import {
  boot,
  BundlePendingError,
  initProfile,
  PROFILE_PATCH_FILENAME,
  resolveProfileDir,
  resolveProfileLiveStack,
  watchProfileManifest,
} from '../src/index.ts'

const NAME = 'dsh-test-bin'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'dsh-manifest-watch-'))

function writeTree(dir: string): string {
  writeFileSync(join(dir, 'noop.mjs'), [
    'export const name = "noop"',
    'export function apply(_ctx, config = {}) {',
    '  if (config.fail) throw new Error("candidate config failed")',
    '}',
    '',
  ].join('\n'))
  writeFileSync(join(dir, 'extra.mjs'), [
    'export const name = "extra"',
    'export function apply(_ctx, config = {}) {',
    '  if (config.fail) throw new Error("candidate config failed")',
    '}',
    '',
  ].join('\n'))
  writeFileSync(join(dir, 'cordis.yml'), '- id: noop\n  name: ./noop.mjs\n  config:\n    value: base\n')
  return join(dir, 'cordis.yml')
}

function entryConfig(ctx: Context, id: string): unknown {
  return [...ctx.loader.entries()].find(entry => entry.options.id === id)?.options.config
}

async function eventually(test: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!test()) {
    if (Date.now() >= deadline) throw new Error(message)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

const settleChokidarChangeThrottle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 75))

interface BundlesManifest {
  dependencies?: Record<string, string>
  dsh?: { profile?: { bundles?: string[] } }
}

function readBundlesOf(manifestPath: string): string[] {
  return (JSON.parse(readFileSync(manifestPath, 'utf8')) as BundlesManifest).dsh?.profile?.bundles ?? []
}

/** A caller-side fixture resolver: bundle names map to inserted rows. */
function fixtureResolver(manifestPath: string, bundles: Record<string, PatchOptions[]>): {
  resolveStack: () => PatchOptions[]
  calls: () => number
  setPending: (pending: boolean) => void
} {
  let pending = false
  let calls = 0
  return {
    setPending: (value: boolean) => { pending = value },
    calls: () => calls,
    resolveStack: () => {
      calls += 1
      if (pending) throw new BundlePendingError('pending-bundle', new Error('cannot resolve profile bundle "pending-bundle"'))
      return structuredClone(readBundlesOf(manifestPath).flatMap(bundle => bundles[bundle] ?? []))
    },
  }
}

describe('watchProfileManifest', () => {
  afterEach(() => {
    delete process.env.DSH_HOME
  })

  it('fails loud when the exact watcher lacks HMR or a root Include', async () => {
    const dir = tmp()
    const withoutHmr = await boot(NAME, writeTree(dir))
    await expect(watchProfileManifest(withoutHmr, {
      binName: NAME,
      manifestPath: join(tmp(), 'package.json'),
      currentBundles: [],
      readBundles: () => [],
      resolveStack: () => [],
    })).rejects.toThrow('requires the Cordis HMR service')
    await withoutHmr.fiber.dispose()

    const withoutInclude = new Context()
    withoutInclude.baseUrl = pathToFileURL(`${tmp()}/`).href
    await withoutInclude.plugin(Loader)
    await withoutInclude.plugin(Timer)
    await withoutInclude.plugin(Hmr, { root: [], ignored: [], debounce: 0 })
    await expect(watchProfileManifest(withoutInclude, {
      binName: NAME,
      manifestPath: join(tmp(), 'package.json'),
      currentBundles: [],
      readBundles: () => [],
      resolveStack: () => [],
    })).rejects.toThrow('requires the root Include entry')
    await withoutInclude.fiber.dispose()
  })

  it('skips a manifest write that does not change the bundle list', { timeout: 20_000 }, async () => {
    const dir = tmp()
    const manifestPath = join(dir, 'package.json')
    writeFileSync(manifestPath, JSON.stringify({ dsh: { profile: { bundles: [] } } }))
    const resolver = fixtureResolver(manifestPath, {
      'fixture-bundle': [{ insert: [{ id: 'extra', name: './extra.mjs', config: { value: 'live' } }] }],
    })
    const ctx = await boot(NAME, writeTree(dir))
    await ctx.plugin(Timer)
    await ctx.plugin(Hmr, { root: [], ignored: [], debounce: 0 })
    const dispose = await watchProfileManifest(ctx, {
      binName: NAME,
      manifestPath,
      currentBundles: [],
      readBundles: () => readBundlesOf(manifestPath),
      resolveStack: resolver.resolveStack,
    })
    try {
      // Dependency-only write (no bundle change): skipped, resolver untouched.
      writeFileSync(manifestPath, JSON.stringify({ dependencies: { lib: '1.0.0' }, dsh: { profile: { bundles: [] } } }))
      await settleChokidarChangeThrottle()
      expect(resolver.calls()).toBe(0)
      expect(entryConfig(ctx, 'extra')).toBeUndefined()
    } finally {
      await dispose()
      await ctx.fiber.dispose()
    }
  })

  it('mounts a bundle row added by dsh plugin add', { timeout: 20_000 }, async () => {
    const dir = tmp()
    const manifestPath = join(dir, 'package.json')
    writeFileSync(manifestPath, JSON.stringify({ dsh: { profile: { bundles: [] } } }))
    const resolver = fixtureResolver(manifestPath, {
      'fixture-bundle': [{ insert: [{ id: 'extra', name: './extra.mjs', config: { value: 'live' } }] }],
    })
    const ctx = await boot(NAME, writeTree(dir))
    await ctx.plugin(Timer)
    await ctx.plugin(Hmr, { root: [], ignored: [], debounce: 0 })
    const dispose = await watchProfileManifest(ctx, {
      binName: NAME,
      manifestPath,
      currentBundles: [],
      readBundles: () => readBundlesOf(manifestPath),
      resolveStack: resolver.resolveStack,
    })
    try {
      writeFileSync(manifestPath, JSON.stringify({ dependencies: { lib: '1.0.0' }, dsh: { profile: { bundles: ['fixture-bundle'] } } }))
      await eventually(() => (entryConfig(ctx, 'extra') as { value?: string } | undefined)?.value === 'live', 'live bundle row did not mount')
      expect(resolver.calls()).toBeGreaterThan(0)
    } finally {
      await dispose()
      await ctx.fiber.dispose()
    }
  })

  it('unmounts a bundle row removed by dsh plugin remove', { timeout: 20_000 }, async () => {
    const dir = tmp()
    const manifestPath = join(dir, 'package.json')
    writeFileSync(manifestPath, JSON.stringify({ dependencies: { lib: '1.0.0' }, dsh: { profile: { bundles: ['fixture-bundle'] } } }))
    const resolver = fixtureResolver(manifestPath, {
      'fixture-bundle': [{ insert: [{ id: 'extra', name: './extra.mjs', config: { value: 'live' } }] }],
    })
    // The boot tree already carries the bundle row, matching currentBundles.
    const ctx = await boot(NAME, writeTree(dir), [{ insert: [{ id: 'extra', name: './extra.mjs', config: { value: 'live' } }] }])
    await ctx.plugin(Timer)
    await ctx.plugin(Hmr, { root: [], ignored: [], debounce: 0 })
    const dispose = await watchProfileManifest(ctx, {
      binName: NAME,
      manifestPath,
      currentBundles: ['fixture-bundle'],
      readBundles: () => readBundlesOf(manifestPath),
      resolveStack: resolver.resolveStack,
    })
    try {
      expect((entryConfig(ctx, 'extra') as { value?: string } | undefined)?.value).toBe('live')
      writeFileSync(manifestPath, JSON.stringify({ dependencies: {}, dsh: { profile: { bundles: [] } } }))
      await eventually(() => entryConfig(ctx, 'extra') === undefined, 'live bundle row did not unmount')
    } finally {
      await dispose()
      await ctx.fiber.dispose()
    }
  })

  it('retries a pending bundle until it resolves, then applies', async () => {
    const dir = tmp()
    const manifestPath = join(dir, 'package.json')
    writeFileSync(manifestPath, JSON.stringify({ dsh: { profile: { bundles: ['fixture-bundle'] } } }))
    const resolver = fixtureResolver(manifestPath, {
      'fixture-bundle': [{ insert: [{ id: 'extra', name: './extra.mjs', config: { value: 'live' } }] }],
    })
    resolver.setPending(true)
    const ctx = await boot(NAME, writeTree(dir))
    await ctx.plugin(Timer)
    await ctx.plugin(Hmr, { root: [], ignored: [], debounce: 0 })
    const dispose = await watchProfileManifest(ctx, {
      binName: NAME,
      manifestPath,
      currentBundles: [],
      retryDelaysMs: [10, 10],
      maxRetries: 20,
      readBundles: () => readBundlesOf(manifestPath),
      resolveStack: resolver.resolveStack,
    })
    try {
      // The bundle becomes resolvable after the first failed attempt.
      setTimeout(() => { resolver.setPending(false) }, 30)
      await eventually(() => (entryConfig(ctx, 'extra') as { value?: string } | undefined)?.value === 'live', 'pending bundle did not mount after retry')
      expect(resolver.calls()).toBeGreaterThan(1)
    } finally {
      await dispose()
      await ctx.fiber.dispose()
    }
  })

  it('gives up on a pending bundle after maxRetries and reports through config HMR', async () => {
    const dir = tmp()
    const manifestPath = join(dir, 'package.json')
    writeFileSync(manifestPath, JSON.stringify({ dsh: { profile: { bundles: ['fixture-bundle'] } } }))
    const resolver = fixtureResolver(manifestPath, {
      'fixture-bundle': [{ insert: [{ id: 'extra', name: './extra.mjs' }] }],
    })
    resolver.setPending(true)
    const ctx = await boot(NAME, writeTree(dir))
    await ctx.plugin(Timer)
    await ctx.plugin(Hmr, { root: [], ignored: [], debounce: 0 })
    const failures: Error[] = []
    ctx.on('hmr/config-update-failed', (_filename, error) => { failures.push(error) })
    const dispose = await watchProfileManifest(ctx, {
      binName: NAME,
      manifestPath,
      currentBundles: [],
      retryDelaysMs: [5],
      maxRetries: 3,
      readBundles: () => readBundlesOf(manifestPath),
      resolveStack: resolver.resolveStack,
    })
    try {
      await eventually(() => failures.length >= 1, 'pending give-up was not broadcast')
      expect(resolver.calls()).toBe(3)
      expect(failures[0]).toBeInstanceOf(BundlePendingError)
      expect(entryConfig(ctx, 'extra')).toBeUndefined()
    } finally {
      await dispose()
      await ctx.fiber.dispose()
    }
  })

  it('reports a permanent resolver failure without touching the tree', async () => {
    const dir = tmp()
    const manifestPath = join(dir, 'package.json')
    writeFileSync(manifestPath, JSON.stringify({ dsh: { profile: { bundles: ['fixture-bundle'] } } }))
    const ctx = await boot(NAME, writeTree(dir))
    await ctx.plugin(Timer)
    await ctx.plugin(Hmr, { root: [], ignored: [], debounce: 0 })
    const failures: Error[] = []
    ctx.on('hmr/config-update-failed', (_filename, error) => { failures.push(error) })
    const dispose = await watchProfileManifest(ctx, {
      binName: NAME,
      manifestPath,
      currentBundles: [],
      readBundles: () => readBundlesOf(manifestPath),
      resolveStack: () => { throw new Error('permanent failure') },
    })
    try {
      await eventually(() => failures.length >= 1, 'permanent failure was not broadcast')
      expect(failures[0]?.message).toContain('permanent failure')
      expect(entryConfig(ctx, 'extra')).toBeUndefined()
    } finally {
      await dispose()
      await ctx.fiber.dispose()
    }
  })

  it('returns a no-op disposer when the tree is disposed while the watcher opens', async () => {
    const dir = tmp()
    const ctx = await boot(NAME, writeTree(dir))
    try {
      const teardown = Object.assign(new Error('cannot create effect on inactive context'), { code: 'INACTIVE_EFFECT' })
      ctx.provide('hmr', { registerConfig: () => Promise.reject(teardown) })
      const dispose = await watchProfileManifest(ctx, {
        binName: NAME,
        manifestPath: join(dir, 'package.json'),
        currentBundles: [],
        readBundles: () => [],
        resolveStack: () => [],
      })
      await expect(dispose()).resolves.toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('propagates registration failures other than mid-teardown', async () => {
    const dir = tmp()
    const manifestPath = join(dir, 'package.json')
    writeFileSync(manifestPath, JSON.stringify({ dsh: { profile: { bundles: [] } } }))
    const ctx = await boot(NAME, writeTree(dir))
    try {
      await ctx.plugin(Timer)
      await ctx.plugin(Hmr, { root: [], ignored: [], debounce: 0 })
      const dispose = await watchProfileManifest(ctx, {
        binName: NAME,
        manifestPath,
        currentBundles: [],
        readBundles: () => [],
        resolveStack: () => [],
      })
      await expect(watchProfileManifest(ctx, {
        binName: NAME,
        manifestPath,
        currentBundles: [],
        readBundles: () => [],
        resolveStack: () => [],
      })).rejects.toThrow('already registered')
      await dispose()
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('resolveProfileLiveStack', () => {
  afterEach(() => {
    delete process.env.DSH_HOME
  })

  it('uses the default Harness home when none is passed', () => {
    const home = tmp()
    process.env.DSH_HOME = home
    const profileDir = resolveProfileDir('web', home)
    initProfile(profileDir, [])
    const stack = resolveProfileLiveStack({
      binName: NAME,
      name: 'web',
      installAnchor: join(profileDir, 'package.json'),
      overlays: [],
    })
    expect(stack).toEqual([])
  })

  it('tolerates a bare manifest and a missing patch file', () => {
    const home = tmp()
    const profileDir = resolveProfileDir('web', home)
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', private: true }))
    const stack = resolveProfileLiveStack({
      binName: NAME,
      name: 'web',
      installAnchor: join(profileDir, 'package.json'),
      home,
      overlays: [],
    })
    expect(stack).toEqual([])
  })

  it('throws BundlePendingError for a listed bundle that is not installed yet', () => {
    const home = tmp()
    const profileDir = resolveProfileDir('web', home)
    initProfile(profileDir, ['not-installed-yet'])
    expect(() => resolveProfileLiveStack({
      binName: NAME,
      name: 'web',
      installAnchor: join(profileDir, 'package.json'),
      home,
      overlays: [],
    })).toThrow(BundlePendingError)
  })

  it('stacks bundle layers, user layers, and overlays in application order', () => {
    const home = tmp()
    const profileDir = resolveProfileDir('web', home)
    initProfile(profileDir, ['fixture-bundle'])
    const bundleDir = join(profileDir, 'node_modules', 'fixture-bundle')
    mkdirSync(bundleDir, { recursive: true })
    writeFileSync(join(bundleDir, 'package.json'), JSON.stringify({
      name: 'fixture-bundle',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }))
    writeFileSync(join(bundleDir, 'cordis.patch.yml'), '- insert:\n    - id: fixture\n      name: ./extra.mjs\n')
    writeFileSync(join(profileDir, PROFILE_PATCH_FILENAME), '- id: fixture\n  config:\n    userLayer: true\n')
    writeFileSync(join(home, PROFILE_PATCH_FILENAME), '- id: fixture\n  config:\n    homeLayer: true\n')
    const overlays: PatchOptions[] = [{ id: 'fixture', config: { overlay: true } }]
    const stack = resolveProfileLiveStack({
      binName: NAME,
      name: 'web',
      installAnchor: join(profileDir, 'package.json'),
      home,
      overlays,
    })
    expect(stack).toEqual([
      { insert: [{ id: 'fixture', name: './extra.mjs' }] },
      { id: 'fixture', config: { userLayer: true } },
      { id: 'fixture', config: { homeLayer: true } },
      { id: 'fixture', config: { overlay: true } },
    ])
    // Fresh clones per call: mutating one generation never leaks into the next.
    const again = resolveProfileLiveStack({
      binName: NAME,
      name: 'web',
      installAnchor: join(profileDir, 'package.json'),
      home,
      overlays,
    })
    expect(again).toEqual(stack)
    expect(again[0]).not.toBe(stack[0])
  })
})
