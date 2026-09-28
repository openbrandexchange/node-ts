## What and why

<!-- One logical change. Link the issue if there is one. -->

## Checks

- [ ] `bun run lint && bun run typecheck && bun run test` pass
- [ ] Tests cover the new behaviour (HTTP in, HTTP out, database state)
- [ ] New schema changes are a new file in `migrations/` (forward-only) and `bun run gen` was run
- [ ] Docs and `CHANGELOG.md` ("Unreleased") updated for user-visible changes
- [ ] Every commit is signed off (`git commit -s`, Developer Certificate of Origin)
