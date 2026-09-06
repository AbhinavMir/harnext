# harnext

Choose, transfer, and sync chats across Claude Code, pi, Oh My Pi, and Codex.

```
npm i -g @buildingthefuture/harnext
```

## Demo

![harnext transfer and export CLI](https://raw.githubusercontent.com/AbhinavMir/harnext/main/docs/screenshots/cli-demo.png)

![harnext HTML prompt-history export](https://raw.githubusercontent.com/AbhinavMir/harnext/main/docs/screenshots/prompt-export.png)

## Open any chat

```
harnext chats
```

`chats` collects Claude Code, pi, Oh My Pi, and Codex chats across the system
into one newest-first list. Choose a chat to resume it in a new terminal window.
Use `harnext chats alive` to show only sessions tied to a running process,
terminal record, or current harness environment. In a pipe it prints the list;
`--session <id>` selects a chat without the picker.

## Transfer any chat

Run harnext inside a repository:

```
cd your-project
harnext
```

It combines supported chats for that repository into one newest-first numbered
list. Choose a chat, then choose one destination or all installed harnesses. In
a pipe or script it prints the list instead of waiting for input; use
`--session <id> --to <harness|all>` for a non-interactive transfer.

```
harnext all
harnext all alive
```

`all` prints chats across every repository without opening a picker. `all alive`
uses the same conservative live-session check as `chats alive`; modification
time alone does not make a chat alive.

| Harness | Read | Write | Resume |
| --- | --- | --- | --- |
| Claude Code | yes | yes | `claude --resume <id>` |
| pi | yes | yes | `pi --session <id>` |
| Oh My Pi | yes | yes | `omp --resume <id>` |
| Codex CLI/App | yes | yes | `codex resume <id>` |

Codex imports are written as rollout history and registered through Codex's own
`migrate-rollouts` command. Oh My Pi imports use its native v3 session format.

## Tell the receiving agent

Interactive transfers ask:

```
Tell the receiving agent about switching harnesses?
[Y] Yes once    [A] Always    [N] No
```

The recommended notice is a final model-visible user message. It tells the
receiving agent to inspect its MCP servers, tools, skills, extensions, and
runtime state because these can differ between harnesses. Harnext recognizes
its marker and does not duplicate the notice during watchdog updates.

`A` stores the preference in `~/.harnext/config.json`. `N` skips only the
current transfer. Change the persistent behavior with the single-key config UI
or a scriptable option:

```
harnext config
harnext config --tell-agent ask
harnext config --tell-agent always
harnext config --tell-agent never
```

The default is `ask`. Non-interactive transfers treat `ask` as no; set `always`
when scripts should add the notice.

## Goal loop

```
harnext goal "all tests pass and the build is clean" --yolo
harnext goal "ship the CSV export" --judge claude --max-rounds 20
```

`goal` runs a director agent that drives a worker chat until the goal is
verifiably reached. The worker is a chat in this repository; harnext picks the
current chat, or use `--session <id>` to choose one. Each round the director
reads the worker's own output, decides if the goal is met, and sends the next
instruction if it is not.

The director stops only on a verified done verdict. It requires concrete
evidence in the worker's reply, such as a passing test or a command result.
`--max-rounds` is a safety cap, not a success signal. harnext reaches the cap
and reports `GOAL NOT REACHED`. It never calls an unfinished goal done.

The director runs on the worker's harness by default; `--judge <harness>` runs
it on another. Both harnesses must be installed. The worker runs its harness in
non-interactive mode. Add `--yolo` to let the worker use tools without approval
prompts, which an autonomous loop needs.

## Sync

```
harnext sync
harnext watchdog
```

`sync` detects the current harness from its session environment. From an
ordinary terminal it opens the repo picker. It creates one mirror in every
installed harness and records the group under `~/.harnext/groups/`.

`watchdog` stays in the foreground and checks the group every 1500ms. One
changed member becomes the source and is copied to the inactive mirrors. Writes
are debounced and atomic, so a partial JSONL record is never propagated. A
running target harness is left untouched until it closes. If two members change
before a sync pass, watchdog stops and reports a conflict without overwriting
either history. This makes switching safe when only one harness edits the chat
at a time; it is not a multi-writer merge system.

Use `--interval <milliseconds>` to change the scan interval. Ctrl-C stops the
watchdog. Sync state contains paths, session IDs, timestamps, and content
fingerprints, not transcript text.

## Explicit transfers

The original two-harness commands remain available:

```
harnext claude-to-pi
harnext pi-to-claude
```

Each reads the newest source session unless `--session` is supplied and prints
the exact resume command.

## Export prompt history

Export user prompts only; assistant messages, tool traffic, and images are
ignored:

```
harnext export --from claude --mode raw --format markdown
harnext export --from pi --mode raw --format html --output prompts.html
harnext export --from pi --mode raw --format text --redact off
```

Raw mode preserves each harness prompt exactly. Local redaction is on by
default and replaces matches with `[redacted]`. It uses Obscenity's English
dataset and covers broader profanity as well as identity slurs. Like every
word filter, it is heuristic rather than a guarantee. No prompt text is sent
to a moderation service. Use `--redact off` only when the destination
may safely contain the original text.

Smart mode replaces every prompt with a concise cleaned version. It does not
include the original alongside it. Smart export uses OpenRouter so one API key
can select models from multiple providers:

```
export OPENROUTER_API_KEY=...
harnext export --from pi --mode smart \
  --smart-model anthropic/claude-haiku-4.5 \
  --format markdown
```

`OPENROUTER_MODEL` can supply the model instead of `--smart-model`. harnext
requests strict structured output and tells OpenRouter to route only to
endpoints that support it. The selected model receives the prompt text; raw
mode stays entirely local.

Publish an HTML rendering to hypertext.one only when explicitly requested:

```
harnext export --from claude --mode smart \
  --smart-model anthropic/claude-haiku-4.5 \
  --format html --post hypertext --expires 7d
```

hypertext.one pages are readable by anyone with the URL unless `--password` is
set. The service has no accounts or API keys, defaults to 30-day expiry, and
returns an owner token once for editing or deletion. harnext prints that token
but does not store it. Exports over the service's 100KB page limit are split
into ordered pages automatically.

Formats are `html`, `markdown`, and `text`. Use `--output -` for stdout or
`--output <path>` to choose a file. Otherwise harnext writes
`prompt-history-<session>.{html,md,txt}` in the project directory. Select a
specific source session with the same `--session <path|id>` option used by
transfers.

## Inspect before importing

```
harnext claude-to-pi --list
harnext pi-to-claude --list

harnext claude-to-pi --dry-run
harnext pi-to-claude --dry-run
```

Select a source by full/partial id or file path:

```
harnext pi-to-claude --session 01a04033
harnext claude-to-pi --session 278e6bb8
```

## Options

| Option | Effect |
| --- | --- |
| `--cwd <dir>` | Project directory. Default: the current directory. |
| `--session <path|id>` | Source session path, id, or unambiguous id prefix. |
| `--to <claude|pi|omp|codex|all>` | Skip the destination picker. |
| `--interval <milliseconds>` | Watchdog scan interval; minimum 250, default 1500. |
| `--list` | List sessions from a legacy transfer source harness. |
| `--dry-run` | Report the conversion and write nothing. |
| `--digest` | Import one deterministic summary instead of the full transcript. |
| `--name <name>` | Display name/title for the imported session. |
| `--max-tool-output <chars>` | Cap one result. Default 10000; `0` disables. |
| `--preserve-tools` | Preserve unknown calls instead of degrading them to text. This can break resume. |
| `--sessions-root <dir>` | pi sessions root, as source or target. |
| `--projects-root <dir>` | Claude Code projects root, as source or target. |
| `--keep-reminders` | Claude → pi only: retain Claude `<system-reminder>` blocks. |
| `--pi-package <dir>` | Claude → pi only: write with this pi package. |

Export-only options are documented under “Export prompt history”; run
`harnext export --help` for the complete flag list.

If `npx @buildingthefuture/harnext` reports `harnext: command not found`, use:

```
npx --package @buildingthefuture/harnext harnext pi-to-claude
```

## What survives

Both session stores are parent-linked JSONL trees. harnext follows the active
leaf and drops abandoned rewind branches.

Tool calls are translated in both directions:

| Claude Code | pi |
| --- | --- |
| `Read` | `read` |
| `Write` | `write` |
| `Edit` | `edit` |
| `Bash` | `bash` |
| `Glob` | `find` |
| `Grep` | `grep` |
| `LS` | `ls` |

A target-unknown call and its result become ordinary assistant text. Leaving an
unknown or unanswered tool call in history can make the provider reject the
entire resumed conversation. A call with no recorded result receives a
synthetic error result.

Provider-signed thinking cannot cross providers. Claude → pi keeps the thinking
text and drops its Anthropic signature. pi → Claude keeps the reasoning as
ordinary assistant text, because Claude rejects unsigned thinking blocks.

Harness bookkeeping stays out of model context. Claude hooks become pi custom
records. Pi `custom` extension records are dropped when writing Claude, while
model-visible `custom_message` records stay in the conversation as user
context. Every lossy step appears in the conversion report.

Pi compaction boundaries are preserved. Harnext emits the latest compaction
summary, its retained tail from `firstKeptEntryId`, and messages added after the
compaction; it does not resurrect the summarized history.

Tool results longer than 10000 characters are truncated with a marker unless
`--max-tool-output 0` is used.

## Digest mode

`--digest` produces one opening message containing the prompts, files changed,
commands run, and final assistant state. It is deterministic, offline, and
useful when you need the work state rather than the full record.

## Requirements

Node 22.19 or later. Claude → pi also requires an installed pi because harnext
uses that installation's own `SessionManager`; pi's disk format is versioned.
pi → Claude reads pi JSONL directly and does not load pi's runtime.

Check the runtime with `node --version`. pi's code does not parse on Node 18.
If harnext finds pi but cannot import it, the error includes the package path,
the import failure, and the running Node version.

## Library API

```ts
import {
  readPiSessionFile,
  resolvePiSession,
  writeToClaudeCode,
} from "@buildingthefuture/harnext";

const source = await resolvePiSession(process.cwd());
const transcript = await readPiSessionFile(source.path);
const result = await writeToClaudeCode(transcript);
console.log(result.path);
```

The neutral `Transcript` type in `src/ir.ts` is the boundary between harnesses.
Each harness implements the `HarnessAdapter` interface in `src/adapters/`, so
discovery, transfer, sync, and resume launching share one registry. A new
harness needs one reader, one writer, one adapter, and one registry entry rather
than one converter per pair.

## Add another harness

See [CONTRIBUTING.md](CONTRIBUTING.md). New adapters must document the session
store, use the neutral transcript model, preserve stable mirror identity, and
pass reader, writer, resume, and watchdog-conflict tests.

## Development

```
npm install
npm run typecheck
npm test
npm run build
```

## License

MIT
