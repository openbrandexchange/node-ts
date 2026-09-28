# Contributing

Thank you for helping. This is the TypeScript edition of the Open Brand Exchange portal
("Portal for Cloudflare"). Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## Before you start

- Bugs and ideas: open an issue with the templates. Security problems: see [SECURITY.md](SECURITY.md),
  never a public issue.
- Protocol changes start in [openbrandexchange/spec](https://github.com/openbrandexchange/spec); this
  repository follows the spec, and all three portal editions behave the same.
- Admin screens live in [admin-ui](https://github.com/openbrandexchange/admin-ui) and are vendored here
  with `scripts/update-ui.sh`.

## Development

```sh
bun install
bun run lint && bun run typecheck && bun run test   # must pass
bun run smoke:workers                                # the whole flow in the local Workers runtime
sh e2e/run.sh                                        # browser tests with axe (needs Node.js)
```

- Tests test behaviour (HTTP in, HTTP out, database state), not source text.
- Schema changes are new files in `migrations/` (forward-only, never edit a released file), then
  `bun run gen`. Both D1 and bun:sqlite must run them.
- Code, comments, commit messages and docs are English; user-facing texts come from admin-ui in 25
  languages and follow the [glossary](https://github.com/openbrandexchange/spec/blob/main/docs/glossary.md).
- Keep dependencies few; every production dependency must pass `bun run licenses`.

## Developer Certificate of Origin

Contributions are accepted under the [Developer Certificate of Origin 1.1](https://developercertificate.org/).
Sign off every commit to say you wrote it or have the right to submit it under this repository's
licence (AGPL-3.0-only):

```sh
git commit -s -m "Explain the change"
```

This adds `Signed-off-by: Your Name <you@example.com>`. You keep the copyright in your contribution.
There is no contributor licence agreement.

## Pull requests

- One logical change per pull request, with tests and docs updated.
- CI must be green: lint, types, tests, audit, licences, Workers build, conformance, browser tests,
  Docker checks.
- User-visible changes get a line in `CHANGELOG.md` under "Unreleased".
