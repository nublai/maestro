# @nubl/maestro 0.1.0 release readiness

## 0.1.1 corrective candidate

`0.1.1` only widens `engines.node` to `>=22.19.0` (pi's floor); no code
changes (see [`CHANGELOG.md`](../CHANGELOG.md)). With npm `engine-strict`,
0.1.0's `>=26.12.1` refused Node 22 installs (`EBADENGINE`, reproduced on
22.19.0).

- file: `nubl-maestro-0.1.1.tgz`, packed on Node 26.12.1
- sha256: `d7dc32d5b55992a300b26916755a0bfbb3fbc93cf22b3669df6380fa2087f26f`
- `test:package` against this tarball passed on Node 22.19.0, 22.23.5 and
  26.12.1; `npm install --engine-strict` of it succeeds on 22.19.0.
- The source suite (`npm test`) stays Node 26: on Node 22 five tests in
  `test/pi-adapter-paths.test.ts` are cancelled because Node 22's test runner
  exits while a test awaits only unref'd timers (the capture loop unrefs them
  on purpose). With the event loop held open they pass on 22.19.0.

Release it the same way as below, with tag `v0.1.1`, and pin consumers to
`"@nubl/maestro": "0.1.1"`. The rest of this document describes 0.1.0.

**Status:** ready, waiting for the founder's go. `package.json` says `0.1.0`;
npm still has only the `0.0.1` placeholder. Nothing has been tagged or
published.

The candidate is `npm pack` of the M6 branch:

- file: `nubl-maestro-0.1.0.tgz`
- sha256: `326553172ca063ec2407f2e458592f784419acc4b6fa16ba766f611a71f90f6b`

Local H2 parity ran against this exact candidate; see
[`provenance/m6/README.md`](../provenance/m6/README.md).

## What 0.1.0 contains

A mechanical extraction of the pi-herdr-agents engine and Pi tool contract. It
was copied byte-for-byte from `giuseppecrj/pi-herdr-agents`:

- main base: `4cae65fbc5f9d71c2b29bf76d94247f5c1e653d5`
- copies: local H1 `fd9c5d567430f72660e8505eb132c2a64709bfed`

Both SHAs are recorded in `dist/provenance.json`.

- **Engine (`@nubl/maestro`, same as `./engine`).** `createRunSession`,
  `defaultRetainSurface`, and the core `HarnessAdapter`, `SurfaceProvider`,
  task, handle and outcome types. Pi-free: it needs no peers and reads no
  config.
- **Testing (`./testing`).** `FakeHarnessAdapter`, `FakeSurfaceProvider` and
  the two conformance runners.
- **Pi runtime (`./runtime`).** `createDefaultRunSession`, which needs an
  explicit `HostSurfaceBinding`. There is no provider auto-discovery.
- **Pi tool surface (`./pi`, `./pi/extension`).** `createPiExtension(hostOptions)`
  registers `subagent`, `subagent_resume`, `subagent_cancel`, `subagent_send`,
  `subagent_stop`, `caller_ping` and the rest. Their names, parameters,
  acknowledgements, results and `delegation-outcome/v0.1` are unchanged. The
  frozen schema fixtures are matched from the installed tarball.
- **Child (`./pi/child`).** The protocol-only child extension (default) and
  `createChildExtension(renderWidget)`. Launches load the emitted
  `dist/maestro/adapters/pi/child/entry.js` unless the host passes
  `childEntryPath`.
- **Internal-compat families, no stability promise.** `./core/*`, `./runtime/*`,
  `./adapters/pi/*` (including the child protocol modules) and
  `./pi/subagents/*` (including `index`). The map is finite: 95 exports in all.
- **Assets.** `dist/config.json.example`, declarations, and source maps with
  inline sources, plus this repository's MIT LICENSE.

Not included:

- Herdr or Core providers, terminal widgets and renderers, the sidebar, and
  the terminal entry. These stay in pi-herdr-agents.
- Experimental worker entries (M5).
- Any Pi auto-discovery manifest or `extensions/`/`skills/` directories.

Requirements:

- Node `>=22.19.0` for consumers (pi's own floor, so the extraction does not
  narrow who can install pi-herdr-agents). Development and the source suite
  stay on Node `>=26.12.1`; CI's `node22-runtime` lane installs the packed
  tarball and runs `test:package` on Node 22.19.0.
- Optional `"*"` peers, which the Pi entries require: `@earendil-works/pi-ai`,
  `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui` and
  `@sinclair/typebox`.

## How to release (founder's go required)

