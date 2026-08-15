# Agent Note: Live profile plugin-set hot reload

Status: implemented

English | [中文](2026-08-15-live-profile-plugin-set-hot-reload.zh.md)

## Problem

`dsh plugin add/remove` rewrites the profile's `package.json` while a long-lived surface (`dsh web`, `dsh --profile headless`) may be running, yet the running instance could not pick up a plugin-set change: bundle layers were snapshotted at boot (`composeLive` held `composed.bundlePatches` statically), and client-modules cached "not a client package" verdicts forever ("plugin-set changes take effect on restart"). Installing or removing a plugin forced a full restart — the exact friction the live `cordis.patch.yml` editing already removed for configuration.

## Decision

Long-lived surfaces watch the profile manifest. `watchProfileManifest` (app-boot) registers the profile's `package.json` with the existing Cordis HMR service; a write whose `dsh.profile.bundles` list changed re-resolves the whole stack through `resolveProfileLiveStack` (bundle layers re-read from disk, then the profile patch file, the home patch file, and the static overlays, fresh-cloned per call) and lands through the same transactional root-Include reapply as the patch-file watchers (`reapplyRootInclude`). A listed bundle whose `node_modules` entry is not materialized yet — the pnpm install race — throws `BundlePendingError`; the watch retries with bounded backoff (default 250→5000 ms, 12 attempts) before failing through the same `hmr/config-update-failed` channel. A write that leaves the bundle list unchanged (a dependency-only edit or a version bump) is skipped.

The browser half turns the plugin-set change into one page reload: the hmr node half now broadcasts every graph change over `/plugins/events` (previously only the connect-time snapshot), and the browser half compares the frame's `graph.rev` with the page's boot-manifest rev and issues one `location.reload()` on mismatch. Rows the boot manifest never named cannot hot-swap, so reload is the intended granularity, and the fresh page's manifest carries the new rev so the reload cannot loop.

## Trigger surface

Host commands from the new plugin work immediately after the tree reapply (the fiber mounts without a page reload); the client selector or UI appears after the browser reload. Removal is symmetric: the recomposed stack no longer inserts the row, `root.update` disposes the fiber, client-modules drops the row, the graph rev changes, and the browser reloads. A version update of an already-listed bundle (`dsh plugin update`) leaves the running host code unchanged until restart — module-level reload stays disabled in the web composition — while the updated client bundle still hot-swaps through the stat poll.

## Alternatives considered

- **CLI → server IPC** (`dsh plugin` notifies a running instance). More explicit, but adds a second wire protocol and a liveness probe; the manifest file is already the single write surface and the config-HMR pattern proves file-watch triggers suffice.
- **Live-setGraph client API** (incremental row swap in the module system). Removes the page reload but rebuilds the browser loader tree mid-session, with cascade races the serialized reload path already solves for known rows; not worth v1.
- **Re-enable the module-level `hmr` row** for host code. The web bundle disables it deliberately (its reload lifecycle is untested); the config-tree reapply path is the tested mechanism and covers the plugin-set case without it.

## Consequences

- **Bought**: plugin add/remove on a running surface, host code immediate, UI after one automatic reload; no CLI changes (`dsh plugin` remains the pnpm writer, the running surface is a manifest consumer); failure containment reuses the proven transactional tree update — a bad bundle rolls back and the last good tree stays active.
- **Cost**: a missed change event on the exact manifest file (a native-watch drop) delays the plugin set to the next event or restart — `dsh plugin add/remove` writes well-separated events, so the gap is theoretical; graph-change broadcasts ride the dev SSE channel, a new host-side broadcast with no session-log surface.
- **Boundary kept**: module-level host reload stays disabled; `dsh plugin update` still needs a restart for host code; the plugin set remains a user-initiated file write, so the change adds no trust surface beyond the file the user already edits.
