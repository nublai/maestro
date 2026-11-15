# @nubl/maestro

Harness-neutral subagent engine: delegation, checked outcomes and a pluggable execution seam. It will serve both pi-worker and pi-herdr-agents.

**Status:** placeholder with the M1 build/provenance scaffold. The engine has not been extracted from pi-herdr-agents yet. Early versions exist to set up publishing.

## Development

Use Node **>=26.12.1** and `npm ci`. `npm run build` emits JavaScript,
declarations and source maps into `dist/`; `npm run test:package` installs a
fresh tarball and tests the emitted package without Pi peers or TypeScript loaders.
The placeholder API remains `version: string` until M6.

Run `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm test`,
`npm run build`, `npm run test:package` and `npm pack --dry-run` before submission.
See [the extraction plan](docs/plan/extraction.md) and
[provenance records](provenance/README.md) for pins, coverage and later gates.

## Publishing

Releases publish to npm from GitHub Actions with npm trusted publishing (OIDC). No npm token is stored in this repository.

1. Bump `version` in `package.json` and merge to `main`.
2. Push a tag `vX.Y.Z` that matches the version.
3. `.github/workflows/publish.yml` checks the tag against `package.json`, installs the lockfile, validates, builds and tests an installed tarball before publishing. Prerelease versions publish under `next`; stable versions keep `latest`. The `npm-publish` environment can require an approval.

The repository is public, so npm attaches a provenance statement to every release.
