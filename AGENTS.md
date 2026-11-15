# Working on @nubl/maestro

## Current stage

This repository is a public `0.0.1` placeholder. Before extraction work, read
[`docs/plan/extraction.md`](docs/plan/extraction.md): it pins the source revisions,
file ownership, integration hooks, verification gates, and PR order. Planned
paths and commands in that document are not implemented yet.

Current layout: `index.js` and `index.d.ts` are the placeholder API; `test/`
contains its tests; `.github/workflows/` owns CI and publishing; `docs/plan/`
contains the extraction plan. Extraction will retain `maestro/` for core,
runtime and adapters, `pi-extension/` for Pi integration, and emit JS and
TypeScript declarations into `dist/`.

## Contract and scope

- Step 1 is mechanical extraction: preserve observable behavior, error text,
  defaults, ordering, configuration paths, retained artifacts and reload ownership.
  Keep fixes or new capabilities in separate, explicitly authorized changes.
- Preserve every existing public tool, especially `subagent`, `subagent_cancel`,
  `subagent_send`, and `caller_ping`: names, parameters, scope, acknowledgements,
  results and `delegation-outcome/v0.1`. Keep the TypeBox schema snapshots and
  exact delivery fixtures; do not regenerate them to conceal drift.
- Public APIs use plain TypeScript, Promises, AbortSignal, AsyncIterable and DTOs.
  Pi is the only supported harness at launch. The future non-terminal execution
  seam, checked-outcome outbox and internal Effect pilot are separate steps.
- Herdr providers, terminal widgets/renderers and sidebar remain in
  `pi-herdr-agents`. Maestro must not import that package. The worker supervisor
  must not import Maestro; its Pi processes load the relevant extension entry.
- Keep experimental worker entry points separate from the stable tool entry.
  They are not evidence of stable contract parity.

## Checks

Use Node **>=26.12.1**. Today run `npm test` and `npm pack --dry-run`.
After the tooling PR lands, use the scripts in `package.json` for formatting,
lint, strict typechecking, schema/docs checks, unit tests, coverage, build and
packed-consumer tests. Run the checks required by the current extraction PR,
including upstream composition tests when the package boundary changes.
Report skipped or unavailable checks rather than claiming them green.

Tests must use isolated config/HOME and fixture processes, never daily Pi,
Herdr, Core, worker sockets, account stores or credentials. Preserve the source
suite's environment-cleaning helpers. Test published JavaScript from an installed
tarball; passing strip-types tests alone does not prove the npm package works.

## License and releases

This package is MIT under the repository LICENSE (nubl). Extracted code needs no
per-file notices; name the source repository and revision in the PR description.

Publishing is through `.github/workflows/publish.yml`: authorized `v*` tags,
matching `package.json` version, GitHub environment `npm-publish`, npm trusted
publishing/OIDC. Never publish from a laptop or add a long-lived npm token.
Commits, pushes, tags, PRs and releases each require the task's authorization.
Changes to the founder's `giuseppecrj/pi-herdr-agents` repository stay local
until he explicitly approves pushing them.
