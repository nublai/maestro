# Changelog

## Unreleased

Docs and tests only; no behaviour change.

- Documented a limit of the early-exit relay's masking. The relay cannot learn
  the terminal width, so it joins a row as wide as the widest row to the next
  row before masking. An ordinary word glued to a credential-shaped run across
  that join is masked with it: a long error that did not wrap, followed by
  `OPENAI_API_KEY=<key>`, is relayed as "status must be an [redacted]" (seen in
  giuseppecrj/pi-herdr-agents#150). The rest of the error and the masking of
  the key are unaffected. Showing the word instead (nublai/maestro#4) would also
  show a word-like edge of a real wrapped credential, so 0.1.2's behaviour
  stays.
- The masking tests now flag a leaked piece of a credential three or more
  characters long, letters included; they used to skip all-letter pieces.
  They cover every credential shape, plus credentials with word-like edges,
  at every wrap offset at 40, 80, 100, 120 and 200 columns, read as LF, CRLF
  or with ANSI escapes, and the pi-herdr-agents#150 screen.

## 0.1.2 (2026-11-16)

Fixes for giuseppecrj/pi-herdr-agents#149, where every child failed with a bare
"exit code 1" because `config.json` held only `models`.

- An omitted `status` section, or an omitted `status.enabled`, now keeps the
  shipped default (enabled), as every other section already did. A present but
  malformed section still stops the load with an error naming the file and key.
- The task-model writer publishes `config.json` with mode `0600`. It already
  kept every other key; it now also keeps the file owner-only.
- A child that exits before its session starts reports its last terminal lines
  (at most 12 lines and 2,000 characters, with credential-shaped values masked)
  after the exit code, so the parent sees why it failed. Masking covers AWS
  access key IDs (`AKIA`, `ASIA` and the other documented prefixes), 40-character
  AWS secret keys (including `/` and `+`), JWTs of any length, `Authorization`
  headers in any case, and the earlier API-key, token, URL and opaque shapes.
  Rows a terminal wrapped are rejoined and masked again, so a credential split
  across rows is masked on each one. The terminal read waits at most 3 seconds.
- Copies may now carry a recorded `owned_change` (the reason and the exact blob):
  after H2 Maestro owns the source, and `check:copy-fidelity` still verifies
  the pinned original and fails on any unrecorded edit.

## 0.1.1

Corrective packaging release. No code changes.

- `engines.node` is widened from `>=26.12.1` to `>=22.19.0`, pi's own floor.
  With npm `engine-strict`, 0.1.0's `>=26.12.1` stopped Node 22 users from
  installing pi-herdr-agents. The published JavaScript passes the
  packed-tarball package tests on Node 22.19.0, and CI now runs those tests on
  Node 22 too (`node22-runtime`).
- Development and the source suite still need Node `>=26.12.1`.

## 0.1.0

First extracted release. See
[`docs/release-readiness.md`](docs/release-readiness.md).
