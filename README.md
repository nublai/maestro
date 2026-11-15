# @nubl/maestro

Harness-neutral subagent engine: delegation, checked outcomes and a pluggable execution seam. It will serve both pi-worker and pi-herdr-agents.

**Status:** M3 Pi adapters, runtime and host ports extracted; the Pi tool surface and extension factory arrive in M4. The root API remains the `0.0.1` placeholder until M6. Nothing here authorizes a release.

## Development

Use Node **>=26.12.1** and `npm ci`. `npm run build` emits JavaScript,
declarations and source maps into `dist/`; `npm run test:package` installs a
fresh tarball and tests the emitted package without Pi peers or TypeScript loaders.
The placeholder root API remains `version: string` until M6.

`@nubl/maestro/engine` exposes `createRunSession`, `defaultRetainSurface` and
existing core/run-session types without Pi peers, config discovery or provider
initialization. `@nubl/maestro/testing` exposes the two fakes and reusable
conformance runners. These entries execute emitted JavaScript.

`@nubl/maestro/runtime` is the Pi-aware runtime barrel (`createDefaultRunSession`
and its option types). A terminal host composes it with an explicit
`HostSurfaceBinding` (`@nubl/maestro/runtime/host-surface-binding`): binding
resolution, the owning provider, a per-launch provider and the optional marker
transport. Without that binding or the closed injected-infrastructure test
composition, session creation fails. `@nubl/maestro/pi/child` is the
protocol-only child extension each launch loads by default (its emitted
`entry.js`); a host may pass its own wrapper as `childEntryPath`. Entries that
import Pi or TypeBox require the optional peers; the root, `./engine` and
`./testing` stay Pi-free.

The finite `./core/*`, `./runtime/*` and `./adapters/pi/*` compatibility families
(including nested config/roles modules) are **internal-compat, no stability
promise**. The stars describe a family, not wildcard exports. No tool surface,
extension factory, Herdr provider, terminal widget or experimental worker entry
ships in M3.

Run `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm test`,
`npm run test:fidelity`, `npm run check:copy-fidelity`, `npm run build`,
`npm run check:boundaries`, `npm run test:coverage`, `npm run test:package` and
`npm pack --dry-run` before submission. Unit/coverage runs use an isolated HOME,
agent directory and credential-free environment; reports remain under ignored
`evidence/`. Coverage gates every measured copied original file against its
unchanged M1 floor (lines changed upstream after the baseline are mapped and held
to the baseline hit rate on the same lines), not a global package threshold.
See [the extraction plan](docs/plan/extraction.md) and
[provenance records](provenance/README.md) for pins, coverage and later gates.

## Publishing

Releases publish to npm from GitHub Actions with npm trusted publishing (OIDC). No npm token is stored in this repository.

1. Bump `version` in `package.json` and merge to `main`.
2. Push a tag `vX.Y.Z` that matches the version.
3. `.github/workflows/publish.yml` checks the tag against `package.json`, installs the lockfile, validates, builds and tests an installed tarball before publishing. Prerelease versions publish under `next`; stable versions keep `latest`. The `npm-publish` environment can require an approval.

The repository is public, so npm attaches a provenance statement to every release.
