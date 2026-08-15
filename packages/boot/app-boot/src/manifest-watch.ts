/**
 * Live profile-manifest watching: `dsh plugin add/remove` rewrites the
 * profile's package.json (dependencies plus `dsh.profile.bundles`) while a
 * long-lived surface runs. This watch re-reads the manifest, recomposes the
 * bundle patch stack through a caller-supplied resolver, and transactionally
 * reapplies it to the boot's root Include — so bundle rows mount and unmount
 * without restarting the surface. The pnpm install race (the manifest lists a
 * bundle before pnpm materializes its node_modules) is absorbed by bounded
 * backoff retries on {@link BundlePendingError}; every other failure follows
 * the config-HMR contract (broadcast as `hmr/config-update-failed`, last good
 * tree stays active).
 * @module @deepseek-ai/dsh-app-boot/manifest-watch
 */

import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import {
  loadOptionalPatches,
  reapplyRootInclude,
  resolveRootInclude,
} from './index.ts'
import {
  loadProfile,
  PROFILE_PATCH_FILENAME,
  readProfileManifest,
  resolveBundleDir,
  resolveProfileDir,
} from './profile.ts'

/**
 * Marker for a bundle that is listed in the manifest but not yet resolvable —
 * pnpm is still materializing node_modules, so the watch retries instead of
 * failing the reconcile.
 */
export class BundlePendingError extends Error {
  constructor(
    /** The bundle name that is not resolvable yet. */
    readonly bundle: string,
    cause: unknown,
  ) {
    super(`profile bundle ${JSON.stringify(bundle)} is not installed yet`, { cause })
    this.name = 'BundlePendingError'
  }
}

/** Default backoff schedule for pending bundles; the last delay repeats. */
const DEFAULT_RETRY_DELAYS = [250, 500, 1000, 2000, 5000] as const

/** Default pending-bundle attempt cap before the reconcile fails loud. */
const DEFAULT_MAX_RETRIES = 12

