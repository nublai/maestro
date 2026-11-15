# @nubl/maestro

Harness-neutral subagent engine: delegation, checked outcomes and a pluggable execution seam. It will serve both pi-worker and pi-herdr-agents.

**Status:** placeholder. The engine has not been extracted from pi-herdr-agents yet. Version `0.0.0` exists to set up publishing.

## Publishing

Releases publish to npm from GitHub Actions with npm trusted publishing (OIDC). No npm token is stored in this repository.

1. Bump `version` in `package.json` and merge to `main`.
2. Push a tag `vX.Y.Z` that matches the version.
3. `.github/workflows/publish.yml` checks the tag against `package.json`, runs the tests and runs `npm publish`. The `npm-publish` environment can require an approval.

The repository is public, so npm attaches a provenance statement to every release.
