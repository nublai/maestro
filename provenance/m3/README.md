# M3 Pi adapters/runtime and host ports evidence

Source repository `giuseppecrj/pi-herdr-agents`. `base_main_sha` is
`4cae65fbc5f9d71c2b29bf76d94247f5c1e653d5` (existing local `origin/main`, no
fetch). `copy_sha` is `27dee407403906d5bac359702e21a04309be2f64`, the local H1
branch `h1/composition-hooks` (parent 4cae65f). H1 is local-only, so every
pinned blob is archived under `../upstream/` and verified by Git blob ID in
both archive and local-upstream modes. Nothing upstream was changed.

## Drift ledger (add35f4..4cae65f)

`../drift-ledger.json` is closed with three entries:

- **4cae65f (#145)** carried: `completion.ts`, `launch.ts` and
  `pi-harness-adapter.ts` are copied from 27dee40, which contains the fix. Its new
  `completion.ts` case moved with the monolith completion suite (a post-baseline
  identity). Its host-adapter-migration case stays upstream with the retained
  `withAdapterHost` Herdr/extension fixture. `docs/tools.md` is a split contract
  asset for M4, which copies it from this pin.
- **e7f190a (#144)** no impact: host CI workflow.
- **d78ad4e (#142)** no impact: host agent guidance and skill text.

M2's 43 copied production files and 7 support copies are byte-identical at
27dee40. M2's migrated selections from the three test sources that changed
(`test.ts`, `script-launch.test.ts`, `herdr-core-execution.test.ts`) re-anchor
without any text change. Identity-baseline anchors into archived add35f4 blobs
(`../baseline/upstream/`) keep their original identities matching.

## Copies

- **29 production copies**, with no import rewrites:
  - 20 `maestro/adapters/pi/*` files. These include the H4 `child/protocol.ts`
    and the protocol-only `child/entry.ts`, whose emitted `entry.js` is the
    launch default (`DEFAULT_CHILD_ENTRY_PATH`).
  - 9 `maestro/runtime/*` files. These include the H1 `HostSurfaceBinding` port
    (`host-surface-binding.ts`) and the structural marker DTOs in
    `delegated-marker.ts`.
- `child/subagent-done.ts` stays upstream. At H1 it only forwards to
  `pi-extension/subagents/child.ts`, the terminal widget wrapper. H1 deleted
  `herdr-backend.ts`.
- `hostSurface` is optional in the type. `createDefaultRunSession` enforces it
  unless the closed injected-infrastructure composition is used.
- 3 test-helper copies: `mock-extension-api.ts`, `process-cleanup.ts` and
  `socket-path.ts`.
- No new production or facade file. The manifest now has 82 copies and 2 new
  files, all from M2.
- `../inventory.json` `h1_delta` classifies every path that H1 added or deleted.
- `scripts/refresh-copies.ts <upstream>` re-copies every manifest entry from the
  pin and re-anchors test selections. A changed migrated case fails instead of
  being refreshed silently. If H1 changes, update `copy_sha` and run it, then
  `migrate-tests.ts` and `map-coverage-lines.ts`.

## Tests

`../m3-test-plan.json` drives `scripts/migrate-tests.ts`. The script moves every
case whose helpers, hooks, imports and literal resource paths already exist here,
recursing into suites, and writes `../m3-test-map.json`. Cases a previous step
moved are skipped. Explicit exclusions carry reasons:

- the terminal child-widget case;
- a Herdr CLI case;
- the `persistent subagent stop` suite, whose hooks bind the extension runtime
  slot (M4);
- a source-scan guard over the retained Herdr files.

The three finite import remaps are:

- `child/subagent-done.ts` -> `child/protocol.ts` (same named exports; the default
  omits only the upstream terminal widget);
- `herdr-socket.ts` marker DTO types -> `runtime/delegated-marker.ts` (H1's
  structural copies).

`check-test-migration` proves token-identical bodies against the pinned blobs.

- **519 M3 identities**: 517 original baseline identities plus 2 cases added
  upstream after the baseline. One is #145's completion case. The other is H1's
  "loads the explicit child entry path, quoted, in fresh and resumed launches".
  Both are listed by exact title.
- One baseline case changed in H1 (`pi-run-session.test.ts` handoff transaction)
  and is matched by its unchanged header.
- Together with M2: 874 original identities verified, 895 remain upstream. Every
  nested title and skip status matches actual Node events. No M2 identity was
  lost.
- Two supplemental files, `test/pi-host-ports.test.ts` and
  `test/pi-adapter-paths.test.ts` (13 tests), cover copied paths upstream reaches
  only through retained Herdr/Core providers, the terminal child forwarder or the
  tool surface. They cover HostSurfaceBinding composition and reload refusal,
  Core native launch/resume, scoped resume, identity capture/probe and real-Git
  cleanup operations. They are not counted as migrated identities.

## Coverage

`../coverage-manifest.json` now maps each copied original file to its
destination with `split_line_map` (`scripts/map-coverage-lines.ts`, an
indentation-insensitive LCS line diff against the add35f4 coverage baseline).

- A whole-file identity copy keeps its exact M1 original-file floor.
- A file H1/#145 changed is held to the baseline hit rate on the same mapped
  lines. Destination-file coverage is reported as well.
- `subagent-done.ts` maps to `child/protocol.ts` (619/655 lines).

All 66 measured original files owned here meet their floors (final run
`evidence/unit-run-SlQhWI`):

| Population | Files | Arithmetic line mean | Subset floor mean | Weighted |
| --- | ---: | ---: | ---: | ---: |
| Core | 36 | 98.964743% | 98.048595% | 99.004975% |
| Runtime (owned subset) | 9 | 99.037157% | 98.830313% | 98.561785% |
| Adapters/tools (Pi + fake harness) | 20 | 97.011273% | 96.995117% | 96.192708% |
| Fake surface | 1 | 90.282132% | 90.282132% | 90.282132% |

The full 10-file runtime floor of 98.94096225077136% includes deleted
`herdr-backend.ts`, whose logic now lives in the host's `host-surface.ts`. That
floor and the surfaces floor remain the M6/H2 combined gate.

- `coverage.json` holds the per-file report.
- `coverage.json.gz` holds the raw line/branch/function records.
- `test-identities.json.gz` holds the full identity ledger with owners.
- `runs.json` indexes every local attempt, including failing gate attempts.

## Package

`test:package` installs the tarball twice:

- **Peer-free install.** The 12 exports whose emitted closure imports Pi or
  TypeBox fail with `ERR_MODULE_NOT_FOUND` naming the peer. Every other export
  loads and typechecks.
- **Host that provides the peers.** Its `node_modules` holds Pi and TypeBox, as
  Pi's install does. In this install:
  - every Pi entry loads from emitted JS, with no loader;
  - `createDefaultRunSession` refuses to compose without a binding;
  - a fake binding composes and launches, and the command loads the installed
    `entry.js` by its quoted path containing spaces;
  - the emitted child's tools, schemas and handlers equal the source entry's in
    three environment variants;
  - declarations typecheck against the peers.

`check:boundaries` also rejects runtime, launch, provider or TUI imports in the
child entry closure.

## Gates and limitations

Node 26.13.0 / npm 11.20.0. Unit and coverage runs used `PATH=/usr/bin:$PATH`.
All of these passed:

- `npm ci --ignore-scripts`, `format:check`, `lint`, `typecheck`;
- `npm test` (951/952, one original skip);
- `test:fidelity` (19/19);
- `check:copy-fidelity` (archive and local: 82 copies, 2 new);
- `build`, `check:boundaries`, `test:coverage`, `test:package`;
- `npm pack --dry-run` (311 files);
- `docs:tools:check` (the M4 guard);
- the M3 focused run (`pi-run-session`, `audit-reload`, `accept-recheck`: 77/77).

Not claimed:

- the minimum-Node 26.12.1 lane, which stays CI-pinned;
- a real Pi child process: the child smoke uses a capture API, not Pi's loader;
- the local H1 adapter check;
- M4 tool, schema and config-asset gates;
- real-loader reload probes.

H1 is under independent review, so a changed H1 needs a re-copy with the tools
above. Source text was treated as evidence only. Nothing was fetched or pushed,
no upstream file was changed, and no credentials are present.