/** Whether two bundle lists have the same values in the same order. */
function sameBundles(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

/** Options for {@link resolveProfileLiveStack}. */
export interface LiveProfileStackOptions {
  /** Diagnostic prefix on thrown errors. */
  binName: string
  /** The profile name. */
  name: string
  /** Absolute path of the dsh app's package.json (first bundle resolution anchor). */
  installAnchor: string
  /** The Harness home; defaults to {@link resolveDshHome}. */
  home?: string
  /** Static layers applied above the user layers: `--patch` overlays and flag-derived patches. */
  overlays: readonly PatchOptions[]
}

/**
 * Resolve the full live patch stack of a profile: re-read the manifest's
 * `dsh.profile.bundles`, resolve every listed bundle to its parsed patch
 * layer, and stack the bundle layers, the profile patch file, the home patch
 * file, and the static overlays in application order. Fresh clones per call —
 * the include pushes `insert` rows into the mounted tree by reference and
 * later id-targeted patches mutate those objects in place, so reusing one
 * parsed patch object across applications would bake a user override into the
 * bundle's in-memory insert row. A listed bundle that cannot be resolved yet
 * throws {@link BundlePendingError} — the pnpm install race — instead of a
 * generic load failure.
 * @param options - profile identity, anchors, and the static overlay layers.
 * @returns the recomposed patch stack.
 */
export function resolveProfileLiveStack(options: LiveProfileStackOptions): PatchOptions[] {
  const { binName, name, installAnchor, home = resolveDshHome(), overlays } = options
  const profileDir = resolveProfileDir(name, home)
  const manifest = readProfileManifest(binName, profileDir)
  for (const packageName of manifest.dsh?.profile?.bundles ?? []) {
    try {
      resolveBundleDir(binName, packageName, installAnchor, profileDir)
    } catch (error) {
      throw new BundlePendingError(packageName, error)
    }
  }
  const fresh = loadProfile(binName, name, installAnchor, home)
  return structuredClone([
    ...fresh.layers.flatMap(layer => layer.patches),
    ...loadOptionalPatches(binName, fresh.patchPath) ?? [],
    ...loadOptionalPatches(binName, join(home, PROFILE_PATCH_FILENAME)) ?? [],
    ...overlays,
  ])
}

/** Options for {@link watchProfileManifest}. */
export interface ProfileManifestWatchOptions {
  /** Diagnostic prefix on thrown errors. */
  binName: string
  /** Absolute path of the profile's package.json. */
  manifestPath: string
  /** Bundle names composed at registration time. */
  currentBundles: readonly string[]
  /**
   * Read the bundle list from the current manifest. Throws on an unreadable
   * or malformed manifest — a permanent failure, reported through the
   * config-HMR failure channel.
   */
  readBundles: () => readonly string[]
  /**
   * Resolve the full patch stack from the current manifest state. Throw
   * {@link BundlePendingError} while a newly listed bundle is not yet
   * resolvable; the watch retries with backoff. Any other throw is permanent
   * and reported through the config-HMR failure channel.
   */
  resolveStack: () => readonly PatchOptions[]
  /** Backoff schedule (ms) for pending bundles; defaults to [250, 500, 1000, 2000, 5000], last repeats. */
  retryDelaysMs?: readonly number[]
  /** Pending-bundle attempt cap before failing loud; defaults to 12. */
  maxRetries?: number
}

/**
 * Watch the profile manifest through Cordis HMR and transactionally reapply
 * the recomposed patch stack to the boot include. A change whose bundle list
 * is unchanged is skipped (a dependency-only write or a version bump is not a
 * plugin-set change). A changed list re-resolves the stack, retrying while a
 * listed bundle is pending install, then reapplies through the same
 * transactional path as the user patch-layer watcher.
 * @param ctx - settled app context containing the root Include and an active HMR service.
 * @param options - manifest path, bundle readers, and stack resolver.
 * @returns an asynchronous disposer after the exact-path watcher is ready.
 * @throws when HMR or the root Include is absent, watcher setup fails, or initial path resolution fails.
 */
export async function watchProfileManifest(
  ctx: Context,
  options: ProfileManifestWatchOptions,
): Promise<() => Promise<void>> {
  const { binName, manifestPath } = options
  const hmr = ctx.get('hmr')
  if (hmr === undefined) throw new Error(`${binName}: profile-manifest watching requires the Cordis HMR service`)
  resolveRootInclude(ctx)

  const delays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES
  let bundles = [...options.currentBundles]

  const refresh = async (): Promise<void> => {
    const next = options.readBundles()
    if (sameBundles(next, bundles)) return
    let attempt = 0
    for (;;) {
      try {
        const patches = options.resolveStack()
        await reapplyRootInclude(ctx, patches)
        // Re-read after success: the manifest may have moved again while a
        // pending bundle was retrying, so the applied set is the final truth.
        bundles = [...options.readBundles()]
        return
      } catch (error) {
        if (!(error instanceof BundlePendingError)) throw error
        attempt += 1
        if (attempt >= maxRetries) throw error
        const delay = delays[Math.min(attempt - 1, delays.length - 1)]
        ctx.logger.warn(
          `${binName}: profile bundle ${JSON.stringify(error.bundle)} pending install (attempt ${attempt}/${maxRetries}); retrying in ${delay}ms`,
        )
        await new Promise(resolve => setTimeout(resolve, delay))
      }
    }
  }

  const register = hmr.registerConfig(manifestPath, refresh)
  try {
    return await register
  } catch (error) {
    // A surface can dispose the whole tree while the watcher is still opening;
    // the HMR effect registration then fails with INACTIVE_EFFECT. That is the
    // app exiting exactly as asked, so return a no-op disposer instead of crashing.
    if ((error as { code?: string } | null)?.code === 'INACTIVE_EFFECT') return async () => {}
    throw error
  }
}
