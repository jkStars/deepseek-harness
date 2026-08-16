/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-token-usage-stats-web`.
 * @module @deepseek-ai/dsh-token-usage-stats-web/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-token-usage-stats-web'

/** Cordis companion plugin name. */
export const name = 'token-usage-stats-web-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the package only registers two read-only HTTP routes
 * whose responses derive from the already validated snapshot returned by
 * `ctx.tokenUsageStats.snapshot()`. The plugin never mutates session state and
 * the webserver owns route lifetime and collision checks.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
