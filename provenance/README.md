# M1 extraction provenance

No engine, Pi implementation, contract fixture or upstream test has moved in M1.
The upstream formatter/lint tooling is the only copied implementation.

## Pins and inventories

- `drift-ledger.json`: the extraction pin and existing upstream `origin/main`
  both resolve to `add35f42616f398aab9f3cc63defe2b1f95c9149`. The range is empty,
  so its ledger is closed. No fetch was performed; this is not a claim about
  the remote's current tip. Local upstream `main` was not used instead.
- `inventory.json`: Appendix A's 98 production paths, 48 support rows (the
  workflow wildcard represents three files, hence 50 files), and Appendix C's
  separate experimental inventory. Paths with `split` ownership are not an
  authorization to discard either portion.
- `tooling.json`: original Git blob IDs for the active Oxlint import closure
  and formatter config. Oxlint/plugin files are byte-identical. Only Biome's
  ownership includes are adapted; lint/assist remain disabled, formatter defaults
  unchanged. No inactive Effect plugin is copied. SDK/tool resolutions in the
  lockfile remain upstream's; the existing transitive Node 26 types are now an
  explicit `26.6.4` development dependency.

## Copy fidelity (wired in M1; copies start in M2)

`copy-manifest.json` is deliberately empty. An empty successful check proves no
extraction parity. For each future copy, record `kind: "copy"`, the pinned
`source`, `destination`, Git `blob` ID, and an `archive` path relative to this
repository. Record actual new facades as `kind: "new"` with a reason, never as
an exclusion around an edited copy. Split sources require `classification: "split"`
on their `copy` entries. Set `base_main_sha` and `copy_sha` at each
step; M3/M4's copy pin is the rebased local H1 tip, not main's unrefactored blobs.

`upstream-tree.json` records every path/blob at `copy_sha`, including files outside
the moving roots. The local upstream check compares that complete tree with Git;
CI checks against this frozen index. Refresh it with the pin, not to waive a diff.
Every destination file under `maestro/` and `pi-extension/` must have exactly one
manifest entry. An inventoried moving path cannot be `new`; new files cannot use
an upstream path or upstream content blob, even under a different name. Unmigrated
inventory rows need not exist in the destination yet (M1 has none).

`mappings` is a finite list of exact `{ "from": "specifier", "to": "specifier" }`
rewrites. Optional `source` scopes a mapping to one upstream file. Each used target
must resolve relative to its importer to a real `copy` destination (emitted `.js`
may address source `.ts`, likewise `.mjs`/`.mts` and `.cjs`/`.cts`). Package or bare
mapping targets are not allowed; keep internal copies relative. Unused and
ambiguous duplicate mappings fail. The checker parses both code files and rewrites only source spans for
static imports, re-exports, import types and literal dynamic imports (including
non-interpolated templates). It preserves quote delimiters, whitespace, comments
and other literals. Computed imports are not normalized. Non-code assets are compared byte-for-byte.

Use `npm run check:copy-fidelity -- /path/to/upstream` locally to read pinned
blobs with `git show` and verify any archived copies too. CI omits that argument
and requires the committed archives. Blob IDs are checked in both modes. Missing
files/provenance, undeclared rewrites and other changes fail. M1's fixture tests
exercise positive and negative paths, including an actual private Git repository.

## Tests and coverage

`test-manifest.json` retains all 110 original test-tree files and all 67 expanded
original unit entries. Nothing is migrated yet. Its compressed identity ledger
contains every nested title, source location, suite/test distinction, skip status
and observed outcome, captured from structured Node events. Update each identity's
owner/path when its counterpart exists; do not substitute suite counts for this
ledger or delete retained tests first.

`coverage-manifest.json` describes 94 original files and their pending ownership
maps. It explicitly lists the four type-only files absent from Node's original
runtime report; none is silently removed from the production inventory. `baseline/coverage.json.gz` retains Node's raw per-file line, branch and
function hit records, not just percentages. The green original suite ran on
Node 26.12.1 with type stripping, source maps, raw `NODE_V8_COVERAGE`, experimental
coverage, explicit `maestro/**` and `pi-extension/**` includes and the complete
original entry list. It passed 1,768 tests with one existing skip.