1. Choose stable `0.1.0` or a first `0.1.0-rc.N` on `next`.
   - For an rc, set the version, rebuild the candidate, and rerun
     `test:package` and the H2 checks against the new tarball. The packed
     `package.json` changes, so the old hash no longer applies.
2. Merge M6. Push the tag `v0.1.0` (or `v0.1.0-rc.N`) on that commit.
   `.github/workflows/publish.yml` then:
   - checks the tag against the version;
   - runs the gates;
   - tests and hashes the packed tarball;
   - publishes it through the `npm-publish` environment with OIDC.
3. Confirm the registry tarball matches the candidate:
   - run `npm pack @nubl/maestro@0.1.0`;
   - compare the extracted file contents with the candidate tarball and the
     workflow's recorded SHA-256;
   - confirm `dist/provenance.json` still names the current upstream main.

Never publish from a laptop, and never use a long-lived token.

## Consumer: pi-herdr-agents (H2 finalization)

Local branch `h2/consume-maestro` does steps 1–6 against the `file:` candidate.
After publishing:

1. **Re-check the pin.**
   - Upstream main must still be `4cae65f`, and H1 must still be `fd9c5d5`.
   - If main moved, refresh H1 and Maestro first (plan §1). Do not switch on a
     stale candidate.
   - Run `npm run check:maestro-pin`.
2. **Use the registry version.** Replace the `file:vendor/...` dependency with
   the exact registry version: `"@nubl/maestro": "0.1.0"`, without `^`.
   - Delete `vendor/`.
   - Run `npm install`.
   - Rerun `check:maestro-pin`.
3. **Keep the redirected imports.** Retained modules, tests and lab scripts
   import moved modules from `@nubl/maestro/<subpath>`. Maestro's
   `scripts/redirect-host-imports.ts <checkout>` rewrites them mechanically.
4. **Keep one factory.** `pi-extension/subagents/index.ts`:
   - stays the only Pi extension in `package.json` `pi.extensions`;
   - calls `createPiExtension` from `@nubl/maestro/pi` once per load, with
     `hostSurfaceBinding`, the widget and renderer presentation hooks,
     `childEntryPath` (the legacy forwarder) and `configAssetRoot`
     (the host's root).

   Never also load `@nubl/maestro` as a Pi package or extension: that would
   register every tool twice.
5. **Keep the compatibility paths.**
   - `maestro/adapters/pi/child/subagent-done.ts` re-exports
     `@nubl/maestro/adapters/pi/child/protocol` and defaults to `child.ts`, so
     old launch artifacts and session policies still resolve.
   - `child.ts` calls `createChildExtension(renderChildWidget)` from
     `@nubl/maestro/pi/child`.
   - Keep the `herdr-agents` config directory, artifact names, outcome ledger
     and `Symbol.for` keys.
6. **Run the gates.**
   - `format:check`, `docs:tools:check`, `lint`, `typecheck`, `npm test` and
     `npm pack --dry-run`.
   - The lab integration driver (`scripts/run-linux-integration.ts`) with
     Herdr, Core and Pi.
   - The combined coverage gate (Maestro
     `scripts/combined-coverage.ts`).
7. **Switch over.** Finish or drain live children, upgrade, then restart Pi.
   `/reload` works within a version but does not adopt runs across versions.
8. **Clean up later.** The reviewed switch then deletes the local moved copies
   and their duplicate tests (H3). Keep every upstream-only assertion listed
   in `provenance/m6/counterparts.json` (`upstream_only`).

## Consumer: pi-worker

0.1.0 has no worker exports, so pi-worker changes nothing:

- It keeps using its locally packed experimental A0 tarball until M5 and a
  separately authorized experimental release.
- Its supervisor never imports Maestro.
- Its Pi processes keep selecting their parent and FD-child extension paths
  through `launch_spec.resources.extensions`.

Do not point pi-worker at `@nubl/maestro@0.1.0`'s stable entries. Their
`subagent` contract differs from A0's worker tools.

## Rollback

- **Before H2 finalization.** Do nothing: pi-herdr-agents `main` still bundles
  its engine.
- **After the host switch (packaging or contract regression):**
  1. Stop new delegation. Let owned runs settle, or cancel or stop them and
     confirm termination.
  2. Revert the host to its recorded bundled-engine revision, the commit
     before the switch, and restart Pi.
  3. Leave retained worktrees, branches and evidence untouched. Never
     automatically re-run a task.
- **A defective published version.**
  - Ship a corrective release (for example `0.1.1`), or pin consumers back to
     the previous good version.
  - `npm deprecate` the bad version with a pointer.
  - Never unpublish or overwrite it, and never publish locally.
- **pi-worker** is unaffected. Its experimental entry and version are
  independent.
