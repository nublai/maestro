# M4 Pi tools and stable contract evidence

Source repository `giuseppecrj/pi-herdr-agents`. The pin does not move in M4:
`base_main_sha` is still `4cae65fbc5f9d71c2b29bf76d94247f5c1e653d5` (existing
local `origin/main`, no fetch), and `copy_sha` is still
`27dee407403906d5bac359702e21a04309be2f64` (local H1 `h1/composition-hooks`,
reviewed: no behaviour change). The 4cae65f..4cae65f drift range is empty, so
the ledger is closed with no entries. M3 deferred one item of #145
(`docs/tools.md`), and M4 carries it: the doc is copied from 27dee40. Nothing
was fetched, pushed or changed upstream. The upstream checkout was only read
(`git show`, `git archive`).

## Copies

28 new byte-identical copies, with no import rewrites (`mappings` stays empty):

- **18 production modules** under `pi-extension/subagents/`: tool schemas and
  registration (`launch-tools`, `control-tools`, `worktree-tools`,
  `task-models`), the per-load controllers (`controls`, `persistent`,
  `delivery`, `launch`, `observation`, `deferred-tools`), state and catalog,
  the `ParentMessage` serializer (`presentation.ts`), the encoding boundary,
  config paths, model registry glue, the `PiPresentationHooks` contract and
  `extension.ts` (`createPiExtension`).
- **10 split contract assets**: `docs/tools.md`,
  `docs/delegation-outcome-contract.md`, both tool-schema fixtures (one blob,
  `7720f56`), `scripts/tool-docs.ts`, `scripts/update-tool-docs.ts`,
  `test/helpers/tool-schema-compat.ts` and the three role-pack example files.

The manifest now holds 110 copies and 3 new files. The new file is
`maestro/pi.ts`, the `@nubl/maestro/pi` facade, which only re-exports copies.
These stay upstream, and `test/scaffold.test.ts` asserts they are absent here:

- the terminal entry `index.ts` (it calls the factory with the host's hooks);
- `host-surface.ts`, `marker-transport.ts`;
- `widgets.ts`, `renderers.ts`, `tool-renderers.ts`;
- the child wrapper (`child.ts`, `child-widget.ts`).

The copies import no pi-tui module (`check:boundaries`).

**Declarations.** H1's `extension.ts` infers `createPiExtension`'s return type
from three interfaces that its siblings do not export, so declaration emit
fails (TS4058). `scripts/build.ts` keeps the copies byte-identical:

- JavaScript and source maps come from the unmodified sources.
- A second, declaration-only pass reads `SubagentInterruptDetails`,
  `SubagentSendDetails` and `SubagentStopDetails` as exported. Each rewrite
  must match exactly once.

The clean fix is for H1 to export them. The build also ships
`config.json.example` as `dist/config.json.example`, the factory's default
asset root.

**Exports.** There are 89 finite exports. M4 adds `./pi` and 18
`./pi/subagents/<module>` compatibility paths (internal-compat, no stability
promise). There is no `./pi/subagents/index` and no `./pi/extension`; both
wait for M6.

## Tests

`../m4-test-plan.json` drives `scripts/migrate-tests.ts` over 17 source files.
The resulting map is `../m4-test-map.json`.

- **Test entry.** Cases that imported the upstream terminal entry import
  `test/helpers/pi-extension.ts`. It calls the real `createPiExtension` once per
  module load, with fake host hooks:
  - presentation records refresh calls and registers nothing;
  - the binding runs the unchanged core selection;
  - providers refuse every terminal operation.
  A case that needs a terminal therefore fails here and stays upstream.
- **Resource mapping.** Per-load reload and config cases import the entry
  fresh with `import(\`...index.ts?reload-${n}\`)`. A finite
  `resource_mappings` list rewrites only that module path inside dynamic
  `import()` arguments. `check-test-migration` applies the same rewrite before
  its token comparison, and `test/test-migration.test.ts` covers the positive
  and negative cases.
- **Exclusions.** 15 cases assert terminal widget or renderer output, and two
  of them are whole suites. All are excluded with reasons. The
  `persistent subagent stop` suite that M3 held back now moves.
- **Adapted helper.** `test/helpers/tool-schema-capture.ts` takes its parent
  and child entries as a parameter (plan §5/D3). It defaults to the source
  factory and child entry; `test:package` passes the installed ones.
  `../adapted-helpers.json` is checked by `checkTestMigration`: every pinned
  statement except `captureScope`/`captureToolSchemas` must stay
  token-identical, and only `ExtensionEntries`/`sourceEntries` may be added.

**429 original identities moved in M4.** Cumulative: 1,303 of 1,769, plus 3
post-baseline cases. The new one is #145's host-adapter-migration case, which
M3 had to leave upstream. From the monolith, 446 of 496 identities have moved.

**The ledger is complete.** All 466 identities that stay upstream have a
reason in `retained-ledger.json`, written by `scripts/retained-ledger.ts`.
`npm test` asserts that the ledger names exactly the identities each run leaves
upstream.

- **Herdr/Core provider, transport or lab coverage**: Appendix B "stay" files,
  plus split cases whose closure needs `surfaces/herdr/*`, `host-surface.ts`,
  `marker-transport.ts`, the fake Herdr socket or the child forwarder path. The
  ledger names each unavailable import with its specifier.
- **Terminal presentation**: the 15 excluded cases and one
  `createWidgetController` case.
- **Host packaging/release/lab policy** files.
- **`test-environment.test.ts`** (68 identities). It reads the host's npm
  script. Its Maestro counterpart, a guard that every migrated or `test/pi-*`
  entry scrubs the inherited environment first, is in `test/pi-factory.test.ts`.
- **`dependency-rule.test.ts`** (14). Its rule table encodes the host's
  file-level allowlist; `check:boundaries` is the Maestro boundary check.
- **`system-prompt-mode.test.ts`** (1). It is a self-contained simulation with
  no `node:test` cases and imports no package code.

`test/pi-factory.test.ts` adds 9 supplemental cases. They are not counted as
identities. They cover:

- registrations equal H1's pinned parent and child/deny-tool contract (archived
  `test/fixtures/h1-contract.json`, blob-checked against the pin);
