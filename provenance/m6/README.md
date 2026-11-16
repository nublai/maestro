# M6 stable installed-consumer parity evidence

Source repository `giuseppecrj/pi-herdr-agents`. `base_main_sha` stays
`4cae65fbc5f9d71c2b29bf76d94247f5c1e653d5`: local `origin/main` and a read-only
`git ls-remote origin refs/heads/main` both resolved to it at the start of M6.
Nothing was fetched into or pushed to the upstream.

`copy_sha` moves to `fd9c5d567430f72660e8505eb132c2a64709bfed`. That is one
new local commit on `h1/composition-hooks`. It exports the three interfaces
that `createPiExtension`'s inferred return type names, and it is type-only.
H1's own gates passed on that tree: format, docs, lint, typecheck,
`npm test` (1,779/1,780, 1 skip) and `npm pack --dry-run`.

`scripts/refresh-copies.ts` recopied `controls.ts` and `persistent.ts`.
`scripts/build.ts` no longer overlays declarations.

## Exports

The final map has 95 finite exports, with nothing experimental.

- `.` equals `./engine`. The placeholder `index.js`/`version` is gone.
- `./pi/child` is now a facade, `maestro/pi/child.ts`. Its default is the
  protocol child, the same instance the emitted launch entry loads. It also
  exports `createChildExtension` and `ChildPresentationHook`.
- `./pi/extension` is `maestro/pi/extension.ts`: `createPiExtension` as both
  the named and the default export, plus the host option types.
- `./pi/subagents/index` is `maestro/pi/subagents-index.ts`. It carries the
  upstream terminal entry's six helpers, and its default is
  `createPiExtension`. It has no instance and no `__test__`.
- Four new internal-compat paths cover the child protocol modules the retained
  host imports: `./adapters/pi/child/{protocol,accept-check,declared-skills,done-nudge}`.

None of the three facades sits at an upstream path. Each re-exports copies
only.

The build writes `dist/provenance.json` with the source repository,
`base_main_sha` and `copy_sha`. H2's `check:maestro-pin` refuses a candidate
whose pin differs from its own main base or H1 tip. A negative check against
`27dee40` failed as intended.

## Counterparts (M4 review "Major")

Four cases stayed upstream because they also assert terminal output.
`test/pi-contract-counterparts.test.ts` guards their public-contract parts
through the real factory. `counterparts.json` records what each case keeps
and what must stay upstream, and `test/scaffold.test.ts` checks that file.

Each counterpart failed under a targeted mutation of the copied source:

- dropping `details.repeated`;
- not projecting `unconfirmed` onto a transferred owner;
- an unquoted Resume path;
- a raw status label.

## Local H2 (`h2/consume-maestro`, from H1 `fd9c5d5`; never pushed)

- **Dependency.** The exact candidate tarball is installed as a `file:`
  dependency (`vendor/nubl-maestro-0.1.0.tgz`, sha256
  `326553172ca063ec2407f2e458592f784419acc4b6fa16ba766f611a71f90f6b`).
  It equals `npm pack` of this branch.
- **Import redirects.** `scripts/redirect-host-imports.ts` rewrote 380 imports
  in 97 retained modules, tests and lab scripts to 80 package subpaths. It
  fails on a moved target with no export and on query-suffixed imports; there
  were none. Six constructed module URLs in child-process fixtures were
  redirected by hand to `import.meta.resolve("@nubl/maestro/...")`.
- **Wrapper.** `index.ts` imports `createPiExtension` from `@nubl/maestro/pi`
  and the helpers from `@nubl/maestro/pi/subagents/index`. `child.ts` imports
  `createChildExtension` from `@nubl/maestro/pi/child`.
- **Unchanged paths.** The legacy `subagent-done.ts` forwarder (now re-exporting
  the package protocol), `childEntryPath` and `configAssetRoot` are unchanged.
- **Retained tests that encode layout.** Two kinds were adapted:
  - The dependency rule maps `@nubl/maestro/*` specifiers to their original
    layers.
  - The composition-hook child tests observe the installed emitted child entry.
- **One engine.** The local moved copies stay until the reviewed switch. No
  unit test or subprocess loaded any of them: the raw V8 coverage of the whole
  upstream suite contains none, and the combined gate asserts this.

Upstream gates (logs and hashes in `runs.json`):

| Gate | Result |
| --- | --- |
| `format:check`, `docs:tools:check`, `lint`, `typecheck`, `check:maestro-pin`, `npm pack --dry-run` | pass |
| `npm test` | 1,779/1,780, 1 skip (attempt 2). Attempt 1 hit the known `opened-primary-workspace.test.ts:211` budget flake under load (also seen in M1); it passed 5/5 alone. Both attempts are retained. |
| Real Pi `/reload` loader, pin and presentation probes (`composition-hooks.test.ts`) | pass, through the wrapper and the installed package |
| `npm run test:integration` in the isolated lab | 107 tests: 96 pass, 0 fail, 11 skip (Core) |
| `npm run test:integration:core` | 11/11 skip: no `herdr-core` binary here |

The integration suites need the lab environment that
`scripts/run-linux-integration.ts` sets up: `HERDR_ENV=1` and the lab
socket, workspace and pane. That driver also requires `HERDR_CORE_BIN`. It
ran here with only that requirement removed (a two-line local edit, not
committed). It started the lab, ran its real-parent delegation smoke and every
`test/integration` suite against the lab Herdr, and the lab shut down with no
leftovers. Running the suites without the lab, as a plain `npm run
test:integration`, is invalid and is retained as such.

## Combined coverage

Run `scripts/combined-coverage.ts` with:

- the M1 raw baseline (`baseline-isolated`);
- the package cohort (`npm run test:coverage`);
- the host cohort (`evidence/m6-h2/host-cov.sh`).

Both new cohorts ran on Node 26.12.1.

**Method.** The script reads raw V8, not Node's merged summary. On a pristine
H1 tree, the merged summary reports `herdr-cli.ts` at 27% against M1's 92%,
on both 26.12.1 and 26.13.1, so it is not comparable here. Line hits are
unioned per process, and installed `dist` JS is mapped back to package sources
through the shipped source maps. Original lines map through `split_line_map`,
plus an indentation-insensitive diff onto the retained host files that own the
rest (`host-surface`, `marker-transport`, `tool-renderers`, `child-widget`,
`index`, `widgets`, Herdr). Floors use the same algorithm on the M1 raw files.
With it, surfaces reproduces the pinned mean exactly; core and runtime come
out below their pinned means. The gate requires both the same-method baseline
and the pinned floor.

**Result.** All 94 original files meet their floors (`combined-coverage.json`):

| Population | Files | Combined mean | Same-method baseline | Pinned floor | Weighted |
| --- | ---: | ---: | ---: | ---: | ---: |
| Core | 36 | 98.744412% | 96.553910% | 98.048595% | 98.829382% |
| Runtime | 10 | 99.353166% | 98.668819% | 98.940962% | 99.195171% |
| Surfaces | 9 | 92.901547% | 91.190732% | 91.190732% | 92.939780% |
| Adapters/tools (reported) | 39 | 96.691080% | 95.493212% | — | 95.921496% |

**Sensitivity.** With the host cohort empty, the gate reports 80 failures.
With only the host cohort, it fails too: comment and type lines have no JS
mapping.

Not claimed:

- Core-lab suites (no `herdr-core` here) and the CI integration lane;
- the minimum-Node CI lane, beyond these Node 26.12.1 coverage runs;
- a registry tarball, because nothing was published.