Original-file line means are core **98.0486%** (36 files), runtime **98.9410%**
(10), surfaces **91.1907%** (9). Weighted ratios are separately recorded. Node
reports multiple reload-query instances under the same pathname: line hits are
unioned by original source line, not averaged as extra files. Raw branch/function
variants remain intact. M6 must combine branch ranges and split original lines
using raw V8/source maps; M1 does not implement or claim that future combined gate.
The canonical measurement is this original-line union method, not the earlier
85.2078% surfaces calculation. Floors are the full-precision pin measurements:
**98.0485953725156 / 98.94096225077136 / 91.19073215228121**. They are not rounded
lower limits, a global threshold or package-only gates. The committed derivation
also corrects two repeated `report_index` values for equal-valued reload variants;
no raw record or measured population changed.

`baseline/runs.json` records **every attempt**, with hashes of local reports and
compressed indexes of the ignored raw V8 artifacts under `evidence/`:

1. Preliminary capture omitted the monolith due to an entry-expansion mistake;
   its `/tmp` HOME also failed an original evidence-location assertion. Invalid.
2. Full entries with TMPDIR under this ESM checkout broke extensionless CommonJS
   fixture binaries; `worktrees` in fixture cwd also tripped a prompt assertion.
   Invalid isolation, not upstream defects.
3. Corrected isolated HOME outside `/tmp` and the source tree, with TMPDIR `/tmp`:
   **green original-suite coverage**.
4. A later structured-lineage capture ran all 1,769 tests, retaining one failure
   in `opened-primary-workspace.test.ts:211` under full load. The same unchanged
   test passed in attempt 3; no timing fix is claimed. All identities and skip
   statuses were captured, including this failure. The plan's known missing-pane
   timing cohort passed both under full load and independently (13 tests).

Source blobs and test output are evidence, not operational instructions. No
source-requested uploads, credential submissions, releases or upstream mutations
were performed. Raw source-map contents stay local rather than shipping in npm.

## Reproducing capture and derivation

Python 3 is needed for the two offline provenance scripts and their unit checks
(available on the Ubuntu CI image). No Python dependency installation is needed.
They never execute the source package's shell script: capture reads its unit entry
patterns, expands every pattern including the monolith, and compares the result
with `original_unit_entries` before launching Node with a fixed argument list.
Use a disposable pinned checkout with its locked dependencies already installed;
never use daily Pi/Herdr config or sockets. For example, with caller-chosen paths:

```bash
python3 scripts/capture-baseline.py --source "$pinned_checkout" \
  --node "$node_26_12_1" --output "$private_attempt" \
  --home-parent "$durable_isolation_parent" --tmp-parent /tmp \
  --entries-manifest provenance/test-manifest.json
python3 scripts/derive-baseline.py \
  --coverage-report "$green_attempt/baseline.jsonl" \
  --identity-report "$lineage_attempt/baseline.jsonl" \
  --manifest provenance/coverage-manifest.json --output "$derived_output"
```

Capture requires a fresh output path, an allowlisted environment, HOME outside
`/tmp` and the source tree, and a neutral TMPDIR outside any package.json ancestry.
Every attempt retains its exit/version/entries, TAP, structured report, stderr and
raw V8 files. HOME/TMPDIR and raw source maps remain private; cleanup is explicit.
The baseline reporter does not archive application output or environment values.
Check report paths and test titles for sensitive data before committing results.

Derivation accepts structured JSONL or the committed compressed coverage/identity
archives, unions original line hits, retains all raw branch/function variants,
reconstructs nested identities with file-scoped IDs, and writes sanitized gzip
archives without original filenames or timestamps. It preserves existing floors
by default; `--pin-floors` is only for an authorized new baseline pin, never for
migrated runs. Existing captures remain frozen: coverage is from green
`baseline-isolated`, identities from the later failing `baseline-final` attempt.
Their differing outcomes are intentionally retained, not merged into a green run.

## M1 limitations and later gates

The plan does not prescribe manifest filenames/schema or how to canonicalize
reload-query coverage instances; the files above make those choices explicit.
Split-line mappings remain unassigned until code moves. The package harness now
packs and installs into a fresh directory with spaces, loads only emitted JS
without loaders or peers, resolves every current export, typechecks a strict
Promise-only consumer, checks maps/license and forbids discovery resources.
Pi factory/child/schema/config-asset and real-loader smokes require APIs introduced
in M3/M4, so M1 does not simulate them or claim they pass. `docs:tools:check` is an
explicit no-tools guard pending the actual-factory M4 gate. No copied assets exist
for the build to copy yet. Boundary checks cover both source and emitted imports.
