# Contributing to harnext

## Add a harness

A harness adapter converts its disk history to and from `Transcript` in
`src/ir.ts`. Do not add pairwise converters.

1. Add `src/readers/<harness>.ts` with parse, file read, repository discovery,
   global discovery, and session resolution functions.
2. Add `src/writers/<harness>.ts` with record serialization and file writing.
   The writer must support a caller-supplied session ID, path, and atomic
   overwrite so watchdog can refresh an inactive mirror without changing its
   resume command.
3. Implement the `HarnessAdapter` interface in `src/adapters/<harness>.ts`, then
   add it to `HARNESS_ADAPTERS` in `src/adapters/index.ts`. Discovery, transfer,
   sync, environment detection, and resume launching use this single registry.
4. Add exact live-session evidence to `src/alive.ts`. Do not label a chat alive
   from modification time alone. Add conservative repository-level process
   protection when the harness does not expose its active session ID.
5. Export the public reader and writer APIs from `src/index.ts`.
6. Document the session format and resume command in `README.md`.

Use the harness's public import/session API when it has one. If direct disk
writing is required, identify the supported format version and verify the
result with the harness's own resume, export, migration, or validation command.
Never edit a running target session. Never let watchdog resolve divergent
histories by timestamps.

## Tests

Every adapter needs fixtures for:

- User, assistant, reasoning, tool-call, and tool-result conversion.
- Harness bookkeeping that must not enter model-visible context.
- Active-branch selection when the store keeps rewind branches.
- A real or fixture-backed resume/validation path.
- Stable session identity during atomic mirror refresh.
- One-writer watchdog propagation and multi-writer conflict refusal.

Run:

```sh
npm install
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

Do not commit real user transcripts, credentials, or generated sync state.
