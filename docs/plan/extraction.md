# Step 1: mechanically extract @nubl/maestro

**Status: proposed implementation plan; source inventory verified. No code has moved.**

Extract the existing engine and Pi tool contract, not a redesigned engine. Keep
Herdr execution providers and terminal presentation in `pi-herdr-agents`, supplied
through explicit composition hooks. Preserve all current terminal-host behavior.
Move the experimental worker implementation separately, without activating its
incompatible tool definitions through the stable entry point.

## 1. Baseline and boundaries

| Evidence | Pinned source |
| --- | --- |
| Main implementation, inventory and line citations unless marked A0 | `giuseppecrj/pi-herdr-agents@e020a148bbf9424f4e92635ecd9d138c94982292` (`origin/main` when inspected) |
| Experimental worker additions, marked **A0** | `giuseppecrj/pi-herdr-agents@f9e6cc5367dd203e7d32e6b4059aa389f3003a8d` (`exp/a0-worker-surface`) |
| Destination | `nublai/maestro`, package `@nubl/maestro`, currently `0.0.1` placeholder |

Source citations use repository-relative `file:line`; resolve them against the
revision above, not a future moved file. Immutable source bases:
[main](https://github.com/giuseppecrj/pi-herdr-agents/tree/e020a148bbf9424f4e92635ecd9d138c94982292)
and [A0](https://github.com/giuseppecrj/pi-herdr-agents/tree/f9e6cc5367dd203e7d32e6b4059aa389f3003a8d).
Appendices A–D are the exhaustive ownership and import checklists.

### Fixed decisions

- One harness-neutral engine/outcome contract, driven through providers; Pi is
  the only supported harness at launch. Public APIs remain ordinary TypeScript:
  Promises, AbortSignal, AsyncIterable where needed, and DTOs. No Effect dependency
  or public Effect types in step 1.
- Move core/runtime, Pi adapters, the tool surface and TypeBox schemas, worker
  provider and child reporting into Maestro. Keep both Herdr providers, widgets,
  terminal renderers and sidebar upstream. Preserve the complete existing tool
  set, not just the four pstack calls named in the brief.
- Preserve `delegation-outcome/v0.1`, including exact acknowledgements, error
  encoding, scopes, deferred-tool exposure, defaults, report bounds/provenance,
  cancellation ordering, accept verdicts, persistent semantics and notices.
  Package relocation alone does not justify a wire-version or schema change.
- Node >=26.12.1; MIT under this repository's nubl LICENSE. The founder owns
  the extracted code; the upstream `LICENSE:3` name is an accidental paste
  (founder, 2026-11-15) and is not carried over.
- No upstream push without the founder's go. This plan authorizes neither an
  implementation nor a release. The current task commits only these documents.

ADRs 0008 and 0010–0019 supply the behavior baseline. In particular, 0012's
single-package choice is superseded by the founder's extraction decision, not
its ownership rules; 0018's no-silent-fallback and backend-binding rules remain.
The supplied landscape/borrow/Effect studies inform sequencing, not shipped
capabilities. Their older `@nublai/maestro` spelling is not the package name.
The supplied LikeC4 map is a proposal: its private-repository description and
"later" Core-provider wording do not override the public repository and the
Core implementation already present on main.

**Explicitly later:** one non-terminal execution seam, a checked-outcome outbox,
worker/stable-tool convergence, durable parent admission/replay, then an internal
Effect pilot for one run. Do not repair ordinary mark-before-send delivery,
add retry/recovery, replace TypeBox, change worktree authorization, or generalize
providers while moving code. Those would invalidate behavioral equivalence.

## 2. The cut and the minimal new hooks

```text
pstack -> existing Pi tools -> Maestro Pi composition -> existing RunSession
                                                   -> PiHarnessAdapter
pi-herdr-agents wrapper ----------------------------> host hooks
  owns Herdr/Core selection, provider factories, socket marker transport,
  terminal renderers/widgets, child terminal entry, sidebar

pi-worker supervisor -> launches Pi processes (does NOT import Maestro)
  parent Pi -> explicit experimental worker entry -> A0 PiWorkerSession/B2 client
  child Pi  -> tiny FD reporter entry (no B2 client, grant reader or engine import)
```

The second path is **experimental preservation**, not the promised one-engine
end state. A0 `pi-extension/subagents/index.ts:299` returns before ordinary
registration; A0 `worker-backend.ts:113–146` requires model/thinking/worktree,
rejects several stable features, and serializes a different result. Wiring it
into the stable `subagent` entry would be a behavior change. Extract it under
explicit experimental exports, with no stable-entry auto-selection even when
`PI_WORKER_BACKEND` is set. Existing A0 consumers use its explicit entry; pstack
users of the main contract continue using the stable composition. Step 2 removes
the duplicate experimental owner only after parity exists.

### 2.1 Runtime provider composition (H1)

The real forward edges are `maestro/runtime/herdr-backend.ts:10–11` to the two
concrete providers and `maestro/runtime/pi-run-session.ts:45` to the pane
provider. `pi-run-session.ts:35` also imports the composition module. Keep the
factories in the terminal host; replace these imports with a small, explicitly
passed **HostSurfaceBinding** (proposed name), not a global plugin registry.

The hook must cover all of the following, not merely an already-created provider:

1. Resolve the current binding using the unchanged `resolveHerdrBinding` /
   `selectHerdrBinding` logic. Preserve backend, endpoint and parent-terminal
   equality checks on reload (`pi-run-session.ts:259–275`). Keep the existing
   binding DTO/config functions in core for now; Herdr vocabulary in a legacy DTO
   is not a reason for a domain rewrite.
2. Create the owning provider once with the current pane config and untrusted
   startup shell settings (`pi-run-session.ts:295–332`). Runtime still owns its
   existing FileWakeRegistry, SupervisionCoordinator and lifecycle.
3. Supply a **per-launch** provider/operations factory for legacy panes
   (`pi-run-session.ts:220–236,575–586`), receiving the launch snapshot. It must
   retain per-cwd Windows shell resolution and trust, not capture a startup
   snapshot. Core continues reusing the owning native execution provider.
4. Preserve the injected-infrastructure path as a closed world: no ambient
   Herdr/Core/socket discovery, same native-execution identity assertion, same
   tests. Do not implement the host hook by always forcing that existing test
   injection path: it currently records `{ backend: "legacy" }` and would lose
   real backend/endpoint reload validation.
5. Keep current availability/setup hints, platform refusals, worktree unsupported
   checks and cleanup operations. A missing required host binding is a composition
   error before acquisition, not permission to choose a different provider.

The old `createDefaultRunSession(options, previous?)` name can remain, with a
required host-binding option in the exported production composition. The
pi-herdr-agents wrapper fills it; the public tools retain their exact contract.
Pass the previous facade explicitly and keep its original symbol owner and
live closure; never reconstruct a run from presentation rows.

### 2.2 Delegated marker transport (H2)

`maestro/runtime/delegated-marker.ts:1–7` imports socket functions **and**
transport types. Keep `DelegatedMarkers`, `DelegatedMarker`, constants,
sequence/TTL/failure/discovery behavior in Maestro. Define their existing
structural result DTOs beside the algorithm; retain the Herdr socket reader and
writer factories upstream. Inject the existing `markerWriter` and
`markerSessionReader` callbacks (`pi-run-session-types.ts:292–307`).

Move ambient socket discovery and factory wiring out of
`pi-run-session.ts:171–188`; the terminal wrapper provides it only for legacy
panes. Native execution still receives no markers (`pi-run-session.ts:522–527`).
Transport mapping preserves every outcome (`answered`, `pane-missing`, `failed`)
and session-read variant. Keep the token/source strings, sequence owner across
reload, serialized clear/renew ordering and TTL exactly as they are.

### 2.3 Pi registration and terminal presentation (H3)

There is **no direct Herdr-module import in main's**
`pi-extension/subagents/index.ts`. Its coupling is through runtime composition
(`:12`) and terminal `renderers.ts` (`:70`) / `widgets.ts` (`:83`), plus module-load
configuration and timer setup (`:102–232`). That distinction matters to the
import audit.

Move registration/handlers and per-load controllers into a callable factory.
The upstream entry calls it once with a **PiPresentationHooks** object
(proposed name), constructed from its retained widget/message-renderer modules.
Keep registration order, timer disposal on replacement, launch refreshes,
shutdown reasons and held deliveries unchanged. Existing controller callback
parameters already carry `updateWidget`; extend that boundary, not run ownership.
The hook exposes the existing update/start/stop operations and renderer
registration, sharing the same runtime rows and observation functions. UI
teardown never shuts down an owner during reload.

`launch-tools.ts:338–414,470–498` and
`control-tools.ts:164–195,222–251,292–329` contain inline terminal render callbacks.
Move those callbacks and their `pi-tui` imports upstream; inject optional
per-tool renderer callbacks when assembling tool definitions. Keep schemas,
labels/descriptions, execution callbacks, error boundary and command handlers
in Maestro. `presentation.ts` **moves**, despite its name: it serializes the
parent's model-facing contract, not terminal widgets. `task-models.ts` keeps the
Pi approval/dialog mechanics; those are operational Pi integration rather than
Herdr rendering. No automatic approval replaces a dialog.

Keep current `Symbol.for` keys (`state.ts` and `undelivered-children.ts`), runtime
maps, child-busy channel, role-pack event and config namespace. Preserve
per-load controller/config refresh even though normal ESM package dependencies
are cached: invoke factories on each extension load; merely re-exporting a
cached module-level singleton would silently break `/reload`.

### 2.4 Child entries and package-relative assets (H4)

The ordinary reporter is not currently tiny: `child/subagent-done.ts` combines
protocol, checks and a terminal widget (`:10,222–249,279`). Split its widget into
the terminal host, retain protocol behavior in a Pi child module, and provide a
small default entry that imports only child protocol dependencies. The terminal
host's small child wrapper passes the old widget hook. Do not load the parent
extension, provider factory or all tools merely to report a child result.

The A0 FD reporter is a different protocol. Split the `PI_WORKER_REPORT_FD`
branch from A0 `worker-backend.ts:21–64` into a tiny reporter implementation/entry.
Preserve FD 3 validation, event ordering, report bounds, help suppression and
its existing result shape; do not make it a checked-outcome producer yet. Its
import closure excludes `worker-client.ts`, `PiWorkerSession`, grant-file reads,
Herdr and Pi TUI. Parent and child entries may share schema constants but must
not import each other's initialization.

Fix relocation, not semantics: `launch.ts:833` and `launch-resume.ts:156` build
literal `child/subagent-done.ts` paths. TypeScript import rewriting will **not**
rewrite these strings. Add an explicit child-entry path option, defaulted to
this package's emitted `.js` entry; the terminal host passes its wrapper path.
Resolve with module URLs/`fileURLToPath`, not cwd. Preserve arguments and quoting.
`config-path.ts:6,20–25` assumes a source-tree package root; accept a package asset
root/example path at composition, retaining `$PI_CODING_AGENT_DIR/herdr-agents`
and the exact example content. Test paths with spaces and installed tarballs.

## 3. Published API and consumption

Keep source relative layout (`maestro/`, `pi-extension/`) for reviewable diffs;
emit the same tree under `dist/`. New facades/entries are the only new layout.
All entry exports below have `types` pointing to `.d.ts` and `import`/`default`
pointing to `.js`; no export points into TypeScript source or `test/`.
These are proposed exports, not APIs present in `0.0.1`.

| Package subpath | Step-1 content |
| --- | --- |
| `.` and `./engine` | Same lean facade: `createRunSession`, `defaultRetainSurface`, the existing exported run-session types, and core `HarnessAdapter`/`SurfaceProvider`/task/handle/outcome types. Importing it does not initialize Pi or read host config. |
| `./core/*` | Compatibility subpaths mapping to `dist/maestro/core/*.js` and declarations, including nested `config/*` and `roles/*`; exports exactly the moved module's existing named exports. Needed by retained providers; no concrete Herdr provider included. |
| `./runtime` | Existing runtime barrel exports (`maestro/runtime/index.ts:1–48`) plus host-binding option types; Pi-aware, unlike the root engine facade. |
| `./runtime/*` | Explicit compatibility mapping for each retained runtime module, with `herdr-backend` replaced by the neutral host-hook contract rather than exporting Herdr constructors. |
| `./adapters/pi/*` | Existing moved Pi adapter modules, with emitted `.js`/`.d.ts`; used by the terminal host's shell/process helpers and integration tests. Exclude child UI and experimental worker modules from this stable mapping. |
| `./pi` | `createPiExtension(hostOptions)` factory and host/presentation option types. Returned function accepts Pi `ExtensionAPI`; production host options supply the provider binding. No automatic provider discovery. |
| `./pi/extension` | Tiny callable Pi composition entry: the same registration function/default export taking explicit host options. A host loads a wrapper that supplies them; it is not a zero-config Herdr extension. |
| `./pi/child` | Tiny default child-protocol extension plus named factory accepting optional child presentation hook; ordinary sidecars/accept/persistent protocol only. |
| `./pi/subagents/*` | Compatibility subpaths for moving tool/controller/schema/state/serializer modules; `index` delegates to the factory; no widgets/renderers. Preserve named exports needed by the upstream tests and retained UI. `__test__` remains a compatibility testing surface, not an engine capability. |
| `./testing` | FakeHarnessAdapter, FakeSurfaceProvider and conformance runners; no real provider, config initialization or credentials. Package only required test-support modules, not entire test suites. |
| `./experimental/pi-worker` | `createWorkerClient`, A0 `PiWorkerSession`, its DTOs and seam types. Explicitly experimental; not exported from root/runtime stable barrels. |
| `./experimental/pi-worker/extension` | A0 parent registration entry, retaining the opt-in gate and its A0 schemas; never selected by the stable extension. |
| `./experimental/pi-worker/child` | FD-only reporter, no parent client/runtime import. |
| `./package.json` | Version and asset/entry discovery for packaging consumers. |

Use finite export-map entries for the compatibility module families above,
generated from Appendix A's moving portions; `*` in the table describes a
family, not permission to publish every internal future file. Tests enumerate
all declared subpaths. The existing named symbols of each cited source module
are the initial symbol inventory; the extraction diff may only remove symbols
whose implementation stays upstream and add the hooks described here. Narrowing
these compatibility exports later requires a separate consumer migration.

**pi-herdr-agents:** add an exact tested Maestro dependency and keep its installed
Pi extension path. Its wrapper imports `createPiExtension`, composes the retained
providers and presentation, and calls the factory. Retained modules replace
relative moving imports with the mapped package subpaths. Keep the legacy child
path as a forwarding wrapper so old launch artifacts/session policies can still
find it. Do not load both the wrapper and Maestro as independent Pi packages:
that would register tools and handlers twice. Do not add automatic `pi.extensions`
discovery to the dependency; hosts select the entry explicitly.

**pi-worker:** its Pi launch resource list names the experimental parent or
FD-child extension path in the installed package. The supervisor does not
import Maestro and does not acquire its dependency graph. A worker stable-tool
entry is deferred until step 2 proves the same schemas/outcomes, not advertised
as completed by this extraction. No supervisor changes are part of these PRs.

## 4. Dependencies, build, tooling and licensing

### Dependencies

Main `package.json:47–73` declares Pi AI/coding-agent/TUI and TypeBox as `*` peers,
with development Pi `^1.5.2`, TypeBox `^0.34.52`, TS 5.9.3, Biome 2.5.11 and
Oxlint `^1.80.0`. Preserve the tested versions from its lockfile initially,
without an unrelated dependency upgrade.

- **Runtime dependency:** `@sinclair/typebox` in the existing tested 0.34.x line.
  It is a directly imported implementation/schema dependency, so every Pi entry
  has it available. Test coexistence with the host's TypeBox installation and
  identical captured schemas; do not replace schema constructors.
- **Optional peers:** `@earendil-works/pi-ai` and
  `@earendil-works/pi-coding-agent`, initially the tested 1.5.x line (minimum
  1.5.2; widen only with evidence). Optional at installation so an engine-only
  consumer need not install Pi. Required in fact for Pi entry imports; explain
  this in their docs. Pin both in devDependencies/lockfile for CI. Pi APIs/types
  must resolve to the host's installation, not a bundled second SDK.
- **No Maestro TUI dependency** once all inline/child renderers are split. Keep
  `@earendil-works/pi-tui` upstream; any remaining runtime import is a failed cut.
- No dependency on `pi-herdr-agents`, Herdr binaries, `pi-worker` supervisor,
  Effect or a bundler. The worker client uses Node HTTP/fs, not supervisor internals.
  Include explicit `@types/node` for Node 26 in development rather than relying
  on the SDK's transitive types; strict checks must cover Node/AbortSignal types.

### Build and checks

Use TypeScript **emit**, not an npm package of strip-types-only `.ts` files.
Keep upstream's strict NodeNext/es2023/verbatimModuleSyntax/erasableSyntaxOnly
settings. Use a separate `tsconfig.build.json` with `noEmit: false`, `rootDir: .`,
`outDir: dist`, declarations, source/declaration maps and
`rewriteRelativeImportExtensions: true`. Typecheck tests separately with
`noEmit: true`. Preserve comments/headers (`removeComments: false`). Copy needed
non-code assets explicitly; do not ship tests, development credentials or labs.
Do not bundle: preserve module identity, import boundaries and reload ownership.

The emitted child entry paths and config assets need explicit fixes (§2.4).
Set `main`, `types`, export map and `files` to emitted entry/artifacts, licenses
and required assets. Add `prepack` build, and CI/publish `npm ci` + validation +
build + packed-consumer verification before publishing; the current placeholder
workflows have no install/build step. Test on the minimum Node **26.12.1**, not
only a floating `26`; retain a current-26 lane if useful.

Match upstream's Biome formatter (tabs/default configuration; lint and assist
disabled) and Oxlint with the local anti-slop plugin. Copy the plugin's actual
import closure, not just `oxlint.config.ts`; tools live in Appendix A's support
inventory. Keep test checks against module mocking and unsafe assertions.
No ESLint/Prettier/Vitest migration. Use Node's test runner with explicit entries
and type stripping for source tests; compile and execute separate installed-JS
smokes. Add proposed scripts `build`, `test:coverage`, `test:package` and
`check:boundaries`; retain `format:check`, `lint`, `typecheck`,
`docs:tools:check`, `test`. Their names below are implementation acceptance
requirements, not commands available in the placeholder today.

Ship this repository's MIT LICENSE only; no upstream license copy or per-file
notices. Record the source repository and revision of each extraction in the
PR description, not in file headers.

## 5. Test migration and acceptance

Appendix B covers **every file under `test/`**, including helpers, fixtures,
conformance runners, integration entry points, package tests and the monolith.
There is no "copy test/maestro wholesale" shortcut: several tests exercise real
Herdr transports or the retained host wrapper.

### Preserve test identities, not just counts

For each split file, record each original test title and source line in an
implementation migration manifest, with its new owner/path. Port setup/helpers
with their assertions. Keep pure engine/tool cases here; keep concrete transport,
UI and real-terminal composition cases upstream against the installed package.
Shared fixture/helper code may be copied test-only into both repositories where
necessary; production logic gets one owner. Both old and new files can coexist
while validating, but delete migrated upstream cases only after counterpart runs.

`test/test.ts` has 17,644 lines and mixes everything. Its suite boundaries include:

- Move protocol/engine suites: session (`:3132`), resume policy (`:3949`), config
  and discovery (`:4600–7792`), child protocol (`:7926`), lifecycle (`:9399`),
  completion (`:9975`), tool registration (`:11820`), persistent delivery/send/stop
  (`:12954–14205`), host-line/report/error contracts (`:16353–17644`). Inspect nested
  cases: child widgets, per-load UI config and command rendering stay upstream.
- Split public composition/control suites (`:835`, `:2676`, `:10306`, `:11506`,
  `:12415`, `:14206`) into fake-provider tool behavior here and Herdr/UI wiring
  upstream. Keep assertions on side effects and encoded results, not stubs of
  the implementation under test.
- Keep concrete status renderer/widget/Herdr suites (`:15321`, `:15560`, `:15851`)
  upstream. Pure status projections (`:4122`) and no-progress evaluation (`:9767`)
  move; rendering assertions stay.

Carry both schema JSON snapshots unchanged. Run capture through the actual
factory plus child entry, in parent/child/deny-tool scopes, and compare with the
upstream wrapper as well. `test/helpers/tool-schema-capture.ts:69–94` dynamically
loads source paths, so parameterize the loader for source and installed JS;
changing static imports alone cannot make this gate real. Tool docs generation
and `docs/tools.md` blocks travel with the contract; host installation/sidebar
prose stays upstream. Preserve role-pack fixtures and discovery ordering.

### Coverage gates

The supplied baseline report is prior evidence, not a new run in this task:
`maestro-coverage-e020a14.txt:2124–2131` reports 1,769 tests, 1,768 passes,
0 failures and 1 skip. The requested subsystem floors are **core 98.0% line,
runtime 98.9%, surfaces 85.2%**. They are not the report's overall 86.40%, and
must not become one global threshold. The report also shows weak individual
coverage (e.g. child reporter 40.76%); that does not justify dropping tests.

1. In M1, capture the pinned baseline's raw per-file covered/total lines, branch
   and function data on Node 26.12.1 with exactly the original unit entry list,
   in isolated state. Keep the supplied report as comparison evidence. Confirm
   the subsystem aggregation method rather than changing it silently. Arithmetic
   means of the supplied report's displayed per-file line percentages are core
   98.0481% (36 files), runtime 98.94% (10), surfaces 85.2078% (9), matching the
   requested rounded floors; these are not weighted covered-line ratios.
2. Track original file/line ownership through splits. Use the **same aggregation**
   over the original file population (recombining split portions) for baseline
   comparison; additionally report weighted line coverage so a tiny file cannot
   hide a large uncovered module. Do not improve a number by deleting a file,
   moving it out of the denominator, skipping a test or excluding child code.
3. As each PR adds a subset, its moved tests and source-mapped coverage must not
   regress that subset's baseline. At M6/H2, recombine package tests and retained
   host composition/provider coverage against the same candidate tarball. Require
   all three subsystem floors. Runtime factory/marker portions staying upstream
   still count in the original runtime population; fake and real surfaces retain
   their original population split across repos.
4. Report package-only core/runtime floors too, with an explicit new population;
   meet 98.0/98.9 rather than quietly adopting a lower baseline. Add tests for
   new hooks/build paths. Herdr surface 85.2 stays a required upstream gate, not
   a false claim that Maestro ships Herdr surfaces. Store machine-readable
   ownership/coverage mapping in the implementation PRs.
5. Track adapters and tool-boundary files per-file against the baseline even
   though no aggregate floor was specified. A0 coverage is a separate cohort;
   it must not dilute or inflate main's baseline.

### Known timing flake

`test/maestro/herdr-surface-provider.test.ts:533` ("rejects unconfirmed absence
and resolves confirmed absence") gives the missing-pane success only **10 ms**
at `:557` and uses 10 ms absence timeouts at `:560,566`. It stays upstream.
The supplied successful coverage report does not reproduce the reported flake.
Run it independently and under full-suite load before/after the move; retain
all failed attempts in evidence. Prefer a bounded generous success budget and
deterministic clock/deferred transport for deadline assertions in a **separate
test-only upstream commit**, leaving production deadlines unchanged. A passing
retry is not proof of a fix. Do not skip/quarantine it to obtain a green switch.

### Package and composition proof

`test:package` must pack, install into a fresh fixture outside the source tree,
and execute emitted JS without TypeScript loaders or source path fallbacks.
Cover: root import without Pi peers installed; every export resolution and
Promise-only TypeScript consumer; Pi factory registration with peers; emitted
child entry loading; schema equality; asset paths; headers/licenses; no
Herdr, TUI or Effect imports in Maestro-owned modules (Pi peers may have their
own TUI dependencies); worker child import isolation. Verify the package does
not auto-register itself alongside the upstream wrapper.

Retained upstream isolated integration suites run sequentially against the same
candidate tarball using credential-free fake model service + real parent/child
Pi and isolated Herdr/Core. Cover fresh/fork/resume, scoped model routing,
fallback refusal on uncertain acquisition, cancel during launch/recheck,
unconfirmed termination, persistent send/stop/help/notices, worktree retention
and explicit cleanup, reload gaps and provider binding changes. Include a
real parent/child emitted-entry smoke, not only mock ExtensionAPI capture.
Maintain the upstream Linux integration driver and lab guards; never test against
the operator's daily sockets. Desktop/sidebar pixel parity is not newly claimed.

## 6. Small, independently green PRs

Commands below are **planned gates** once the corresponding scripts exist.
`npm ci` always precedes a clean CI run. `npm run check:boundaries` checks both
source and emitted imports. `npm run test:coverage` includes the current migrated
unit suite and its explicit ownership manifest; it is not a tiny proxy suite.
No PR is released just because its partial package builds.

### Maestro sequence

| PR | Change and completion criterion | Verification command(s) |
| --- | --- | --- |
| **M1 — build and provenance scaffold** | Add strict TS emit, lockfile, upstream-compatible formatter/Oxlint closure, license/provenance files, package-test harness and baseline/migration manifests. Keep placeholder API/test until replacement is ready. CI and publish workflow install/build gates exist, but no tag. | `npm run format:check && npm run lint && npm run typecheck && npm test && npm run build && npm run test:package && npm pack --dry-run` |
| **M2 — core and generic owner** | Copy core, RunSession/surface-retention and fakes unchanged; root/engine entry stays Pi-free. Move matching conformance tests and monolith cases now, not later. Establish non-regressing coverage for this subset. | M1 gates, plus `npm run check:boundaries && npm run test:coverage` |
| **M3 — Pi adapters/runtime and host ports** | Move Pi adapter/runtime closure and relevant tests; replace concrete provider/marker imports with §2.1–2.2 hooks. Preserve reload ownership and per-launch trust. Ordinary child protocol moves with its launch dependency; split widget via child hook. Verify fake-host fixtures plus the local H1 adapter. | M2 gates; `node --experimental-strip-types --test test/maestro/pi-run-session.test.ts test/maestro/audit-reload.test.ts test/maestro/accept-recheck.test.ts`; installed-JS child smoke in `npm run test:package` |
| **M4 — Pi tools and stable contract** | Move schemas/controllers/serializer and Pi factory; retain UI through hooks. Move remaining contract tests/docs and complete monolith ownership ledger. Exact main schema/result fixtures match; no duplicate registration. | M2 gates, plus `npm run docs:tools:check`; actual-factory schema and outcome cases in `npm test`; upstream-wrapper comparison in `npm run test:package` |
| **M5 — isolated experimental worker relocation** | Copy only A0 worker closure/tests; split tiny FD reporter, publish only explicit experimental entries. Preserve A0 behavior and assert stable entry remains unaffected. No A0 early return added to the stable factory. | M4 gates, plus `node --experimental-strip-types --test test/maestro/worker-backend.test.ts test/maestro/worker-delivery.test.ts test/maestro/worker-crash.test.ts`; run crash test in isolated Linux fixture; packed reporter/import-isolation tests |
| **M6 — installed-consumer parity and release readiness** | Complete finite exports/assets and compatibility docs, combine coverage populations, run retained upstream labs against the tarball, remove placeholder API only now. All migrated test identities accounted for; both consumer paths documented honestly. | M4/M5 gates, `npm pack --dry-run`; H2 full checks and sequential integration gates below against the exact tarball; package/source-map coverage comparison reaches floors |

M3 can be reviewed without a pushed upstream branch: the hook fixture is local.
M6 needs the local H2 consumer branch, not an upstream merge. Version/tag choice
and the actual release require founder approval after these checks; no automatic
release is part of M6. The worker transport stays experimental if parity is not
implemented—M6 must not claim step 2 happened.

### Matching pi-herdr-agents sequence (local branches until approved)

| PR | Change and completion criterion | Verification command(s) |
| --- | --- | --- |
| **H1 — prove composition hooks in place** | Extract the concrete factories, marker transport, inline/child renderers and wrapper composition while still using the existing local engine. Establish exact before/after contract and reload fixtures. Put any flake-only correction in its own commit. No behavior change or dependency switch. | `npm run format:check && npm run docs:tools:check && npm run lint && npm run typecheck && npm test && npm pack --dry-run` |
| **H2 — consume candidate package** | Install the M6 candidate tarball locally; redirect moving imports to explicit package exports, load one factory, preserve old child path forwarding and config roots. Run before deleting local implementation; then delete moved production code in the same reviewed switch commit once equivalence passes. Before an approved merge, replace the temporary file dependency with the exact released version and rerun package resolution. | H1 gates; `npm run test:integration && npm run test:integration:core` in isolated labs; full `scripts/run-linux-integration.ts` driver via the existing CI lab; original-population coverage gate using package source maps |
| **H3 — finish test/docs ownership** | Remove only duplicated migrated test cases whose counterpart evidence exists; keep real provider/UI/integration coverage, forwarding child entry and host guide. Update developer map and package-manifest assertions; preserve schema snapshots. No cleanup of runtime behavior. | H1/H2 gates again for changed tests/imports; final combined ownership/coverage report, `npm pack --dry-run` |

Local working order: **M1 → M2 → H1 → M3 → M4 → M5 → local H2/M6
verification → approved Maestro release → H2 dependency finalization → H3**.
The founder may review the upstream diffs locally throughout; none is pushed,
opened as a PR, merged or tagged by this planning task.

### Switch-over and rollback

1. Capture source revision, candidate tarball hash, lockfiles, coverage map and
   exact schema/outcome equality evidence. Finish/drain live children before the
   **package upgrade**, then restart Pi. Preserve `/reload` behavior within a
   version, but do not claim hot adoption across old local and new package class
   implementations. This avoids simultaneous module owners without redesigning
   runtime ownership.
2. Release Maestro only through the authorized `v*` tag workflow and trusted
   npm publishing. Keep the initial consumer dependency exact, not a floating
   range. Verify the published tarball matches the candidate's content before
   switching the consumer; never publish the test `file:` dependency.
3. Upgrade the terminal wrapper/engine together. Keep old reporter forwarding
   paths, config and artifact namespaces, outcome-ledger format, role-pack event
   and global symbols. Do not migrate user config or rewrite manifests.
4. For a packaging/contract regression, stop new delegation, let owned runs
   settle or explicitly cancel/stop them and confirm termination. Revert the
   host switch to its recorded bundled-engine revision and restart Pi. Retained
   worktrees/branches/evidence remain untouched. Pin the previous version;
   never automatically re-run an unknown task or delete review state.
5. A defective already-published version is handled by an authorized corrective
   release/dependency rollback, not overwriting npm or locally publishing.
   The worker experiment can keep its previous explicit package entry/version
   independently; it never forces the stable host onto A0 semantics.

## 7. Risks and founder decisions

**Material risks:** ESM caching changes reload semantics; fixed launch `.ts`
strings fail after publish; Windows per-launch trust can be lost by a coarse
provider injection; test splitting can hide coverage loss; duplicate extension
loading can duplicate tools/results. The gates above target each directly.

**Open decisions (not blockers to this plan):**

1. Approve the first extracted version and release timing, then separately
   authorize upstream push/PR publication. No release number is assumed here.
2. Confirm whether to expose the preserved A0 experiment in the first npm release
   or keep those experimental exports unpublished until step 2. Recommended:
   extract/test now, advertise no stable worker support; enabling A0 by default
   is not an option under the no-behavior-change constraint.

The engine/public API/Effect/ownership/Node/license decisions are settled and
are not reopened by these release questions.

## 8. Verification of this planning change

The inventory was derived from `git ls-tree -r --name-only` at both pinned
revisions, not the source checkout's working tree. A TypeScript AST scan of
tracked TS/JS/MJS files identified static imports, re-exports, import types and
literal dynamic imports; Appendix D records the cross-cut edges with the
specifier's actual line. Non-literal/path-built loads are called out separately.
Every listed source path and import edge was checked against those revisions.
No upstream implementation, upstream tests, integration labs or source-supplied
scripts were executed for this planning task. Only this repository's requested placeholder
`npm test` and package preview are current execution evidence: on Node 26.13.0,
`npm test` passed 1/1 tests and `npm pack --dry-run` succeeded (the unchanged
five-file placeholder package). Migration, coverage and installed-consumer gates
above remain future work. No independent subagent review was run: this was a
planning leaf with delegation prohibited.

Source documents contain install/test/release and operating instructions (the
upstream README, development guide, skill and research quotations). They were
treated as evidence, not authority, and none of their commands was executed on
their request. No source-requested upload, local-data transfer or credential
submission occurred. Only credential variable names/protocol field names appear
here; no credentials or token-bearing URLs are included.

## Appendix A. Exact production and support inventory

**move** means Maestro owns the implementation after switch-over; it is copied first, then removed upstream only after installed-consumer parity. **stay** means pi-herdr-agents keeps ownership. **split** identifies a source file whose portions or shared test/tooling assets have both owners; the reason names the boundary. Source paths below exist at main unless in Appendix C. Destination defaults to the same relative path in this repository, compiled under `dist/`; stayed portions retain their upstream path or a host-local extracted sibling. New hook/facade names in §§2–3 are proposed, not falsely inventoried as existing source files.

### A1. All 98 files under maestro/ and pi-extension/subagents/

| Source path at main | Fate | Reason / split boundary |
| --- | --- | --- |
| `maestro/adapters/fake/fake-harness-adapter.ts` | **move** | Engine/provider conformance fake; expose only through testing entry. |
| `maestro/adapters/pi/accept-groups.ts` | **move** | Pi protocol/adapter implementation and its existing dependencies; publish emitted JS. |
| `maestro/adapters/pi/accept-runner.ts` | **move** | Pi protocol/adapter implementation and its existing dependencies; publish emitted JS. |
| `maestro/adapters/pi/activity-file.ts` | **move** | Pi protocol/adapter implementation and its existing dependencies; publish emitted JS. |
| `maestro/adapters/pi/child/accept-check.ts` | **move** | Pi protocol/adapter implementation and its existing dependencies; publish emitted JS. |
| `maestro/adapters/pi/child/declared-skills.ts` | **move** | Pi protocol/adapter implementation and its existing dependencies; publish emitted JS. |
| `maestro/adapters/pi/child/done-nudge.ts` | **move** | Pi protocol/adapter implementation and its existing dependencies; publish emitted JS. |
| `maestro/adapters/pi/child/subagent-done.ts` | **split** | H4: child protocol/caller_ping/accept/persistent logic moves; terminal widget stays and is injected; add tiny reporter entry. |
| `maestro/adapters/pi/completion.ts` | **move** | Pi protocol/adapter implementation and its existing dependencies; publish emitted JS. |
| `maestro/adapters/pi/launch-command.ts` | **move** | Preserve command helpers; resolve emitted child entry instead of deriving a source-only path (H4). |
| `maestro/adapters/pi/launch-operations.ts` | **move** | Pi protocol/adapter implementation and its existing dependencies; publish emitted JS. |
| `maestro/adapters/pi/launch-resume.ts` | **move** | Preserve launch transaction; replace literal child .ts resource path with supplied/emitted entry (H4). |
| `maestro/adapters/pi/launch.ts` | **move** | Preserve launch transaction; replace literal child .ts resource path with supplied/emitted entry (H4). |
| `maestro/adapters/pi/model-registry.ts` | **move** | Pi protocol/adapter implementation and its existing dependencies; publish emitted JS. |
| `maestro/adapters/pi/pi-harness-adapter.ts` | **move** | Pi protocol/adapter implementation and its existing dependencies; publish emitted JS. |
| `maestro/adapters/pi/process-identity.ts` | **move** | Pi protocol/adapter implementation and its existing dependencies; publish emitted JS. |
| `maestro/adapters/pi/process-tree.ts` | **move** | Pi protocol/adapter implementation and its existing dependencies; publish emitted JS. |
| `maestro/adapters/pi/script-shell.ts` | **move** | Pi protocol/adapter implementation and its existing dependencies; publish emitted JS. |
| `maestro/adapters/pi/session.ts` | **move** | Pi protocol/adapter implementation and its existing dependencies; publish emitted JS. |
| `maestro/adapters/pi/task-model-init.ts` | **move** | Pi protocol/adapter implementation and its existing dependencies; publish emitted JS. |
| `maestro/core/accept.ts` | **move** | Existing core contract/policy/helper; retain current DTOs, defaults and semantics, including legacy names. |
| `maestro/core/activity.ts` | **move** | Existing core contract/policy/helper; retain current DTOs, defaults and semantics, including legacy names. |
| `maestro/core/child-busy.ts` | **move** | Existing core contract/policy/helper; retain current DTOs, defaults and semantics, including legacy names. |
| `maestro/core/config/guidelines-config.ts` | **move** | Existing core contract/policy/helper; retain current DTOs, defaults and semantics, including legacy names. |
| `maestro/core/config/herdr-config.ts` | **move** | Existing core contract/policy/helper; retain current DTOs, defaults and semantics, including legacy names. |
| `maestro/core/config/model-config.ts` | **move** | Existing core contract/policy/helper; retain current DTOs, defaults and semantics, including legacy names. |
| `maestro/core/config/outcome-ledger-config.ts` | **move** | Existing core contract/policy/helper; retain current DTOs, defaults and semantics, including legacy names. |
| `maestro/core/config/pane-config.ts` | **move** | Existing core contract/policy/helper; retain current DTOs, defaults and semantics, including legacy names. |
| `maestro/core/config/persistent-config.ts` | **move** | Existing core contract/policy/helper; retain current DTOs, defaults and semantics, including legacy names. |
| `maestro/core/config/role-config.ts` | **move** | Existing core contract/policy/helper; retain current DTOs, defaults and semantics, including legacy names. |
| `maestro/core/config/spawning-config.ts` | **move** | Existing core contract/policy/helper; retain current DTOs, defaults and semantics, including legacy names. |
| `maestro/core/config/supervision-config.ts` | **move** | Existing core contract/policy/helper; retain current DTOs, defaults and semantics, including legacy names. |
| `maestro/core/config/task-model-init.ts` | **move** | Existing core contract/policy/helper; retain current DTOs, defaults and semantics, including legacy names. |
| `maestro/core/config/task-model-types.ts` | **move** | Existing core contract/policy/helper; retain current DTOs, defaults and semantics, including legacy names. |
| `maestro/core/config/type-guards.ts` | **move** | Existing core contract/policy/helper; retain current DTOs, defaults and semantics, including legacy names. |
| `maestro/core/deadline.ts` | **move** | Existing core contract/policy/helper; retain current DTOs, defaults and semantics, including legacy names. |
| `maestro/core/declared-skills.ts` | **move** | Existing core contract/policy/helper; retain current DTOs, defaults and semantics, including legacy names. |
| `maestro/core/delegation-depth.ts` | **move** | Existing core contract/policy/helper; retain current DTOs, defaults and semantics, including legacy names. |
| `maestro/core/git-environment.ts` | **move** | Existing core contract/policy/helper; retain current DTOs, defaults and semantics, including legacy names. |
| `maestro/core/harness-adapter.ts` | **move** | Existing core contract/policy/helper; retain current DTOs, defaults and semantics, including legacy names. |
| `maestro/core/host-text.ts` | **move** | Existing core contract/policy/helper; retain current DTOs, defaults and semantics, including legacy names. |
| `maestro/core/index.ts` | **move** | Existing core contract/policy/helper; retain current DTOs, defaults and semantics, including legacy names. |
| `maestro/core/lifecycle.ts` | **move** | Existing core contract/policy/helper; retain current DTOs, defaults and semantics, including legacy names. |
| `maestro/core/opened-primary-workspace.ts` | **move** | Existing core contract/policy/helper; retain current DTOs, defaults and semantics, including legacy names. |
| `maestro/core/platform-support.ts` | **move** | Existing core contract/policy/helper; retain current DTOs, defaults and semantics, including legacy names. |
| `maestro/core/realpath-without-opening.ts` | **move** | Existing core contract/policy/helper; retain current DTOs, defaults and semantics, including legacy names. |
| `maestro/core/roles/discovery.ts` | **move** | Existing core contract/policy/helper; retain current DTOs, defaults and semantics, including legacy names. |
| `maestro/core/routing.ts` | **move** | Existing core contract/policy/helper; retain current DTOs, defaults and semantics, including legacy names. |
| `maestro/core/script-launch.ts` | **move** | Existing core contract/policy/helper; retain current DTOs, defaults and semantics, including legacy names. |
| `maestro/core/shell.ts` | **move** | Existing core contract/policy/helper; retain current DTOs, defaults and semantics, including legacy names. |
| `maestro/core/specialist-notice.ts` | **move** | Existing core contract/policy/helper; retain current DTOs, defaults and semantics, including legacy names. |
| `maestro/core/status.ts` | **move** | Existing core contract/policy/helper; retain current DTOs, defaults and semantics, including legacy names. |
| `maestro/core/supervision.ts` | **move** | Existing core contract/policy/helper; retain current DTOs, defaults and semantics, including legacy names. |
| `maestro/core/surface-provider.ts` | **move** | Existing core contract/policy/helper; retain current DTOs, defaults and semantics, including legacy names. |
| `maestro/core/types.ts` | **move** | Existing core contract/policy/helper; retain current DTOs, defaults and semantics, including legacy names. |
| `maestro/core/undelivered-children.ts` | **move** | Existing core contract/policy/helper; retain current DTOs, defaults and semantics, including legacy names. |
| `maestro/core/wake.ts` | **move** | Existing core contract/policy/helper; retain current DTOs, defaults and semantics, including legacy names. |
| `maestro/core/worktree-cleanup.ts` | **move** | Existing core contract/policy/helper; retain current DTOs, defaults and semantics, including legacy names. |
| `maestro/core/worktree.ts` | **move** | Existing core contract/policy/helper; retain current DTOs, defaults and semantics, including legacy names. |
| `maestro/runtime/accept-recheck.ts` | **move** | Runtime orchestration/I/O owned by Maestro; preserve existing operation order and evidence. |
| `maestro/runtime/delegated-marker.ts` | **split** | H2: marker algorithm/constants and structural DTOs move; Herdr socket reader/writer factories stay. |
| `maestro/runtime/herdr-backend.ts` | **split** | H1: concrete selection/factories stay in host; neutral factory/binding option contract moves into runtime composition. |
| `maestro/runtime/index.ts` | **move** | Runtime orchestration/I/O owned by Maestro; preserve existing operation order and evidence. |
| `maestro/runtime/pi-persistent-io.ts` | **move** | Runtime orchestration/I/O owned by Maestro; preserve existing operation order and evidence. |
| `maestro/runtime/pi-run-session-types.ts` | **move** | Runtime orchestration/I/O owned by Maestro; preserve existing operation order and evidence. |
| `maestro/runtime/pi-run-session.ts` | **split** | H1/H2: owning Pi session moves; concrete default/per-launch factories and ambient marker wiring become supplied host callbacks. |
| `maestro/runtime/run-session.ts` | **move** | Runtime orchestration/I/O owned by Maestro; preserve existing operation order and evidence. |
| `maestro/runtime/surface-retention.ts` | **move** | Runtime orchestration/I/O owned by Maestro; preserve existing operation order and evidence. |
| `maestro/runtime/task-model-init.ts` | **move** | Runtime orchestration/I/O owned by Maestro; preserve existing operation order and evidence. |
| `maestro/runtime/worktree-operations.ts` | **move** | Runtime orchestration/I/O owned by Maestro; preserve existing operation order and evidence. |
| `maestro/surfaces/fake/fake-surface-provider.ts` | **move** | Engine/provider conformance fake; expose only through testing entry. |
| `maestro/surfaces/herdr/herdr-cli.ts` | **stay** | Concrete Herdr/Core transport, placement or terminal execution; host-owned provider implementation. |
| `maestro/surfaces/herdr/herdr-core-protocol.ts` | **stay** | Concrete Herdr/Core transport, placement or terminal execution; host-owned provider implementation. |
| `maestro/surfaces/herdr/herdr-core-surface-provider.ts` | **stay** | Concrete Herdr/Core transport, placement or terminal execution; host-owned provider implementation. |
| `maestro/surfaces/herdr/herdr-pane.ts` | **stay** | Concrete Herdr/Core transport, placement or terminal execution; host-owned provider implementation. |
| `maestro/surfaces/herdr/herdr-socket.ts` | **stay** | Concrete Herdr/Core transport, placement or terminal execution; host-owned provider implementation. |
| `maestro/surfaces/herdr/herdr-surface-provider.ts` | **stay** | Concrete Herdr/Core transport, placement or terminal execution; host-owned provider implementation. |
| `maestro/surfaces/herdr/herdr.ts` | **stay** | Concrete Herdr/Core transport, placement or terminal execution; host-owned provider implementation. |
| `maestro/surfaces/herdr/terminal.ts` | **stay** | Concrete Herdr/Core transport, placement or terminal execution; host-owned provider implementation. |
| `pi-extension/subagents/catalog.ts` | **move** | Pi host/tool implementation or model-facing contract; keep schema, defaults and result text unchanged. |
| `pi-extension/subagents/config-path.ts` | **move** | Preserve herdr-agents config namespace; inject asset root/example path to remove source-tree layout assumption (H4). |
| `pi-extension/subagents/control-tools.ts` | **split** | H3: schemas/execution move; inline renderCall/renderResult and pi-tui dependency stay. |
| `pi-extension/subagents/controls.ts` | **move** | Pi host/tool implementation or model-facing contract; keep schema, defaults and result text unchanged. |
| `pi-extension/subagents/deferred-tools.ts` | **move** | Pi host/tool implementation or model-facing contract; keep schema, defaults and result text unchanged. |
| `pi-extension/subagents/delivery.ts` | **move** | Pi host/tool implementation or model-facing contract; keep schema, defaults and result text unchanged. |
| `pi-extension/subagents/index.ts` | **split** | H3: config/controller/tool/session registration moves into per-load factory; terminal wrapper, widget/render registration and UI timer composition stay. |
| `pi-extension/subagents/launch-tools.ts` | **split** | H3: schemas/execution/commands move; inline renderCall/renderResult and pi-tui dependency stay. |
| `pi-extension/subagents/launch.ts` | **move** | Pi host/tool implementation or model-facing contract; keep schema, defaults and result text unchanged. |
| `pi-extension/subagents/model-registry.ts` | **move** | Pi host/tool implementation or model-facing contract; keep schema, defaults and result text unchanged. |
| `pi-extension/subagents/observation.ts` | **move** | Pi host/tool implementation or model-facing contract; keep schema, defaults and result text unchanged. |
| `pi-extension/subagents/persistent.ts` | **move** | Pi host/tool implementation or model-facing contract; keep schema, defaults and result text unchanged. |
| `pi-extension/subagents/presentation.ts` | **move** | Model-facing ParentMessage serializer/envelope/provenance/size bounds, not terminal UI; essential outcome contract. |
| `pi-extension/subagents/renderers.ts` | **stay** | Terminal-only widget/status timers or message rendering; receives Maestro state/serializer via host hooks. |
| `pi-extension/subagents/state.ts` | **move** | Pi host/tool implementation or model-facing contract; keep schema, defaults and result text unchanged. |
| `pi-extension/subagents/task-models.ts` | **move** | Pi host/tool implementation or model-facing contract; keep schema, defaults and result text unchanged. |
| `pi-extension/subagents/tool-boundary.ts` | **move** | Pi host/tool implementation or model-facing contract; keep schema, defaults and result text unchanged. |
| `pi-extension/subagents/widgets.ts` | **stay** | Terminal-only widget/status timers or message rendering; receives Maestro state/serializer via host hooks. |
| `pi-extension/subagents/worktree-tools.ts` | **move** | Pi host/tool implementation or model-facing contract; keep schema, defaults and result text unchanged. |

### A2. Additional assets/tooling with explicit ownership

| Source path at main | Fate | Reason / split boundary |
| --- | --- | --- |
| `.pi/skills/verify-pi-herdr-agents/scripts/lab.ts` | **stay** | Isolated terminal-host integration driver/lab; replace moving imports with package subpaths. |
| `.pi/skills/verify-pi-herdr-agents/scripts/pin.ts` | **stay** | Host registration pinning tool; adapt constructed imports to wrapper and retained/shared mock fixture. |
| `LICENSE` | **stay** | Maestro ships its own nubl MIT LICENSE; nothing is copied. |
| `biome.json` | **split** | Copy required config/tooling/contract/fixture or attribution into Maestro; original host asset remains. Adapt only package/build/entry ownership as specified. |
| `config.json.example` | **split** | Copy required config/tooling/contract/fixture or attribution into Maestro; original host asset remains. Adapt only package/build/entry ownership as specified. |
| `docs/delegation-outcome-contract.md` | **split** | Copy required config/tooling/contract/fixture or attribution into Maestro; original host asset remains. Adapt only package/build/entry ownership as specified. |
| `docs/tools.md` | **split** | Copy required config/tooling/contract/fixture or attribution into Maestro; original host asset remains. Adapt only package/build/entry ownership as specified. |
| `examples/role-pack/extension.ts` | **split** | Copy required config/tooling/contract/fixture or attribution into Maestro; original host asset remains. Adapt only package/build/entry ownership as specified. |
| `examples/role-pack/package.json` | **split** | Copy required config/tooling/contract/fixture or attribution into Maestro; original host asset remains. Adapt only package/build/entry ownership as specified. |
| `examples/role-pack/roles/example-reviewer.md` | **split** | Copy required config/tooling/contract/fixture or attribution into Maestro; original host asset remains. Adapt only package/build/entry ownership as specified. |
| `oxlint.config.ts` | **split** | Copy required config/tooling/contract/fixture or attribution into Maestro; original host asset remains. Adapt only package/build/entry ownership as specified. |
| `package-lock.json` | **split** | Use upstream resolved versions as the dependency baseline, then generate a Maestro lockfile for its own package metadata/dependencies; keep host lockfile upstream. |
| `package.json` | **split** | Port test/tool versions and relevant scripts into the existing Maestro manifest; preserve Maestro identity, Node floor and trusted publishing, and retain host metadata upstream. |
| `plugins/sidebar/README.md` | **stay** | Terminal-host plugin or operating guide; update package references upstream only, do not move host UI/workflow guidance into engine. |
| `plugins/sidebar/herdr-plugin.toml` | **stay** | Terminal-host plugin or operating guide; update package references upstream only, do not move host UI/workflow guidance into engine. |
| `plugins/sidebar/sidebar.mjs` | **stay** | Terminal-host plugin or operating guide; update package references upstream only, do not move host UI/workflow guidance into engine. |
| `scripts/run-linux-integration.ts` | **stay** | Isolated terminal-host integration driver/lab; replace moving imports with package subpaths. |
| `scripts/tool-docs.ts` | **split** | Copy required config/tooling/contract/fixture or attribution into Maestro; original host asset remains. Adapt only package/build/entry ownership as specified. |
| `scripts/update-tool-docs.ts` | **split** | Copy required config/tooling/contract/fixture or attribution into Maestro; original host asset remains. Adapt only package/build/entry ownership as specified. |
| `skills/pi-herdr-agents/SKILL.md` | **stay** | Terminal-host plugin or operating guide; update package references upstream only, do not move host UI/workflow guidance into engine. |
| `tools/oxlint/anti-slop/effect/index.ts` | **stay** | Not in the active upstream Oxlint plugin import closure; no Effect tooling expansion during extraction. |
| `tools/oxlint/anti-slop/effect/rules/no-service-constructor-imports.ts` | **stay** | Not in the active upstream Oxlint plugin import closure; retain unused upstream development rule only. |
| `tools/oxlint/anti-slop/index.ts` | **split** | Copy the formatter/lint plugin dependency closure for identical tooling; leave upstream development copy. Effect-specific rules are tooling only, not Effect adoption. |
| `tools/oxlint/anti-slop/rules/no-chained-type-assertions.ts` | **split** | Copy the formatter/lint plugin dependency closure for identical tooling; leave upstream development copy. Effect-specific rules are tooling only, not Effect adoption. |
| `tools/oxlint/anti-slop/rules/no-conditional-empty-object-spread.ts` | **split** | Copy the formatter/lint plugin dependency closure for identical tooling; leave upstream development copy. Effect-specific rules are tooling only, not Effect adoption. |
| `tools/oxlint/anti-slop/rules/no-known-value-widening.ts` | **split** | Copy the formatter/lint plugin dependency closure for identical tooling; leave upstream development copy. Effect-specific rules are tooling only, not Effect adoption. |
| `tools/oxlint/anti-slop/rules/no-module-mocking.ts` | **split** | Copy the formatter/lint plugin dependency closure for identical tooling; leave upstream development copy. Effect-specific rules are tooling only, not Effect adoption. |
| `tools/oxlint/anti-slop/rules/no-object-parameters.ts` | **split** | Copy the formatter/lint plugin dependency closure for identical tooling; leave upstream development copy. Effect-specific rules are tooling only, not Effect adoption. |
| `tools/oxlint/anti-slop/rules/no-reflect-apply.ts` | **split** | Copy the formatter/lint plugin dependency closure for identical tooling; leave upstream development copy. Effect-specific rules are tooling only, not Effect adoption. |
| `tools/oxlint/anti-slop/rules/no-reflect-get.ts` | **split** | Copy the formatter/lint plugin dependency closure for identical tooling; leave upstream development copy. Effect-specific rules are tooling only, not Effect adoption. |
| `tools/oxlint/anti-slop/rules/no-runtime-typeof.ts` | **split** | Copy the formatter/lint plugin dependency closure for identical tooling; leave upstream development copy. Effect-specific rules are tooling only, not Effect adoption. |
| `tools/oxlint/anti-slop/rules/no-shape-in-symbol-names.ts` | **split** | Copy the formatter/lint plugin dependency closure for identical tooling; leave upstream development copy. Effect-specific rules are tooling only, not Effect adoption. |
| `tools/oxlint/anti-slop/rules/no-unknown-parameters.ts` | **split** | Copy the formatter/lint plugin dependency closure for identical tooling; leave upstream development copy. Effect-specific rules are tooling only, not Effect adoption. |
| `tools/oxlint/anti-slop/rules/no-unknown-returns.ts` | **split** | Copy the formatter/lint plugin dependency closure for identical tooling; leave upstream development copy. Effect-specific rules are tooling only, not Effect adoption. |
| `tools/oxlint/anti-slop/rules/no-unknown-type-aliases.ts` | **split** | Copy the formatter/lint plugin dependency closure for identical tooling; leave upstream development copy. Effect-specific rules are tooling only, not Effect adoption. |
| `tools/oxlint/anti-slop/rules/no-unsafe-dictionary-type.ts` | **split** | Copy the formatter/lint plugin dependency closure for identical tooling; leave upstream development copy. Effect-specific rules are tooling only, not Effect adoption. |
| `tools/oxlint/anti-slop/rules/no-widen-then-assert.ts` | **split** | Copy the formatter/lint plugin dependency closure for identical tooling; leave upstream development copy. Effect-specific rules are tooling only, not Effect adoption. |
| `tools/oxlint/anti-slop/rules/require-safety-comment-for-type-assertion.ts` | **split** | Copy the formatter/lint plugin dependency closure for identical tooling; leave upstream development copy. Effect-specific rules are tooling only, not Effect adoption. |
| `tools/oxlint/anti-slop/shared/dictionary-types.ts` | **split** | Copy the formatter/lint plugin dependency closure for identical tooling; leave upstream development copy. Effect-specific rules are tooling only, not Effect adoption. |
| `tools/oxlint/anti-slop/shared/lexical-type-parameters.ts` | **split** | Copy the formatter/lint plugin dependency closure for identical tooling; leave upstream development copy. Effect-specific rules are tooling only, not Effect adoption. |
| `tools/oxlint/anti-slop/shared/reflect-method.ts` | **split** | Copy the formatter/lint plugin dependency closure for identical tooling; leave upstream development copy. Effect-specific rules are tooling only, not Effect adoption. |
| `tsconfig.json` | **split** | Copy required config/tooling/contract/fixture or attribution into Maestro; original host asset remains. Adapt only package/build/entry ownership as specified. |

ADRs remain upstream as immutable historical decisions; cite them rather than mechanically renaming their product scope. The new extraction plan records the superseding package decision. Source README/development/install prose stays upstream; author Maestro-specific usage documentation around the unchanged contract.

## Appendix B. Exact test inventory

All 110 tracked test-tree files are listed, including non-entry fixtures. Preserve original entry-point coverage through §5’s test-title ledger; a **split** row never authorizes dropping an assertion.

| Source path at main | Fate | Reason / split boundary |
| --- | --- | --- |
| `test/bench/README.md` | **split** | Supervision benchmark follows moving engine; retain host invocation/benchmark documentation with package imports upstream. |
| `test/bench/supervision-bench.mjs` | **split** | Supervision benchmark follows moving engine; retain host invocation/benchmark documentation with package imports upstream. |
| `test/clean-host-env.ts` | **split** | Shared test support copied only where needed in both suites; preserve isolation, assertions and fixture semantics. |
| `test/fake-herdr-socket.ts` | **stay** | Herdr socket protocol fixture; concrete transport remains upstream. |
| `test/fixtures/tool-schema/current.json` | **split** | Identical immutable contract fixture in both packages while both registration surfaces are checked; no regeneration during extraction. |
| `test/fixtures/tool-schema/released.json` | **split** | Identical immutable contract fixture in both packages while both registration surfaces are checked; no regeneration during extraction. |
| `test/helpers/mock-extension-api.ts` | **split** | Shared test support copied only where needed in both suites; preserve isolation, assertions and fixture semantics. |
| `test/helpers/process-cleanup.ts` | **split** | Shared test support copied only where needed in both suites; preserve isolation, assertions and fixture semantics. |
| `test/helpers/tool-schema-capture.ts` | **split** | Shared test support copied only where needed in both suites; preserve isolation, assertions and fixture semantics. |
| `test/helpers/tool-schema-compat.ts` | **split** | Shared test support copied only where needed in both suites; preserve isolation, assertions and fixture semantics. |
| `test/helpers/windows-scope.ts` | **split** | Shared test support copied only where needed in both suites; preserve isolation, assertions and fixture semantics. |
| `test/integration/agents/test-coordinator.md` | **split** | Fixture role for real delegation; retain host lab copy and copy only as needed for package child-entry smoke. |
| `test/integration/agents/test-echo.md` | **split** | Fixture role reused for package child-entry smoke and host labs; test-only copy. |
| `test/integration/agents/test-interactive.md` | **split** | Fixture role reused for package protocol smoke and host labs; test-only copy. |
| `test/integration/agents/test-ping.md` | **split** | Fixture role reused for caller_ping parity and host labs; test-only copy. |
| `test/integration/agents/test-restricted.md` | **split** | Fixture role reused for tool-policy parity and host labs; test-only copy. |
| `test/integration/audit-stop-shutdown-fixture.ts` | **stay** | Real terminal/Core/sidebar integration or its fixture; run upstream against installed Maestro with retained host wrapper. |
| `test/integration/audit-stop.test.ts` | **stay** | Real terminal/Core/sidebar integration or its fixture; run upstream against installed Maestro with retained host wrapper. |
| `test/integration/core-controls.test.ts` | **stay** | Real terminal/Core/sidebar integration or its fixture; run upstream against installed Maestro with retained host wrapper. |
| `test/integration/core-lifecycle.test.ts` | **stay** | Real terminal/Core/sidebar integration or its fixture; run upstream against installed Maestro with retained host wrapper. |
| `test/integration/core-parent.ts` | **stay** | Real terminal/Core/sidebar integration or its fixture; run upstream against installed Maestro with retained host wrapper. |
| `test/integration/fake-provider.ts` | **split** | Credential-free model-service fixture reused by both package consumer smoke and retained terminal labs; test-only copy. |
| `test/integration/hang-advisory.test.ts` | **split** | Pi-host/session-file behavior with no real provider imports: move behavior cases, retain wrapper entry smoke upstream. |
| `test/integration/harness-conformance.test.ts` | **stay** | Real terminal/Core/sidebar integration or its fixture; run upstream against installed Maestro with retained host wrapper. |
| `test/integration/harness.ts` | **stay** | Real terminal/Core/sidebar integration or its fixture; run upstream against installed Maestro with retained host wrapper. |
| `test/integration/herdr-core-lab.ts` | **stay** | Real terminal/Core/sidebar integration or its fixture; run upstream against installed Maestro with retained host wrapper. |
| `test/integration/herdr-core.test.ts` | **stay** | Real terminal/Core/sidebar integration or its fixture; run upstream against installed Maestro with retained host wrapper. |
| `test/integration/herdr-lab.ts` | **stay** | Real terminal/Core/sidebar integration or its fixture; run upstream against installed Maestro with retained host wrapper. |
| `test/integration/mux-surface.test.ts` | **stay** | Real terminal/Core/sidebar integration or its fixture; run upstream against installed Maestro with retained host wrapper. |
| `test/integration/persistent-specialist.test.ts` | **stay** | Real terminal/Core/sidebar integration or its fixture; run upstream against installed Maestro with retained host wrapper. |
| `test/integration/placement.test.ts` | **stay** | Real terminal/Core/sidebar integration or its fixture; run upstream against installed Maestro with retained host wrapper. |
| `test/integration/sidebar-fixture.ts` | **stay** | Real terminal/Core/sidebar integration or its fixture; run upstream against installed Maestro with retained host wrapper. |
| `test/integration/sidebar-lifecycle.test.ts` | **stay** | Real terminal/Core/sidebar integration or its fixture; run upstream against installed Maestro with retained host wrapper. |
| `test/integration/sidebar.test.ts` | **stay** | Real terminal/Core/sidebar integration or its fixture; run upstream against installed Maestro with retained host wrapper. |
| `test/integration/subagent-cancel.test.ts` | **stay** | Real terminal/Core/sidebar integration or its fixture; run upstream against installed Maestro with retained host wrapper. |
| `test/integration/subagent-lifecycle.test.ts` | **stay** | Real terminal/Core/sidebar integration or its fixture; run upstream against installed Maestro with retained host wrapper. |
| `test/integration/supervision.test.ts` | **split** | Move generic supervision/completion/message cases; retain actual wrapper-composition coverage upstream. |
| `test/integration/surface-conformance.test.ts` | **stay** | Real terminal/Core/sidebar integration or its fixture; run upstream against installed Maestro with retained host wrapper. |
| `test/isolated-agent-dir.ts` | **split** | Shared test support copied only where needed in both suites; preserve isolation, assertions and fixture semantics. |
| `test/launch.test.ts` | **split** | Move fake-surface Pi launch transactions; retain Herdr CLI/terminal dispatch and host composition cases. |
| `test/maestro/accept-check.test.ts` | **move** | Tests follow moving core/Pi/tool behavior; rewrite imports only and retain every assertion. |
| `test/maestro/accept-recheck.test.ts` | **move** | Tests follow moving core/Pi/tool behavior; rewrite imports only and retain every assertion. |
| `test/maestro/accept-shutdown.test.ts` | **move** | Tests follow moving core/Pi/tool behavior; rewrite imports only and retain every assertion. |
| `test/maestro/async-io.test.ts` | **split** | Move generic RunSession async acquisition cases; retain concrete Herdr nonblocking observation/dispatch cases. |
| `test/maestro/audit-discovery.test.ts` | **move** | Tests follow moving core/Pi/tool behavior; rewrite imports only and retain every assertion. |
| `test/maestro/audit-fork.test.ts` | **move** | Tests follow moving core/Pi/tool behavior; rewrite imports only and retain every assertion. |
| `test/maestro/audit-git-environment.test.ts` | **move** | Tests follow moving core/Pi/tool behavior; rewrite imports only and retain every assertion. |
| `test/maestro/audit-herdr-dispatch.test.ts` | **stay** | Herdr dispatch uncertainty/ownership assertions remain with concrete provider. |
| `test/maestro/audit-ownership.test.ts` | **split** | Move Pi ownership cases; retain concrete terminal launch-hook assertions. |
| `test/maestro/audit-persistent.test.ts` | **move** | Tests follow moving core/Pi/tool behavior; rewrite imports only and retain every assertion. |
| `test/maestro/audit-reload.test.ts` | **move** | Tests follow moving core/Pi/tool behavior; rewrite imports only and retain every assertion. |
| `test/maestro/audit-stop-notices.test.ts` | **move** | Tests follow moving core/Pi/tool behavior; rewrite imports only and retain every assertion. |
| `test/maestro/audit-uncertain-retry.test.ts` | **move** | Tests follow moving core/Pi/tool behavior; rewrite imports only and retain every assertion. |
| `test/maestro/core-lab.test.ts` | **stay** | Concrete host provider/transport or integration-lab coverage; remain upstream and exercise package dependencies. |
| `test/maestro/core-parent.test.ts` | **stay** | Concrete host provider/transport or integration-lab coverage; remain upstream and exercise package dependencies. |
| `test/maestro/core-roles-config.test.ts` | **move** | Tests follow moving core/Pi/tool behavior; rewrite imports only and retain every assertion. |
| `test/maestro/deadline.test.ts` | **move** | Tests follow moving core/Pi/tool behavior; rewrite imports only and retain every assertion. |
| `test/maestro/declared-skills.test.ts` | **move** | Tests follow moving core/Pi/tool behavior; rewrite imports only and retain every assertion. |
| `test/maestro/deferred-tools.test.ts` | **move** | Tests follow moving core/Pi/tool behavior; rewrite imports only and retain every assertion. |
| `test/maestro/delegated-marker.test.ts` | **split** | Move marker state-machine cases with injected callbacks; retain socket transport/protocol mapping cases. |
| `test/maestro/delegation-depth.test.ts` | **move** | Tests follow moving core/Pi/tool behavior; rewrite imports only and retain every assertion. |
| `test/maestro/dependency-rule.test.ts` | **split** | Preserve rule-parser tests in both scopes; tighten Maestro no-Herdr/no-TUI boundary and retain host provider-boundary checks. |
| `test/maestro/fake-harness-adapter.test.ts` | **move** | Tests follow moving core/Pi/tool behavior; rewrite imports only and retain every assertion. |
| `test/maestro/fake-surface-provider.test.ts` | **move** | Tests follow moving core/Pi/tool behavior; rewrite imports only and retain every assertion. |
| `test/maestro/git-handoff-async.test.ts` | **move** | Tests follow moving core/Pi/tool behavior; rewrite imports only and retain every assertion. |
| `test/maestro/harness-adapter.conformance.ts` | **split** | One reusable conformance implementation in Maestro testing entry; host imports it for real-Pi conformance. |
| `test/maestro/herdr-available.test.ts` | **stay** | Concrete host provider/transport or integration-lab coverage; remain upstream and exercise package dependencies. |
| `test/maestro/herdr-cli.test.ts` | **stay** | Concrete host provider/transport or integration-lab coverage; remain upstream and exercise package dependencies. |
| `test/maestro/herdr-core-execution.test.ts` | **split** | Keep Core protocol/acquisition/termination composition upstream; move generic runtime injected-native-binding assertions without weakening them. |
| `test/maestro/herdr-lab.test.ts` | **stay** | Concrete host provider/transport or integration-lab coverage; remain upstream and exercise package dependencies. |
| `test/maestro/herdr-placement-async.test.ts` | **stay** | Concrete host provider/transport or integration-lab coverage; remain upstream and exercise package dependencies. |
| `test/maestro/herdr-socket.test.ts` | **stay** | Concrete host provider/transport or integration-lab coverage; remain upstream and exercise package dependencies. |
| `test/maestro/herdr-surface-provider.test.ts` | **stay** | Concrete host provider/transport or integration-lab coverage; remain upstream and exercise package dependencies. |
| `test/maestro/linux-integration-driver.test.ts` | **stay** | Concrete host provider/transport or integration-lab coverage; remain upstream and exercise package dependencies. |
| `test/maestro/opened-primary-workspace.test.ts` | **split** | Move pure claim/cleanup policy; retain Herdr snapshot/report implementation cases. |
| `test/maestro/pi-harness-adapter.test.ts` | **move** | Tests follow moving core/Pi/tool behavior; rewrite imports only and retain every assertion. |
| `test/maestro/pi-readiness-windows.test.ts` | **move** | Tests follow moving core/Pi/tool behavior; rewrite imports only and retain every assertion. |
| `test/maestro/pi-run-session.test.ts` | **split** | Move runtime/fake infrastructure cases; retain default-provider/ambient host wiring and terminal-hook cases. |
| `test/maestro/pr110-persistent-regressions.test.ts` | **move** | Tests follow moving core/Pi/tool behavior; rewrite imports only and retain every assertion. |
| `test/maestro/process-cleanup.test.ts` | **split** | Shared process-helper safety checks needed by both suites; test-only copy. |
| `test/maestro/process-environment.test.ts` | **move** | Tests follow moving core/Pi/tool behavior; rewrite imports only and retain every assertion. |
| `test/maestro/process-identity.test.ts` | **move** | Tests follow moving core/Pi/tool behavior; rewrite imports only and retain every assertion. |
| `test/maestro/process-tree.test.ts` | **move** | Tests follow moving core/Pi/tool behavior; rewrite imports only and retain every assertion. |
| `test/maestro/realpath-without-opening.test.ts` | **move** | Tests follow moving core/Pi/tool behavior; rewrite imports only and retain every assertion. |
| `test/maestro/run-session-cancel.test.ts` | **move** | Tests follow moving core/Pi/tool behavior; rewrite imports only and retain every assertion. |
| `test/maestro/run-session.test.ts` | **move** | Tests follow moving core/Pi/tool behavior; rewrite imports only and retain every assertion. |
| `test/maestro/script-launch.test.ts` | **split** | Move shell quoting/Pi trust resolution cases; retain Windows concrete pane-provider/script dispatch cases. |
| `test/maestro/sidebar-fixture-ownership.test.ts` | **stay** | Concrete host provider/transport or integration-lab coverage; remain upstream and exercise package dependencies. |
| `test/maestro/socket-path.test.ts` | **split** | Shared helper conformance needed by both suites; test-only copy. |
| `test/maestro/specialist-notice.test.ts` | **move** | Tests follow moving core/Pi/tool behavior; rewrite imports only and retain every assertion. |
| `test/maestro/supervision-wake.test.ts` | **move** | Tests follow moving core/Pi/tool behavior; rewrite imports only and retain every assertion. |
| `test/maestro/surface-provider.conformance.ts` | **split** | One reusable conformance implementation in Maestro testing entry; host imports it for concrete Herdr conformance. |
| `test/maestro/task-model-approval.test.ts` | **move** | Tests follow moving core/Pi/tool behavior; rewrite imports only and retain every assertion. |
| `test/maestro/task-model-init.test.ts` | **move** | Tests follow moving core/Pi/tool behavior; rewrite imports only and retain every assertion. |
| `test/maestro/task-thinking-wiring.test.ts` | **move** | Tests follow moving core/Pi/tool behavior; rewrite imports only and retain every assertion. |
| `test/maestro/task-thinking.test.ts` | **move** | Tests follow moving core/Pi/tool behavior; rewrite imports only and retain every assertion. |
| `test/maestro/test-environment.test.ts` | **split** | Both npm test entry lists need their own first-import/isolation guard. |
| `test/maestro/tool-schema.test.ts` | **split** | Move contract/capture/compatibility/docs cases; retain wrapper capture parity against same frozen fixtures upstream. |
| `test/maestro/windows-support-scope.test.ts` | **split** | Move platform-policy/tool refusals; retain concrete host binding selection and provider wiring cases. |
| `test/maestro/worktree-operations.test.ts` | **move** | Tests follow moving core/Pi/tool behavior; rewrite imports only and retain every assertion. |
| `test/package-manifest.test.js` | **stay** | Existing host packaging/release/sidebar/lab policy; add separate Maestro packaging checks, do not transplant host assumptions. |
| `test/release-workflow.test.ts` | **stay** | Existing host packaging/release/sidebar/lab policy; add separate Maestro packaging checks, do not transplant host assumptions. |
| `test/runtime-routing.test.ts` | **move** | Tests follow moving core/Pi/tool behavior; rewrite imports only and retain every assertion. |
| `test/sidebar-plugin.test.js` | **stay** | Existing host packaging/release/sidebar/lab policy; add separate Maestro packaging checks, do not transplant host assumptions. |
| `test/socket-path.ts` | **split** | Shared test support copied only where needed in both suites; preserve isolation, assertions and fixture semantics. |
| `test/system-prompt-mode.test.ts` | **move** | Legacy simulation-only smoke follows role/launch behavior; preserve but do not count it as real public-surface parity proof. |
| `test/test.ts` | **split** | Mixed 17,644-line suite: migrate every test by title/line manifest; engine/schema/protocol cases move, Herdr/widget/host-composition cases stay (§5). |
| `test/verify-lab-guards.test.ts` | **stay** | Existing host packaging/release/sidebar/lab policy; add separate Maestro packaging checks, do not transplant host assumptions. |
| `test/worktree-cleanup-fixture.ts` | **split** | Shared test support copied only where needed in both suites; preserve isolation, assertions and fixture semantics. |
| `test/worktree-cleanup.test.ts` | **split** | Move eligibility/Git/manifest cases; retain concrete Herdr workspace-removal composition cases. |

## Appendix C. Experimental revision inventory (A0 only)

| Source path at A0 | Fate of A0 version | Reason |
| --- | --- | --- |
| `maestro/core/worker-execution.ts` | **move** | A0 seam/DTOs only; destination experimental worker module, not new stable core execution API. |
| `maestro/adapters/pi/worker-client.ts` | **move** | A0 HTTP/SSE transport; explicit experimental export, no retry/decoder redesign. |
| `maestro/runtime/pi-worker-session.ts` | **move** | A0 separate owner retained only under experimental namespace; unification is step 2. |
| `pi-extension/subagents/worker-backend.ts` | **split** | Move parent registration to experimental entry and FD branch to tiny child entry; do not import into stable factory. |
| `pi-extension/subagents/index.ts` | **split** | A0 :299 early-return selector is evidence, NOT copied into main-based stable entry. Experimental wrapper preserves opt-in selection separately. |
| `maestro/runtime/index.ts` | **split** | A0 worker re-exports go to experimental facade only; stable runtime uses main inventory. |
| `maestro/adapters/pi/launch.ts` | **stay** | Do not import A0 branch-wide modifications; use main version and only planned packaging path change. |
| `maestro/adapters/pi/launch-resume.ts` | **stay** | Do not import A0 branch-wide modifications; main is behavior baseline. |
| `maestro/adapters/pi/session.ts` | **stay** | A0 variant not transplanted; main is behavior baseline. |
| `maestro/surfaces/herdr/a0-terminal-trap.ts` | **stay** | A0 terminal-provider instrumentation belongs in experimental host tests, not package runtime. |
| `maestro/surfaces/herdr/herdr-surface-provider.ts` | **stay** | Concrete provider and A0 trap stay outside Maestro; no A0 provider changes merged into main by extraction. |
| `maestro/surfaces/herdr/herdr-core-surface-provider.ts` | **stay** | Concrete provider and A0 trap stay outside Maestro. |
| `test/fixtures/worker-cut.ts` | **move** | A0 crash-cut subprocess fixture; adjust executable resource path for source/packed test runners. |
| `test/maestro/worker-backend.test.ts` | **split** | Worker seam cases move; concrete terminal-trap case remains experimental host coverage. Add package import-closure gate without pretending it replaces the trap case. |
| `test/maestro/worker-crash.test.ts` | **move** | Linux SIGKILL/fsync ordering probe; preserve scope and no-power-loss/no-adoption caveats. |
| `test/maestro/worker-delivery.test.ts` | **move** | A0 transport/settlement/cancel/help behavior; isolated Unix socket and Git fixtures. |
| `docs/experimental-pi-worker.md` | **split** | Copy experiment limitations/provenance; host setup details stay with experimental host branch. |

Other A0 modifications to existing test files are **stay/not transplanted**: use main’s Appendix B versions of `test/launch.test.ts`, `test/maestro/accept-recheck.test.ts`, `test/maestro/accept-shutdown.test.ts`, `test/maestro/herdr-cli.test.ts`, `test/maestro/pi-harness-adapter.test.ts`, `test/maestro/pi-run-session.test.ts`, `test/maestro/pr110-persistent-regressions.test.ts`, `test/maestro/process-tree.test.ts`, `test/maestro/script-launch.test.ts`, `test/package-manifest.test.js`, and `test/worktree-cleanup.test.ts`. All also exist at A0. This is a selective closure extraction, never a merge of the experimental branch: its older `session.ts`/launch variants omit main's saved agent/self-spawn policy fields. The four new worker source files and their fixtures/tests are the A0 moving cohort.

## Appendix D. Verified imports across the ownership cut

Each citation gives the **importer:specifier-line → resolved target** at main. This includes type-only imports, re-exports and literal dynamic imports. A split endpoint is conservatively included even when both imported and importing portions ultimately move; such an edge needs portion assignment, not a circular package dependency. Dependencies within two wholly moving or two wholly staying files are not cross-cut edges. External Pi/TUI/TypeBox dependencies are handled in §4; built-ins are not cross-repository edges.

Resolution codes: **H1** provider factory/binding injection (§2.1); **H2** marker structural DTO/transport injection (§2.2); **H3** per-load UI/renderer hooks (§2.3); **H4** child reporter/widget injection (§2.4); **P** retained caller imports the explicit package subpath (§3), never back into upstream; **T** split/moved tests use their local moving portion, retained tests use package exports/testing entry, shared fixtures stay test-only (§5). A moving caller cannot retain an import of a staying implementation: select the moving portion or the named hook, never add a dependency on pi-herdr-agents.

### D1. Production module boundary

| Importer citation | Resolved target | Resolution |
| --- | --- | --- |
| `maestro/adapters/pi/child/subagent-done.ts:18` | `maestro/adapters/pi/session.ts` | H4 |
| `maestro/adapters/pi/child/subagent-done.ts:19` | `maestro/adapters/pi/activity-file.ts` | H4 |
| `maestro/adapters/pi/child/subagent-done.ts:20` | `maestro/adapters/pi/child/done-nudge.ts` | H4 |
| `maestro/adapters/pi/child/subagent-done.ts:21` | `maestro/adapters/pi/child/declared-skills.ts` | H4 |
| `maestro/adapters/pi/child/subagent-done.ts:22` | `maestro/core/child-busy.ts` | H4 |
| `maestro/adapters/pi/child/subagent-done.ts:26` | `maestro/adapters/pi/process-identity.ts` | H4 |
| `maestro/adapters/pi/child/subagent-done.ts:27` | `maestro/core/config/type-guards.ts` | H4 |
| `maestro/adapters/pi/child/subagent-done.ts:28` | `maestro/core/undelivered-children.ts` | H4 |
| `maestro/adapters/pi/child/subagent-done.ts:32` | `maestro/core/accept.ts` | H4 |
| `maestro/adapters/pi/child/subagent-done.ts:33` | `maestro/adapters/pi/accept-runner.ts` | H4 |
| `maestro/adapters/pi/child/subagent-done.ts:34` | `maestro/adapters/pi/child/accept-check.ts` | H4 |
| `maestro/adapters/pi/child/subagent-done.ts:39` | `maestro/core/specialist-notice.ts` | H4 |
| `maestro/runtime/delegated-marker.ts:7` | `maestro/surfaces/herdr/herdr-socket.ts` | H2 |
| `maestro/runtime/herdr-backend.ts:6` | `maestro/core/config/herdr-config.ts` | H1 |
| `maestro/runtime/herdr-backend.ts:7` | `maestro/core/config/pane-config.ts` | H1 |
| `maestro/runtime/herdr-backend.ts:8` | `maestro/core/surface-provider.ts` | H1 |
| `maestro/runtime/herdr-backend.ts:9` | `maestro/core/script-launch.ts` | H1 |
| `maestro/runtime/herdr-backend.ts:10` | `maestro/surfaces/herdr/herdr-surface-provider.ts` | H1 |
| `maestro/runtime/herdr-backend.ts:11` | `maestro/surfaces/herdr/herdr-core-surface-provider.ts` | H1 |
| `maestro/runtime/index.ts:21` | `maestro/runtime/pi-run-session.ts` | H3/P |
| `maestro/runtime/pi-run-session-types.ts:35` | `maestro/runtime/delegated-marker.ts` | H2 |
| `maestro/runtime/pi-run-session.ts:4` | `maestro/core/harness-adapter.ts` | H3/P |
| `maestro/runtime/pi-run-session.ts:12` | `maestro/core/types.ts` | H3/P |
| `maestro/runtime/pi-run-session.ts:13` | `maestro/core/surface-provider.ts` | H3/P |
| `maestro/runtime/pi-run-session.ts:14` | `maestro/adapters/pi/pi-harness-adapter.ts` | H3/P |
| `maestro/runtime/pi-run-session.ts:18` | `maestro/adapters/pi/launch-operations.ts` | H3/P |
| `maestro/runtime/pi-run-session.ts:19` | `maestro/adapters/pi/launch.ts` | H3/P |
| `maestro/runtime/pi-run-session.ts:23` | `maestro/runtime/worktree-operations.ts` | H3/P |
| `maestro/runtime/pi-run-session.ts:27` | `maestro/core/worktree.ts` | H3/P |
| `maestro/runtime/pi-run-session.ts:34` | `maestro/adapters/pi/session.ts` | H3/P |
| `maestro/runtime/pi-run-session.ts:35` | `maestro/runtime/herdr-backend.ts` | H1 |
| `maestro/runtime/pi-run-session.ts:39` | `maestro/core/platform-support.ts` | H3/P |
| `maestro/runtime/pi-run-session.ts:43` | `maestro/core/config/herdr-config.ts` | H3/P |
| `maestro/runtime/pi-run-session.ts:44` | `maestro/adapters/pi/script-shell.ts` | H3/P |
| `maestro/runtime/pi-run-session.ts:45` | `maestro/surfaces/herdr/herdr-surface-provider.ts` | H1 |
| `maestro/runtime/pi-run-session.ts:46` | `maestro/adapters/pi/activity-file.ts` | H3/P |
| `maestro/runtime/pi-run-session.ts:47` | `maestro/core/activity.ts` | H3/P |
| `maestro/runtime/pi-run-session.ts:55` | `maestro/core/lifecycle.ts` | H3/P |
| `maestro/runtime/pi-run-session.ts:56` | `maestro/core/wake.ts` | H3/P |
| `maestro/runtime/pi-run-session.ts:57` | `maestro/core/supervision.ts` | H3/P |
| `maestro/runtime/pi-run-session.ts:64` | `maestro/core/routing.ts` | H3/P |
| `maestro/runtime/pi-run-session.ts:65` | `maestro/core/config/pane-config.ts` | H3/P |
| `maestro/runtime/pi-run-session.ts:71` | `maestro/runtime/delegated-marker.ts` | H2 |
| `maestro/runtime/pi-run-session.ts:78` | `maestro/runtime/run-session.ts` | H3/P |
| `maestro/runtime/pi-run-session.ts:79` | `maestro/runtime/pi-persistent-io.ts` | H3/P |
| `maestro/runtime/pi-run-session.ts:85` | `maestro/runtime/accept-recheck.ts` | H3/P |
| `maestro/runtime/pi-run-session.ts:86` | `maestro/adapters/pi/accept-runner.ts` | H3/P |
| `maestro/runtime/pi-run-session.ts:90` | `maestro/adapters/pi/accept-groups.ts` | H3/P |
| `maestro/runtime/pi-run-session.ts:103` | `maestro/runtime/pi-run-session-types.ts` | H3/P |
| `maestro/surfaces/herdr/herdr-cli.ts:4` | `maestro/core/config/type-guards.ts` | P |
| `maestro/surfaces/herdr/herdr-cli.ts:5` | `maestro/core/deadline.ts` | P |
| `maestro/surfaces/herdr/herdr-cli.ts:6` | `maestro/core/git-environment.ts` | P |
| `maestro/surfaces/herdr/herdr-core-protocol.ts:2` | `maestro/core/deadline.ts` | P |
| `maestro/surfaces/herdr/herdr-core-protocol.ts:3` | `maestro/core/surface-provider.ts` | P |
| `maestro/surfaces/herdr/herdr-core-surface-provider.ts:7` | `maestro/core/surface-provider.ts` | P |
| `maestro/surfaces/herdr/herdr-core-surface-provider.ts:11` | `maestro/core/surface-provider.ts` | P |
| `maestro/surfaces/herdr/herdr-core-surface-provider.ts:12` | `maestro/core/types.ts` | P |
| `maestro/surfaces/herdr/herdr-pane.ts:5` | `maestro/core/config/type-guards.ts` | P |
| `maestro/surfaces/herdr/herdr-pane.ts:7` | `maestro/core/deadline.ts` | P |
| `maestro/surfaces/herdr/herdr-pane.ts:12` | `maestro/core/types.ts` | P |
| `maestro/surfaces/herdr/herdr-socket.ts:7` | `maestro/core/config/type-guards.ts` | P |
| `maestro/surfaces/herdr/herdr-surface-provider.ts:10` | `maestro/core/surface-provider.ts` | P |
| `maestro/surfaces/herdr/herdr-surface-provider.ts:11` | `maestro/core/opened-primary-workspace.ts` | P |
| `maestro/surfaces/herdr/herdr-surface-provider.ts:12` | `maestro/core/types.ts` | P |
| `maestro/surfaces/herdr/herdr-surface-provider.ts:13` | `maestro/core/config/pane-config.ts` | P |
| `maestro/surfaces/herdr/herdr-surface-provider.ts:14` | `maestro/core/script-launch.ts` | P |
| `maestro/surfaces/herdr/herdr.ts:8` | `maestro/core/config/type-guards.ts` | P |
| `maestro/surfaces/herdr/herdr.ts:9` | `maestro/core/deadline.ts` | P |
| `maestro/surfaces/herdr/herdr.ts:16` | `maestro/core/opened-primary-workspace.ts` | P |
| `maestro/surfaces/herdr/herdr.ts:17` | `maestro/core/realpath-without-opening.ts` | P |
| `maestro/surfaces/herdr/herdr.ts:25` | `maestro/core/surface-provider.ts` | P |
| `maestro/surfaces/herdr/terminal.ts:9` | `maestro/core/script-launch.ts` | P |
| `maestro/surfaces/herdr/terminal.ts:10` | `maestro/core/shell.ts` | P |
| `maestro/surfaces/herdr/terminal.ts:197` | `maestro/core/types.ts` | P |
| `maestro/surfaces/herdr/terminal.ts:208` | `maestro/core/types.ts` | P |
| `pi-extension/subagents/control-tools.ts:4` | `maestro/core/config/supervision-config.ts` | H3/P |
| `pi-extension/subagents/control-tools.ts:5` | `pi-extension/subagents/state.ts` | H3/P |
| `pi-extension/subagents/control-tools.ts:10` | `pi-extension/subagents/catalog.ts` | H3/P |
| `pi-extension/subagents/control-tools.ts:11` | `pi-extension/subagents/presentation.ts` | H3/P |
| `pi-extension/subagents/control-tools.ts:15` | `maestro/core/host-text.ts` | H3/P |
| `pi-extension/subagents/control-tools.ts:21` | `pi-extension/subagents/controls.ts` | H3/P |
| `pi-extension/subagents/control-tools.ts:22` | `pi-extension/subagents/persistent.ts` | H3/P |
| `pi-extension/subagents/control-tools.ts:23` | `pi-extension/subagents/deferred-tools.ts` | H3/P |
| `pi-extension/subagents/index.ts:1` | `pi-extension/subagents/tool-boundary.ts` | H3/P |
| `pi-extension/subagents/index.ts:2` | `pi-extension/subagents/deferred-tools.ts` | H3/P |
| `pi-extension/subagents/index.ts:12` | `maestro/runtime/index.ts` | H3/P |
| `pi-extension/subagents/index.ts:13` | `maestro/core/config/supervision-config.ts` | H3/P |
| `pi-extension/subagents/index.ts:19` | `maestro/core/routing.ts` | H3/P |
| `pi-extension/subagents/index.ts:20` | `pi-extension/subagents/model-registry.ts` | H3/P |
| `pi-extension/subagents/index.ts:21` | `maestro/core/config/model-config.ts` | H3/P |
| `pi-extension/subagents/index.ts:27` | `pi-extension/subagents/config-path.ts` | H3/P |
| `pi-extension/subagents/index.ts:28` | `maestro/core/config/role-config.ts` | H3/P |
| `pi-extension/subagents/index.ts:29` | `maestro/core/config/persistent-config.ts` | H3/P |
| `pi-extension/subagents/index.ts:30` | `maestro/core/config/spawning-config.ts` | H3/P |
| `pi-extension/subagents/index.ts:31` | `maestro/core/config/outcome-ledger-config.ts` | H3/P |
| `pi-extension/subagents/index.ts:32` | `maestro/core/config/pane-config.ts` | H3/P |
| `pi-extension/subagents/index.ts:33` | `maestro/core/config/guidelines-config.ts` | H3/P |
| `pi-extension/subagents/index.ts:34` | `maestro/core/status.ts` | H3/P |
| `pi-extension/subagents/index.ts:35` | `maestro/core/lifecycle.ts` | H3/P |
| `pi-extension/subagents/index.ts:36` | `maestro/core/worktree-cleanup.ts` | H3/P |
| `pi-extension/subagents/index.ts:40` | `maestro/core/child-busy.ts` | H3/P |
| `pi-extension/subagents/index.ts:55` | `pi-extension/subagents/state.ts` | H3/P |
| `pi-extension/subagents/index.ts:65` | `pi-extension/subagents/catalog.ts` | H3/P |
| `pi-extension/subagents/index.ts:69` | `pi-extension/subagents/presentation.ts` | H3/P |
| `pi-extension/subagents/index.ts:70` | `pi-extension/subagents/renderers.ts` | H3/P |
| `pi-extension/subagents/index.ts:75` | `pi-extension/subagents/observation.ts` | H3/P |
| `pi-extension/subagents/index.ts:76` | `pi-extension/subagents/controls.ts` | H3/P |
| `pi-extension/subagents/index.ts:80` | `pi-extension/subagents/persistent.ts` | H3/P |
| `pi-extension/subagents/index.ts:81` | `pi-extension/subagents/delivery.ts` | H3/P |
| `pi-extension/subagents/index.ts:82` | `pi-extension/subagents/launch.ts` | H3/P |
| `pi-extension/subagents/index.ts:83` | `pi-extension/subagents/widgets.ts` | H3/P |
| `pi-extension/subagents/index.ts:87` | `pi-extension/subagents/worktree-tools.ts` | H3/P |
| `pi-extension/subagents/index.ts:88` | `pi-extension/subagents/task-models.ts` | H3/P |
| `pi-extension/subagents/index.ts:89` | `pi-extension/subagents/control-tools.ts` | H3/P |
| `pi-extension/subagents/index.ts:94` | `pi-extension/subagents/launch-tools.ts` | H3/P |
| `pi-extension/subagents/launch-tools.ts:6` | `maestro/runtime/index.ts` | H3/P |
| `pi-extension/subagents/launch-tools.ts:10` | `maestro/core/config/type-guards.ts` | H3/P |
| `pi-extension/subagents/launch-tools.ts:15` | `pi-extension/subagents/state.ts` | H3/P |
| `pi-extension/subagents/launch-tools.ts:25` | `pi-extension/subagents/catalog.ts` | H3/P |
| `pi-extension/subagents/launch-tools.ts:29` | `maestro/core/accept.ts` | H3/P |
| `pi-extension/subagents/launch-tools.ts:30` | `maestro/core/specialist-notice.ts` | H3/P |
| `pi-extension/subagents/launch-tools.ts:31` | `pi-extension/subagents/presentation.ts` | H3/P |
| `pi-extension/subagents/launch-tools.ts:36` | `maestro/core/host-text.ts` | H3/P |
| `pi-extension/subagents/launch-tools.ts:37` | `pi-extension/subagents/persistent.ts` | H3/P |
| `pi-extension/subagents/launch-tools.ts:38` | `pi-extension/subagents/deferred-tools.ts` | H3/P |
| `pi-extension/subagents/launch-tools.ts:39` | `pi-extension/subagents/launch.ts` | H3/P |
| `pi-extension/subagents/launch-tools.ts:40` | `maestro/core/config/spawning-config.ts` | H3/P |
| `pi-extension/subagents/launch-tools.ts:45` | `maestro/core/delegation-depth.ts` | H3/P |
| `pi-extension/subagents/renderers.ts:7` | `maestro/core/config/type-guards.ts` | P |
| `pi-extension/subagents/renderers.ts:8` | `maestro/core/host-text.ts` | P |
| `pi-extension/subagents/renderers.ts:13` | `pi-extension/subagents/presentation.ts` | P |
| `pi-extension/subagents/widgets.ts:3` | `maestro/core/config/supervision-config.ts` | P |
| `pi-extension/subagents/widgets.ts:4` | `maestro/core/host-text.ts` | P |
| `pi-extension/subagents/widgets.ts:11` | `maestro/core/status.ts` | P |
| `pi-extension/subagents/widgets.ts:16` | `maestro/core/lifecycle.ts` | P |
| `pi-extension/subagents/widgets.ts:23` | `pi-extension/subagents/state.ts` | P |
| `pi-extension/subagents/widgets.ts:27` | `pi-extension/subagents/observation.ts` | P |
| `pi-extension/subagents/worktree-tools.ts:22` | `pi-extension/subagents/launch-tools.ts` | H3/P |
| `tools/oxlint/anti-slop/index.ts:3` | `tools/oxlint/anti-slop/rules/no-chained-type-assertions.ts` | H3/P |
| `tools/oxlint/anti-slop/index.ts:4` | `tools/oxlint/anti-slop/rules/no-conditional-empty-object-spread.ts` | H3/P |
| `tools/oxlint/anti-slop/index.ts:5` | `tools/oxlint/anti-slop/rules/no-known-value-widening.ts` | H3/P |
| `tools/oxlint/anti-slop/index.ts:6` | `tools/oxlint/anti-slop/rules/no-module-mocking.ts` | H3/P |
| `tools/oxlint/anti-slop/index.ts:7` | `tools/oxlint/anti-slop/rules/no-object-parameters.ts` | H3/P |
| `tools/oxlint/anti-slop/index.ts:8` | `tools/oxlint/anti-slop/rules/no-reflect-apply.ts` | H3/P |
| `tools/oxlint/anti-slop/index.ts:9` | `tools/oxlint/anti-slop/rules/no-reflect-get.ts` | H3/P |
| `tools/oxlint/anti-slop/index.ts:10` | `tools/oxlint/anti-slop/rules/no-runtime-typeof.ts` | H3/P |
| `tools/oxlint/anti-slop/index.ts:11` | `tools/oxlint/anti-slop/rules/no-shape-in-symbol-names.ts` | H3/P |
| `tools/oxlint/anti-slop/index.ts:12` | `tools/oxlint/anti-slop/rules/no-unknown-parameters.ts` | H3/P |
| `tools/oxlint/anti-slop/index.ts:13` | `tools/oxlint/anti-slop/rules/no-unknown-returns.ts` | H3/P |
| `tools/oxlint/anti-slop/index.ts:14` | `tools/oxlint/anti-slop/rules/no-unknown-type-aliases.ts` | H3/P |
| `tools/oxlint/anti-slop/index.ts:15` | `tools/oxlint/anti-slop/rules/no-unsafe-dictionary-type.ts` | H3/P |
| `tools/oxlint/anti-slop/index.ts:16` | `tools/oxlint/anti-slop/rules/no-widen-then-assert.ts` | H3/P |
| `tools/oxlint/anti-slop/index.ts:17` | `tools/oxlint/anti-slop/rules/require-safety-comment-for-type-assertion.ts` | H3/P |
| `tools/oxlint/anti-slop/rules/no-known-value-widening.ts:9` | `tools/oxlint/anti-slop/shared/dictionary-types.ts` | H3/P |
| `tools/oxlint/anti-slop/rules/no-object-parameters.ts:5` | `tools/oxlint/anti-slop/shared/lexical-type-parameters.ts` | H3/P |
| `tools/oxlint/anti-slop/rules/no-reflect-apply.ts:3` | `tools/oxlint/anti-slop/shared/reflect-method.ts` | H3/P |
| `tools/oxlint/anti-slop/rules/no-reflect-get.ts:3` | `tools/oxlint/anti-slop/shared/reflect-method.ts` | H3/P |
| `tools/oxlint/anti-slop/rules/no-unknown-returns.ts:5` | `tools/oxlint/anti-slop/shared/lexical-type-parameters.ts` | H3/P |
| `tools/oxlint/anti-slop/rules/no-unsafe-dictionary-type.ts:8` | `tools/oxlint/anti-slop/shared/dictionary-types.ts` | H3/P |

### D2. Test/tooling boundary (including retained integration callers)

| Importer citation | Resolved target | Resolution |
| --- | --- | --- |
| `.pi/skills/verify-pi-herdr-agents/scripts/lab.ts:40` | `maestro/adapters/pi/process-identity.ts` | T |
| `.pi/skills/verify-pi-herdr-agents/scripts/lab.ts:356` | `test/integration/fake-provider.ts` | T |
| `scripts/run-linux-integration.ts:8` | `maestro/core/config/type-guards.ts` | T |
| `scripts/tool-docs.ts:8` | `maestro/core/config/type-guards.ts` | T |
| `scripts/tool-docs.ts:12` | `test/helpers/tool-schema-capture.ts` | T |
| `scripts/update-tool-docs.ts:2` | `test/helpers/tool-schema-capture.ts` | T |
| `scripts/update-tool-docs.ts:3` | `scripts/tool-docs.ts` | T |
| `test/bench/supervision-bench.mjs:21` | `maestro/core/supervision.ts` | T |
| `test/bench/supervision-bench.mjs:22` | `maestro/adapters/pi/completion.ts` | T |
| `test/fake-herdr-socket.ts:11` | `maestro/core/config/type-guards.ts` | T |
| `test/fake-herdr-socket.ts:12` | `test/socket-path.ts` | T |
| `test/helpers/process-cleanup.ts:4` | `maestro/adapters/pi/process-identity.ts` | T |
| `test/helpers/tool-schema-capture.ts:5` | `test/helpers/mock-extension-api.ts` | T |
| `test/helpers/tool-schema-compat.ts:7` | `maestro/core/config/type-guards.ts` | T |
| `test/helpers/tool-schema-compat.ts:8` | `test/helpers/tool-schema-capture.ts` | T |
| `test/integration/audit-stop.test.ts:19` | `test/integration/fake-provider.ts` | T |
| `test/integration/core-controls.test.ts:12` | `maestro/core/config/type-guards.ts` | T |
| `test/integration/core-controls.test.ts:23` | `test/integration/fake-provider.ts` | T |
| `test/integration/core-lifecycle.test.ts:11` | `maestro/core/config/type-guards.ts` | T |
| `test/integration/core-lifecycle.test.ts:27` | `test/integration/fake-provider.ts` | T |
| `test/integration/core-parent.ts:18` | `maestro/core/config/type-guards.ts` | T |
| `test/integration/core-parent.ts:24` | `test/integration/fake-provider.ts` | T |
| `test/integration/fake-provider.ts:11` | `maestro/core/config/type-guards.ts` | T |
| `test/integration/hang-advisory.test.ts:7` | `pi-extension/subagents/index.ts` | T |
| `test/integration/hang-advisory.test.ts:8` | `maestro/adapters/pi/session.ts` | T |
| `test/integration/hang-advisory.test.ts:13` | `maestro/core/lifecycle.ts` | T |
| `test/integration/harness-conformance.test.ts:13` | `maestro/adapters/pi/pi-harness-adapter.ts` | T |
| `test/integration/harness-conformance.test.ts:17` | `maestro/adapters/pi/launch-operations.ts` | T |
| `test/integration/harness-conformance.test.ts:18` | `maestro/runtime/worktree-operations.ts` | T |
| `test/integration/harness-conformance.test.ts:19` | `maestro/core/harness-adapter.ts` | T |
| `test/integration/harness-conformance.test.ts:23` | `maestro/core/surface-provider.ts` | T |
| `test/integration/harness-conformance.test.ts:25` | `maestro/core/wake.ts` | T |
| `test/integration/harness-conformance.test.ts:26` | `maestro/core/supervision.ts` | T |
| `test/integration/harness-conformance.test.ts:27` | `maestro/adapters/pi/activity-file.ts` | T |
| `test/integration/harness-conformance.test.ts:28` | `test/integration/fake-provider.ts` | T |
| `test/integration/harness-conformance.test.ts:29` | `maestro/adapters/pi/session.ts` | T |
| `test/integration/harness-conformance.test.ts:33` | `test/maestro/harness-adapter.conformance.ts` | T |
| `test/integration/harness.ts:28` | `test/integration/fake-provider.ts` | T |
| `test/integration/harness.ts:29` | `maestro/core/config/type-guards.ts` | T |
| `test/integration/herdr-core-lab.ts:20` | `maestro/core/config/type-guards.ts` | T |
| `test/integration/herdr-core.test.ts:6` | `maestro/core/config/type-guards.ts` | T |
| `test/integration/herdr-lab.ts:25` | `maestro/adapters/pi/process-identity.ts` | T |
| `test/integration/herdr-lab.ts:26` | `maestro/core/config/type-guards.ts` | T |
| `test/integration/mux-surface.test.ts:38` | `maestro/core/config/pane-config.ts` | T |
| `test/integration/persistent-specialist.test.ts:24` | `test/integration/fake-provider.ts` | T |
| `test/integration/persistent-specialist.test.ts:25` | `maestro/core/config/type-guards.ts` | T |
| `test/integration/placement.test.ts:4` | `pi-extension/subagents/config-path.ts` | T |
| `test/integration/placement.test.ts:21` | `maestro/adapters/pi/launch.ts` | T |
| `test/integration/placement.test.ts:25` | `maestro/adapters/pi/launch-operations.ts` | T |
| `test/integration/placement.test.ts:29` | `maestro/runtime/worktree-operations.ts` | T |
| `test/integration/placement.test.ts:56` | `maestro/core/config/pane-config.ts` | T |
| `test/integration/placement.test.ts:57` | `pi-extension/subagents/index.ts` | T |
| `test/integration/placement.test.ts:58` | `maestro/core/config/type-guards.ts` | T |
| `test/integration/sidebar-fixture.ts:28` | `maestro/core/config/type-guards.ts` | T |
| `test/integration/sidebar-lifecycle.test.ts:62` | `maestro/runtime/delegated-marker.ts` | T |
| `test/integration/sidebar-lifecycle.test.ts:63` | `test/integration/fake-provider.ts` | T |
| `test/integration/sidebar-lifecycle.test.ts:64` | `maestro/core/config/type-guards.ts` | T |
| `test/integration/sidebar.test.ts:39` | `maestro/runtime/delegated-marker.ts` | T |
| `test/integration/sidebar.test.ts:40` | `maestro/adapters/pi/process-identity.ts` | T |
| `test/integration/sidebar.test.ts:46` | `maestro/core/config/type-guards.ts` | T |
| `test/integration/sidebar.test.ts:47` | `maestro/core/shell.ts` | T |
| `test/integration/subagent-cancel.test.ts:24` | `test/integration/fake-provider.ts` | T |
| `test/integration/subagent-lifecycle.test.ts:33` | `test/integration/fake-provider.ts` | T |
| `test/integration/supervision.test.ts:13` | `pi-extension/subagents/index.ts` | T |
| `test/integration/supervision.test.ts:14` | `pi-extension/subagents/presentation.ts` | T |
| `test/integration/supervision.test.ts:24` | `maestro/adapters/pi/completion.ts` | T |
| `test/integration/supervision.test.ts:29` | `maestro/core/supervision.ts` | T |
| `test/integration/supervision.test.ts:33` | `maestro/adapters/pi/session.ts` | T |
| `test/integration/surface-conformance.test.ts:12` | `maestro/core/surface-provider.ts` | T |
| `test/integration/surface-conformance.test.ts:14` | `test/maestro/surface-provider.conformance.ts` | T |
| `test/isolated-agent-dir.ts:1` | `test/clean-host-env.ts` | T |
| `test/launch.test.ts:1` | `test/clean-host-env.ts` | T |
| `test/launch.test.ts:24` | `maestro/adapters/pi/launch-operations.ts` | T |
| `test/launch.test.ts:31` | `maestro/adapters/pi/launch.ts` | T |
| `test/launch.test.ts:32` | `maestro/surfaces/herdr/herdr-cli.ts` | T |
| `test/launch.test.ts:33` | `maestro/surfaces/herdr/terminal.ts` | T |
| `test/launch.test.ts:34` | `maestro/runtime/worktree-operations.ts` | T |
| `test/launch.test.ts:35` | `maestro/core/config/pane-config.ts` | T |
| `test/launch.test.ts:36` | `maestro/surfaces/fake/fake-surface-provider.ts` | T |
| `test/launch.test.ts:37` | `maestro/core/surface-provider.ts` | T |
| `test/launch.test.ts:42` | `maestro/core/surface-provider.ts` | T |
| `test/launch.test.ts:47` | `maestro/adapters/pi/session.ts` | T |
| `test/maestro/accept-check.test.ts:1` | `test/isolated-agent-dir.ts` | T |
| `test/maestro/accept-check.test.ts:37` | `maestro/adapters/pi/child/subagent-done.ts` | T |
| `test/maestro/accept-check.test.ts:44` | `pi-extension/subagents/index.ts` | T |
| `test/maestro/accept-check.test.ts:45` | `test/helpers/mock-extension-api.ts` | T |
| `test/maestro/accept-recheck.test.ts:1` | `test/isolated-agent-dir.ts` | T |
| `test/maestro/accept-recheck.test.ts:35` | `test/helpers/windows-scope.ts` | T |
| `test/maestro/accept-shutdown.test.ts:1` | `test/isolated-agent-dir.ts` | T |
| `test/maestro/accept-shutdown.test.ts:15` | `maestro/adapters/pi/child/subagent-done.ts` | T |
| `test/maestro/accept-shutdown.test.ts:16` | `test/helpers/mock-extension-api.ts` | T |
| `test/maestro/async-io.test.ts:1` | `test/clean-host-env.ts` | T |
| `test/maestro/async-io.test.ts:4` | `maestro/surfaces/herdr/herdr.ts` | T |
| `test/maestro/async-io.test.ts:5` | `maestro/surfaces/herdr/herdr-surface-provider.ts` | T |
| `test/maestro/async-io.test.ts:6` | `maestro/adapters/fake/fake-harness-adapter.ts` | T |
| `test/maestro/async-io.test.ts:7` | `maestro/runtime/run-session.ts` | T |
| `test/maestro/async-io.test.ts:11` | `maestro/surfaces/herdr/herdr-pane.ts` | T |
| `test/maestro/async-io.test.ts:53` | `maestro/core/types.ts` | T |
| `test/maestro/audit-discovery.test.ts:1` | `test/clean-host-env.ts` | T |
| `test/maestro/audit-fork.test.ts:1` | `test/clean-host-env.ts` | T |
| `test/maestro/audit-git-environment.test.ts:1` | `test/clean-host-env.ts` | T |
| `test/maestro/audit-git-environment.test.ts:24` | `test/helpers/windows-scope.ts` | T |
| `test/maestro/audit-herdr-dispatch.test.ts:1` | `test/clean-host-env.ts` | T |
| `test/maestro/audit-herdr-dispatch.test.ts:4` | `maestro/core/surface-provider.ts` | T |
| `test/maestro/audit-ownership.test.ts:1` | `test/clean-host-env.ts` | T |
| `test/maestro/audit-ownership.test.ts:14` | `maestro/adapters/pi/pi-harness-adapter.ts` | T |
| `test/maestro/audit-ownership.test.ts:15` | `maestro/adapters/pi/launch-operations.ts` | T |
| `test/maestro/audit-ownership.test.ts:16` | `maestro/adapters/pi/completion.ts` | T |
| `test/maestro/audit-ownership.test.ts:20` | `maestro/runtime/worktree-operations.ts` | T |
| `test/maestro/audit-ownership.test.ts:26` | `maestro/adapters/pi/session.ts` | T |
| `test/maestro/audit-ownership.test.ts:27` | `maestro/core/harness-adapter.ts` | T |
| `test/maestro/audit-ownership.test.ts:28` | `maestro/core/supervision.ts` | T |
| `test/maestro/audit-ownership.test.ts:29` | `maestro/core/surface-provider.ts` | T |
| `test/maestro/audit-ownership.test.ts:30` | `maestro/surfaces/fake/fake-surface-provider.ts` | T |
| `test/maestro/audit-ownership.test.ts:31` | `maestro/surfaces/herdr/terminal.ts` | T |
| `test/maestro/audit-persistent.test.ts:1` | `test/isolated-agent-dir.ts` | T |
| `test/maestro/audit-persistent.test.ts:35` | `test/helpers/mock-extension-api.ts` | T |
| `test/maestro/audit-persistent.test.ts:475` | `pi-extension/subagents/index.ts` | T |
| `test/maestro/audit-reload.test.ts:1` | `test/isolated-agent-dir.ts` | T |
| `test/maestro/audit-reload.test.ts:11` | `maestro/runtime/pi-run-session.ts` | T |
| `test/maestro/audit-stop-notices.test.ts:1` | `test/clean-host-env.ts` | T |
| `test/maestro/audit-stop-notices.test.ts:25` | `test/helpers/mock-extension-api.ts` | T |
| `test/maestro/audit-uncertain-retry.test.ts:1` | `test/clean-host-env.ts` | T |
| `test/maestro/core-lab.test.ts:1` | `test/clean-host-env.ts` | T |
| `test/maestro/core-parent.test.ts:1` | `test/clean-host-env.ts` | T |
| `test/maestro/core-roles-config.test.ts:1` | `test/clean-host-env.ts` | T |
| `test/maestro/deadline.test.ts:1` | `test/clean-host-env.ts` | T |
| `test/maestro/declared-skills.test.ts:1` | `test/clean-host-env.ts` | T |
| `test/maestro/deferred-tools.test.ts:1` | `test/clean-host-env.ts` | T |
| `test/maestro/deferred-tools.test.ts:30` | `test/helpers/mock-extension-api.ts` | T |
| `test/maestro/deferred-tools.test.ts:43` | `pi-extension/subagents/index.ts` | T |
| `test/maestro/delegated-marker.test.ts:1` | `test/clean-host-env.ts` | T |
| `test/maestro/delegated-marker.test.ts:14` | `maestro/runtime/delegated-marker.ts` | T |
| `test/maestro/delegated-marker.test.ts:15` | `maestro/core/supervision.ts` | T |
| `test/maestro/delegated-marker.test.ts:19` | `maestro/surfaces/herdr/herdr-socket.ts` | T |
| `test/maestro/delegated-marker.test.ts:20` | `test/fake-herdr-socket.ts` | T |
| `test/maestro/delegation-depth.test.ts:1` | `test/clean-host-env.ts` | T |
| `test/maestro/dependency-rule.test.ts:1` | `test/clean-host-env.ts` | T |
| `test/maestro/fake-harness-adapter.test.ts:1` | `test/clean-host-env.ts` | T |
| `test/maestro/fake-harness-adapter.test.ts:8` | `test/maestro/harness-adapter.conformance.ts` | T |
| `test/maestro/fake-surface-provider.test.ts:1` | `test/clean-host-env.ts` | T |
| `test/maestro/fake-surface-provider.test.ts:11` | `test/maestro/surface-provider.conformance.ts` | T |
| `test/maestro/git-handoff-async.test.ts:1` | `test/clean-host-env.ts` | T |
| `test/maestro/git-handoff-async.test.ts:13` | `test/helpers/windows-scope.ts` | T |
| `test/maestro/harness-adapter.conformance.ts:6` | `maestro/core/harness-adapter.ts` | T |
| `test/maestro/harness-adapter.conformance.ts:11` | `maestro/core/types.ts` | T |
| `test/maestro/herdr-available.test.ts:1` | `test/clean-host-env.ts` | T |
| `test/maestro/herdr-cli.test.ts:1` | `test/clean-host-env.ts` | T |
| `test/maestro/herdr-cli.test.ts:13` | `test/helpers/process-cleanup.ts` | T |
| `test/maestro/herdr-core-execution.test.ts:1` | `test/isolated-agent-dir.ts` | T |
| `test/maestro/herdr-core-execution.test.ts:17` | `maestro/surfaces/herdr/herdr-core-surface-provider.ts` | T |
| `test/maestro/herdr-core-execution.test.ts:18` | `maestro/surfaces/herdr/herdr-core-protocol.ts` | T |
| `test/maestro/herdr-core-execution.test.ts:24` | `maestro/core/config/herdr-config.ts` | T |
| `test/maestro/herdr-core-execution.test.ts:28` | `maestro/core/surface-provider.ts` | T |
| `test/maestro/herdr-core-execution.test.ts:34` | `maestro/adapters/pi/launch.ts` | T |
| `test/maestro/herdr-core-execution.test.ts:35` | `maestro/adapters/pi/launch-operations.ts` | T |
| `test/maestro/herdr-core-execution.test.ts:36` | `maestro/adapters/pi/completion.ts` | T |
| `test/maestro/herdr-core-execution.test.ts:44` | `maestro/core/lifecycle.ts` | T |
| `test/maestro/herdr-core-execution.test.ts:50` | `maestro/adapters/pi/session.ts` | T |
| `test/maestro/herdr-core-execution.test.ts:51` | `maestro/runtime/pi-run-session.ts` | T |
| `test/maestro/herdr-core-execution.test.ts:57` | `maestro/runtime/pi-run-session-types.ts` | T |
| `test/maestro/herdr-core-execution.test.ts:58` | `maestro/core/wake.ts` | T |
| `test/maestro/herdr-core-execution.test.ts:59` | `maestro/core/supervision.ts` | T |
| `test/maestro/herdr-core-execution.test.ts:60` | `test/socket-path.ts` | T |
| `test/maestro/herdr-core-execution.test.ts:61` | `test/helpers/windows-scope.ts` | T |
| `test/maestro/herdr-lab.test.ts:8` | `test/clean-host-env.ts` | T |
| `test/maestro/herdr-placement-async.test.ts:1` | `test/clean-host-env.ts` | T |
| `test/maestro/herdr-placement-async.test.ts:11` | `maestro/core/surface-provider.ts` | T |
| `test/maestro/herdr-placement-async.test.ts:12` | `maestro/core/deadline.ts` | T |
| `test/maestro/herdr-placement-async.test.ts:14` | `maestro/core/config/type-guards.ts` | T |
| `test/maestro/herdr-socket.test.ts:1` | `test/clean-host-env.ts` | T |
| `test/maestro/herdr-socket.test.ts:10` | `maestro/core/config/type-guards.ts` | T |
| `test/maestro/herdr-surface-provider.test.ts:1` | `test/clean-host-env.ts` | T |
| `test/maestro/linux-integration-driver.test.ts:1` | `test/clean-host-env.ts` | T |
| `test/maestro/opened-primary-workspace.test.ts:1` | `test/clean-host-env.ts` | T |
| `test/maestro/opened-primary-workspace.test.ts:9` | `maestro/core/opened-primary-workspace.ts` | T |
| `test/maestro/opened-primary-workspace.test.ts:10` | `maestro/core/worktree-cleanup.ts` | T |
| `test/maestro/opened-primary-workspace.test.ts:11` | `maestro/surfaces/herdr/herdr-surface-provider.ts` | T |
| `test/maestro/opened-primary-workspace.test.ts:23` | `maestro/surfaces/herdr/herdr.ts` | T |
| `test/maestro/opened-primary-workspace.test.ts:24` | `test/worktree-cleanup-fixture.ts` | T |
| `test/maestro/pi-harness-adapter.test.ts:1` | `test/clean-host-env.ts` | T |
| `test/maestro/pi-harness-adapter.test.ts:15` | `test/helpers/process-cleanup.ts` | T |
| `test/maestro/pi-readiness-windows.test.ts:1` | `test/clean-host-env.ts` | T |
| `test/maestro/pi-run-session.test.ts:1` | `test/isolated-agent-dir.ts` | T |
| `test/maestro/pi-run-session.test.ts:19` | `test/socket-path.ts` | T |
| `test/maestro/pi-run-session.test.ts:23` | `maestro/runtime/worktree-operations.ts` | T |
| `test/maestro/pi-run-session.test.ts:24` | `maestro/runtime/index.ts` | T |
| `test/maestro/pi-run-session.test.ts:30` | `maestro/runtime/pi-run-session-types.ts` | T |
| `test/maestro/pi-run-session.test.ts:31` | `maestro/surfaces/fake/fake-surface-provider.ts` | T |
| `test/maestro/pi-run-session.test.ts:32` | `maestro/adapters/pi/launch-operations.ts` | T |
| `test/maestro/pi-run-session.test.ts:33` | `maestro/core/roles/discovery.ts` | T |
| `test/maestro/pi-run-session.test.ts:39` | `maestro/adapters/pi/session.ts` | T |
| `test/maestro/pi-run-session.test.ts:46` | `maestro/core/lifecycle.ts` | T |
| `test/maestro/pi-run-session.test.ts:47` | `maestro/adapters/pi/activity-file.ts` | T |
| `test/maestro/pi-run-session.test.ts:48` | `maestro/core/wake.ts` | T |
| `test/maestro/pi-run-session.test.ts:49` | `maestro/core/supervision.ts` | T |
| `test/maestro/pi-run-session.test.ts:53` | `maestro/core/surface-provider.ts` | T |
| `test/maestro/pi-run-session.test.ts:54` | `maestro/surfaces/herdr/terminal.ts` | T |
| `test/maestro/pi-run-session.test.ts:55` | `test/helpers/windows-scope.ts` | T |
| `test/maestro/pr110-persistent-regressions.test.ts:1` | `test/isolated-agent-dir.ts` | T |
| `test/maestro/pr110-persistent-regressions.test.ts:17` | `maestro/runtime/pi-run-session.ts` | T |
| `test/maestro/pr110-persistent-regressions.test.ts:43` | `test/helpers/mock-extension-api.ts` | T |
| `test/maestro/process-cleanup.test.ts:1` | `test/clean-host-env.ts` | T |
| `test/maestro/process-cleanup.test.ts:12` | `test/helpers/process-cleanup.ts` | T |
| `test/maestro/process-environment.test.ts:1` | `test/clean-host-env.ts` | T |
| `test/maestro/process-identity.test.ts:1` | `test/clean-host-env.ts` | T |
| `test/maestro/process-tree.test.ts:1` | `test/clean-host-env.ts` | T |
| `test/maestro/realpath-without-opening.test.ts:1` | `test/clean-host-env.ts` | T |
| `test/maestro/run-session-cancel.test.ts:1` | `test/clean-host-env.ts` | T |
| `test/maestro/run-session.test.ts:1` | `test/clean-host-env.ts` | T |
| `test/maestro/script-launch.test.ts:1` | `test/clean-host-env.ts` | T |
| `test/maestro/script-launch.test.ts:21` | `maestro/adapters/pi/script-shell.ts` | T |
| `test/maestro/script-launch.test.ts:28` | `maestro/core/script-launch.ts` | T |
| `test/maestro/script-launch.test.ts:32` | `maestro/runtime/pi-run-session.ts` | T |
| `test/maestro/script-launch.test.ts:33` | `maestro/adapters/pi/session.ts` | T |
| `test/maestro/script-launch.test.ts:34` | `maestro/runtime/index.ts` | T |
| `test/maestro/script-launch.test.ts:35` | `pi-extension/subagents/launch.ts` | T |
| `test/maestro/script-launch.test.ts:36` | `maestro/surfaces/herdr/herdr.ts` | T |
| `test/maestro/script-launch.test.ts:37` | `maestro/surfaces/herdr/herdr-surface-provider.ts` | T |
| `test/maestro/script-launch.test.ts:38` | `maestro/surfaces/herdr/terminal.ts` | T |
| `test/maestro/sidebar-fixture-ownership.test.ts:7` | `test/clean-host-env.ts` | T |
| `test/maestro/sidebar-fixture-ownership.test.ts:44` | `maestro/core/config/type-guards.ts` | T |
| `test/maestro/socket-path.test.ts:1` | `test/clean-host-env.ts` | T |
| `test/maestro/socket-path.test.ts:9` | `test/socket-path.ts` | T |
| `test/maestro/specialist-notice.test.ts:1` | `test/isolated-agent-dir.ts` | T |
| `test/maestro/specialist-notice.test.ts:21` | `maestro/adapters/pi/child/subagent-done.ts` | T |
| `test/maestro/specialist-notice.test.ts:32` | `pi-extension/subagents/index.ts` | T |
| `test/maestro/specialist-notice.test.ts:33` | `test/helpers/mock-extension-api.ts` | T |
| `test/maestro/supervision-wake.test.ts:1` | `test/clean-host-env.ts` | T |
| `test/maestro/surface-provider.conformance.ts:3` | `maestro/core/surface-provider.ts` | T |
| `test/maestro/task-model-approval.test.ts:1` | `test/isolated-agent-dir.ts` | T |
| `test/maestro/task-model-approval.test.ts:22` | `pi-extension/subagents/index.ts` | T |
| `test/maestro/task-model-approval.test.ts:33` | `test/helpers/mock-extension-api.ts` | T |
| `test/maestro/task-model-init.test.ts:1` | `test/clean-host-env.ts` | T |
| `test/maestro/task-thinking-wiring.test.ts:1` | `test/clean-host-env.ts` | T |
| `test/maestro/task-thinking-wiring.test.ts:9` | `test/helpers/mock-extension-api.ts` | T |
| `test/maestro/task-thinking.test.ts:1` | `test/clean-host-env.ts` | T |
| `test/maestro/test-environment.test.ts:1` | `test/clean-host-env.ts` | T |
| `test/maestro/tool-schema.test.ts:1` | `test/clean-host-env.ts` | T |
| `test/maestro/tool-schema.test.ts:5` | `test/helpers/tool-schema-capture.ts` | T |
| `test/maestro/tool-schema.test.ts:10` | `test/helpers/tool-schema-capture.ts` | T |
| `test/maestro/tool-schema.test.ts:11` | `scripts/tool-docs.ts` | T |
| `test/maestro/tool-schema.test.ts:12` | `test/helpers/tool-schema-compat.ts` | T |
| `test/maestro/windows-support-scope.test.ts:1` | `test/clean-host-env.ts` | T |
| `test/maestro/windows-support-scope.test.ts:2` | `test/isolated-agent-dir.ts` | T |
| `test/maestro/windows-support-scope.test.ts:14` | `pi-extension/subagents/index.ts` | T |
| `test/maestro/windows-support-scope.test.ts:19` | `pi-extension/subagents/state.ts` | T |
| `test/maestro/windows-support-scope.test.ts:25` | `maestro/core/platform-support.ts` | T |
| `test/maestro/windows-support-scope.test.ts:26` | `maestro/core/config/herdr-config.ts` | T |
| `test/maestro/windows-support-scope.test.ts:27` | `maestro/core/worktree.ts` | T |
| `test/maestro/windows-support-scope.test.ts:28` | `maestro/runtime/index.ts` | T |
| `test/maestro/windows-support-scope.test.ts:29` | `maestro/surfaces/fake/fake-surface-provider.ts` | T |
| `test/maestro/windows-support-scope.test.ts:30` | `maestro/adapters/pi/launch-operations.ts` | T |
| `test/maestro/windows-support-scope.test.ts:31` | `maestro/core/supervision.ts` | T |
| `test/maestro/windows-support-scope.test.ts:32` | `test/helpers/mock-extension-api.ts` | T |
| `test/maestro/windows-support-scope.test.ts:33` | `maestro/runtime/pi-run-session.ts` | T |
| `test/maestro/windows-support-scope.test.ts:34` | `maestro/core/types.ts` | T |
| `test/maestro/worktree-operations.test.ts:1` | `test/clean-host-env.ts` | T |
| `test/maestro/worktree-operations.test.ts:21` | `test/worktree-cleanup-fixture.ts` | T |
| `test/package-manifest.test.js:1` | `test/clean-host-env.ts` | T |
| `test/release-workflow.test.ts:1` | `test/clean-host-env.ts` | T |
| `test/runtime-routing.test.ts:1` | `test/clean-host-env.ts` | T |
| `test/sidebar-plugin.test.js:1` | `test/clean-host-env.ts` | T |
| `test/sidebar-plugin.test.js:26` | `maestro/runtime/delegated-marker.ts` | T |
| `test/system-prompt-mode.test.ts:5` | `test/clean-host-env.ts` | T |
| `test/test.ts:1` | `test/clean-host-env.ts` | T |
| `test/test.ts:7` | `maestro/runtime/worktree-operations.ts` | T |
| `test/test.ts:12` | `maestro/core/host-text.ts` | T |
| `test/test.ts:13` | `pi-extension/subagents/widgets.ts` | T |
| `test/test.ts:17` | `pi-extension/subagents/worktree-tools.ts` | T |
| `test/test.ts:27` | `pi-extension/subagents/presentation.ts` | T |
| `test/test.ts:28` | `maestro/adapters/pi/launch-command.ts` | T |
| `test/test.ts:29` | `test/isolated-agent-dir.ts` | T |
| `test/test.ts:30` | `test/helpers/mock-extension-api.ts` | T |
| `test/test.ts:34` | `test/helpers/windows-scope.ts` | T |
| `test/test.ts:38` | `pi-extension/subagents/tool-boundary.ts` | T |
| `test/test.ts:40` | `test/worktree-cleanup-fixture.ts` | T |
| `test/test.ts:59` | `pi-extension/subagents/config-path.ts` | T |
| `test/test.ts:72` | `pi-extension/subagents/index.ts` | T |
| `test/test.ts:77` | `maestro/core/config/type-guards.ts` | T |
| `test/test.ts:78` | `examples/role-pack/extension.ts` | T |
| `test/test.ts:84` | `pi-extension/subagents/index.ts` | T |
| `test/test.ts:109` | `maestro/adapters/pi/session.ts` | T |
| `test/test.ts:111` | `maestro/surfaces/herdr/herdr-cli.ts` | T |
| `test/test.ts:112` | `maestro/surfaces/herdr/herdr-pane.ts` | T |
| `test/test.ts:113` | `maestro/surfaces/herdr/herdr.ts` | T |
| `test/test.ts:123` | `maestro/core/config/model-config.ts` | T |
| `test/test.ts:127` | `maestro/core/config/task-model-init.ts` | T |
| `test/test.ts:131` | `maestro/core/config/role-config.ts` | T |
| `test/test.ts:136` | `maestro/core/config/pane-config.ts` | T |
| `test/test.ts:140` | `maestro/core/config/persistent-config.ts` | T |
| `test/test.ts:144` | `maestro/core/config/supervision-config.ts` | T |
| `test/test.ts:148` | `maestro/core/config/guidelines-config.ts` | T |
| `test/test.ts:149` | `maestro/core/wake.ts` | T |
| `test/test.ts:153` | `maestro/core/supervision.ts` | T |
| `test/test.ts:166` | `maestro/core/status.ts` | T |
| `test/test.ts:171` | `maestro/adapters/pi/activity-file.ts` | T |
| `test/test.ts:172` | `maestro/core/types.ts` | T |
| `test/test.ts:173` | `maestro/core/config/task-model-types.ts` | T |
| `test/test.ts:174` | `maestro/core/worktree.ts` | T |
| `test/test.ts:175` | `pi-extension/subagents/state.ts` | T |
| `test/test.ts:180` | `pi-extension/subagents/observation.ts` | T |
| `test/test.ts:181` | `maestro/core/activity.ts` | T |
| `test/test.ts:189` | `maestro/adapters/pi/child/subagent-done.ts` | T |
| `test/test.ts:190` | `maestro/core/undelivered-children.ts` | T |
| `test/test.ts:195` | `maestro/adapters/pi/child/done-nudge.ts` | T |
| `test/test.ts:200` | `maestro/core/child-busy.ts` | T |
| `test/test.ts:204` | `maestro/adapters/pi/completion.ts` | T |
| `test/test.ts:218` | `maestro/core/lifecycle.ts` | T |
| `test/test.ts:219` | `maestro/adapters/pi/launch.ts` | T |
| `test/test.ts:220` | `maestro/adapters/pi/launch-operations.ts` | T |
| `test/test.ts:221` | `maestro/surfaces/herdr/herdr-surface-provider.ts` | T |
| `test/test.ts:227` | `maestro/runtime/index.ts` | T |
| `test/test.ts:231` | `maestro/core/routing.ts` | T |
| `test/test.ts:232` | `maestro/adapters/pi/model-registry.ts` | T |
| `test/test.ts:233` | `maestro/surfaces/fake/fake-surface-provider.ts` | T |
| `test/test.ts:234` | `maestro/core/surface-provider.ts` | T |
| `test/verify-lab-guards.test.ts:1` | `test/clean-host-env.ts` | T |
| `test/worktree-cleanup-fixture.ts:5` | `maestro/core/worktree-cleanup.ts` | T |
| `test/worktree-cleanup.test.ts:1` | `test/clean-host-env.ts` | T |
| `test/worktree-cleanup.test.ts:21` | `maestro/runtime/worktree-operations.ts` | T |
| `test/worktree-cleanup.test.ts:22` | `maestro/surfaces/herdr/herdr.ts` | T |
| `test/worktree-cleanup.test.ts:28` | `maestro/core/worktree-cleanup.ts` | T |
| `test/worktree-cleanup.test.ts:32` | `maestro/runtime/worktree-operations.ts` | T |
| `test/worktree-cleanup.test.ts:33` | `maestro/surfaces/herdr/herdr-surface-provider.ts` | T |
| `test/worktree-cleanup.test.ts:41` | `test/worktree-cleanup-fixture.ts` | T |
| `test/worktree-cleanup.test.ts:42` | `test/helpers/windows-scope.ts` | T |

### D3. Non-static resource edges and experimental import boundary

- Main `package.json` Pi metadata loads `pi-extension/subagents/index.ts`; the terminal host keeps that wrapper. This is metadata, not a TS import.
- Main `test/helpers/tool-schema-capture.ts:69–94` loads the extension/child by constructed URL. Parameterize source/packed entry loading; preserve fresh-load semantics. Main `launch.ts:833`, `launch-resume.ts:156` and `config-path.ts:6,20–25` are the package-relative resource edges addressed by H4.
- A0 `worker-backend.ts:10` imports `maestro/runtime/index.ts`, and `:11` imports `./model-registry.ts`: retarget to the explicit experimental facade and moved Pi model registry. A0 `pi-worker-session.ts:9` and `worker-client.ts:7` import `core/worker-execution.ts`; all three move together, so they are not reverse dependencies on the terminal host.
- A0 `worker-backend.test.ts:3–4` imports both concrete Herdr providers: retain that trap case upstream; its worker test moves. The A0 fixture imports the moved runtime/seam; worker-crash test loads the fixture through a constructed URL (`:16`). Keep a source and emitted-fixture path test.
- Main sidebar implementation has only Node built-in imports and no engine import; the cut is its marker wire protocol, not a hidden package dependency. Keep it independently installable.

The complete computed-import review below supplements the literal AST table;
query suffixes deliberately force fresh entry modules. Preserve their tested
reload semantics through factory calls, rather than relying on the package's
cached transitive modules to reevaluate.

| Import call at main | Constructed target | Treatment |
| --- | --- | --- |
| `.pi/skills/verify-pi-herdr-agents/scripts/pin.ts:21` | `test/helpers/mock-extension-api.ts` | Shared test fixture stays accessible to host pinning. |
| `.pi/skills/verify-pi-herdr-agents/scripts/pin.ts:33` | `pi-extension/subagents/index.ts` | Pin actual retained wrapper, then compare its registrations with package factory. |
| `test/helpers/tool-schema-capture.ts:69` | `pi-extension/subagents/index.ts` and `maestro/adapters/pi/child/subagent-done.ts` (call sites :90,92) | Parameterize real source/packed entry loader. |
| `test/maestro/herdr-placement-async.test.ts:106,126` | `maestro/surfaces/herdr/herdr.ts` | Stay-to-stay reload probes, retained unchanged except any host-local path rename. |
| `test/maestro/task-thinking-wiring.test.ts:83` | `pi-extension/subagents/index.ts` | Move factory/config refresh test; retain wrapper parity smoke. |
| `test/test.ts:1450,1579,1685,1787,1861,4766` | `pi-extension/subagents/index.ts` | Split actual reload-gap/held-delivery/config scenarios with their new owners; test cached-package/fresh-wrapper behavior. |

**Audit totals:** 98 main production files, 110 test-tree files, 42 additional support files; 486 conservative literal cross-cut import occurrences at main, plus all 12 computed import calls reviewed above. Split-to-split edges are intentional review items, not a proposed bidirectional dependency graph.
