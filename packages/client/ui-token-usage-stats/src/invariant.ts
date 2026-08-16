/**
 * Package-owned invariant companion for
 * `@deepseek-ai/dsh-client-ui-token-usage-stats`.
 * @module @deepseek-ai/dsh-client-ui-token-usage-stats/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-token-usage-stats'

/** Cordis companion plugin name. */
export const name = 'ui-token-usage-stats-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the plugin contributes one static sidebar link whose
 * destination is the host-registered dashboard route. It owns no state and
 * writes nothing.
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
