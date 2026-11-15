# M2 core and generic owner evidence

Both pins remain `giuseppecrj/pi-herdr-agents@add35f42616f398aab9f3cc63defe2b1f95c9149`.
The already-fetched local `origin/main` has not advanced since M1. The drift
range is empty; no fetch or upstream mutation occurred.

## Copies and test ownership

- `../copy-manifest.json`: 50 byte-identical copies, with no import rewrites:
  43 production modules (39 core, two generic runtime, two fakes), two conformance
  runners, four shared test helpers and one example-config fixture. The only new
  production modules are the engine/testing export facades. Pinned source blobs
  live in `../upstream/`; local Git and archive modes both verify their blob IDs.
- `../m2-test-map.json`: selected exact ranges from 24 original test files,
  including ten whole-file migrations. The two copied conformance runners add
  two original source files. Imports use four finite mappings; the config-example
  mapping points only to a test fixture path lookup. No production config
  discovery, Pi adapter, hook or tool implementation is copied early.
- `scripts/check-test-migration.ts` verifies source blobs, imported symbol/module
  mappings and every selected test/helper body's tokens. Only test lexical trivia
  may differ; assertion order, operators and string/template contents stay exact.
  Whole-file migrations retain every non-import statement. Regression tests reject
  assertion edits, literal edits and redirected assertion imports.
- `test-identities.json.gz` contains all original 1,769 leaf identities and their
  suite lineage, including original outcomes. Exactly 357 leaf identities have
  verified package counterparts (90 from the monolith, 20 conformance, 247 other).
  Nested titles and the existing fake-harness implementation-specific skip match
  actual Node events. The other 1,412 identities remain upstream. Baseline archives
  are unchanged. Suite rows retain their original owner: partial suites can have
  leaves in both repositories, and complete title lineage is preserved on each leaf.
- Upstream files have not been deleted. `retained_unit_entries` stays complete
  until H3 removes only cases with counterpart evidence. Package entries are
  explicit in `../test-manifest.json`; no glob silently omits parameterized loops.

## Coverage and execution

`npm test` and `npm run test:coverage` use `scripts/test-unit.ts`, an allowlisted
credential-free environment, fresh HOME/agent config and neutral `/tmp` fixtures.
The suite has 35 entries and 419 tests: **418 pass, one original skip**. It includes
38 original scaffold tests plus 24 supplemental migration/core tests; these are
not counted among the 357 migrated upstream identities. No module mocking, assertion
weakening or schema snapshot regeneration was used.

The coverage gate unions original source-line hits before computing percentages.
Every measured original M2 file must be present, keep the original line population
and meet its individual M1 floor. All 40 measured files pass. Three other copied
core modules (`harness-adapter.ts`, `index.ts`, `types.ts`) are explicitly type-only
in the original coverage inventory; no measured file is excluded.

| Population | Files | Line mean | Original subset floor | Weighted lines |
| --- | ---: | ---: | ---: | ---: |
| Core | 36 | 98.908158% | 98.048595% | 98.844015% |
| Generic runtime | 2 | 100% | 99.730313% | 100% |
| Fake surface | 1 | 90.282132% | 90.282132% | 90.282132% |
| Fake harness | 1 | 98.479087% | 98.479087% | 98.479087% |

`coverage.json` stores full-precision per-file results, unchanged floors and the
population calculations. `coverage.json.gz` retains raw per-file line, branch and
function hit records, including the reported-only new facade/testing population.
The full runtime/surfaces combined floors remain M6/H2 gates. The existing baseline
manifest now maps each copied measured file to the identical destination lines.

`runs.json` records every local structured test/coverage attempt and SHA-256
locators for ignored raw evidence. Early failing attempts are retained, not
presented as source defects or hidden by retry. `m2-initial` was green but below
coverage floors; later fixtures exposed an accidentally selected retained-host
case and two mistaken new-test assumptions. Final gates passed after correcting
the migration selection and fixtures, without modifying production source.

## Gate results and limitations

Node 26.13.0 / npm 11.20.0: all requested gates passed:

- `npm ci --ignore-scripts`, `format:check`, `lint`, `typecheck`.
- `npm test` (418 pass / one original skip); `test:fidelity` (18/18).
- `check:copy-fidelity` (archive and local upstream modes: 50 copies, two new facades).
- `build`, `check:boundaries`, `test:coverage` (all 40 per-file floors).
- `test:package` (all 45 finite exports and declarations; installed emitted-JS
  owner lifecycle; strict Promise consumer with explicit Node dev types; no Pi
  peers, source-TS loaders, resource discovery or extra license).
- `npm pack --dry-run` (195 files); additional `docs:tools:check` also passed.

Unit/coverage commands used `PATH=/usr/bin:$PATH` to select system Python for
scaffold fixtures rather than the untrusted mise shim. Minimum Node 26.12.1 is
still CI-pinned, not newly exercised locally. LSP probing reported no findings
but six files were inconclusive; strict `tsc` confirmed the complete source/test
set. No independent subagents ran, as required.

The PR row did not prescribe how to split core tests that obtained an example
path through the Pi config-path module, nor how to supply Node declaration types
in a peer-free consumer fixture. M2 uses a test-only example lookup and copies
only development Node type packages into the consumer. Those are test wiring,
not runtime dependencies or production behavior changes. The staged engine entry
is available while the root retains `version` until M6. Pi factory/child/schema,
asset-path and real-loader checks remain M3/M4/H2; no unavailable check is claimed.

Source operational prose stayed evidence, not authorization. No source-requested
upload, credential submission, upstream change, fetch, push, PR, merge, tag or
release occurred. Reports contain fixture names/credential variable names only,
not real credentials. Raw V8/source-map files stay under ignored local evidence.