- renderer hook attachment;
- timer disposal and config refresh on each load;
- adoption of the runtime slot;
- cold versus redraw observation routing (the factory side of a retained
  widget case);
- legacy row normalization;
- child `/worktree list`;
- the config asset root;
- the first-import guard.

## Contract fixtures

`test/fixtures/tool-schema/current.json` and `released.json` are byte-identical
copies. They were not regenerated. They are matched in four places:

- `npm test` (`tool-schema.test.ts`, 22 cases) captures from the actual factory
  plus the protocol child entry, in parent and opted-in persistent child scopes.
- `docs:tools:check` runs the copied `update-tool-docs.ts --check` against the
  fixture and the generated blocks of `docs/tools.md`. A deliberately stale
  block was detected.
- `test:package` captures from the installed tarball.
- The `released.json` compatibility rules report no breaking change.

The `delegation-outcome/v0.1` suites run through the actual factory. Those are
the "host lines resist child-controlled text", "parent messages are
structured, not cut", "tool error boundary" and "public launch errors and
executable commands" suites, plus the persistent send/stop/notice suites.

## Coverage

`test-unit.ts` now includes `pi-extension/**`. `scripts/map-coverage-lines.ts`
(step label `M4`) maps the 17 measured pi-extension originals. `index.ts` maps
to its split-out `extension.ts` (508/570 lines); `control-tools.ts` (224/332)
and `launch-tools.ts` (502/627) lost their renderer lines upstream.

The first coverage run fell short on three files: `index.ts`, `observation.ts`
and `worktree-tools.ts`. The missing lines were reached only through retained
widget or Herdr cases. Supplemental cases fixed this; no floor changed. All 83
owned original files now meet their floors (final run `evidence/unit-run-plKjP4`):

| Population | Files | Arithmetic line mean | Subset floor mean | Weighted |
| --- | ---: | ---: | ---: | ---: |
| Core | 36 | 98.993133% | 98.048595% | 99.092771% |
| Runtime (owned subset) | 9 | 99.135100% | 98.830313% | 98.796595% |
| Adapters/tools (Pi + tools + fake harness) | 37 | 96.680244% | 96.639945% | 96.122685% |
| Fake surface | 1 | 90.282132% | 90.282132% | 90.282132% |

`coverage.json` records the correct `base_main_sha` (M3's report used the copy
SHA). The full runtime and surfaces floors remain the M6/H2 combined gate.

## Package and wrapper comparison

`test:package` adds an installed-JS factory smoke.

- `scripts/capture-pi-factory.ts` runs from `@nubl/maestro/pi` and from source,
  and the two must be equal.
- Both must also equal H1's pinned contract (tools, commands, handler counts,
  `__test__` keys), with one registration each. Message renderers register
  only through the host hook.
- Each load re-reads user config.
- The default config example resolves under the installed `dist/`.
- The installed factory plus child entry reproduce `current.json`.
- Peer-free typechecking skips 31 exports whose JS or declarations name a peer.
  A host with the peers typechecks all of them.

`scripts/compare-upstream-wrapper.ts` is local only and not a CI dependency.
It extracts the pinned H1 tree twice with `git archive`:

- **A** is the pristine host.
- **B** is the host whose terminal entry imports `createPiExtension` from the
  installed tarball, with its own `extension.ts` deleted.

Both trees pass H1's own pin (parent and child/deny-tool), presentation, real
Pi loader `/reload` and `docs:tools:check` probes against H1's frozen
fixtures. Their full registration captures are equal: every JSON field of
every tool, function presence, commands, renderers, handler counts, exports
and `__test__` keys. A mutated tarball, with one tool label changed, failed
the comparison. `runs.json` indexes every unit run, including failures, and
the wrapper run.

## Gates and limitations

Node 26.13.0 / npm 11.20.0, after `rm -rf node_modules dist`. Unit and coverage
runs used `PATH=/usr/bin:$PATH`. All of these passed:

- `npm ci --ignore-scripts`, `format:check`, `lint`, `typecheck`;
- `npm test` (1,392/1,393, one original skip);
- `test:fidelity` (21/21);
- `check:copy-fidelity` in archive and local modes (110 copies, 3 new);
- `build`, `check:boundaries`, `test:coverage`, `docs:tools:check`,
  `test:package`;
- `npm pack --dry-run` (388 files);
- the wrapper comparison.

Not claimed:

- the minimum-Node 26.12.1 lane;
- the M6/H2 combined coverage gate;
- a real Pi loader run of the installed tarball outside H1's probe harness;
- the `./pi/extension` and `./pi/subagents/index` entries (M6).

Source text was treated as evidence only. No credentials are present.
