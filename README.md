# harnext

Move coding-agent chat history between Claude Code and pi.

```
npm i -g @buildingthefuture/harnext
```

## Claude Code → pi

From the project whose conversation you want to move:

```
cd your-project
harnext
```

`claude-to-pi` is the default direction. The explicit form is:

```
harnext claude-to-pi
```

harnext reads the newest Claude Code session for the directory, writes a new pi
session, and prints the exact resume command:

```
pi --session 01a04033
```

## pi → Claude Code

```
cd your-project
harnext pi-to-claude
```

harnext reads the newest pi session for the directory, writes a new Claude Code
session, and prints:

```
claude --resume 2db50c18-c116-4f54-a65e-e14d86d9f599
```

These are snapshot imports, not live synchronization. Further messages stay in
the harness where you send them. Run harnext again to move a newer snapshot.
Files need no synchronization because both harnesses work in the same project
directory.

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
| `--list` | List sessions from the source harness. |
| `--dry-run` | Report the conversion and write nothing. |
| `--digest` | Import one deterministic summary instead of the full transcript. |
| `--name <name>` | Display name/title for the imported session. |
| `--max-tool-output <chars>` | Cap one result. Default 10000; `0` disables. |
| `--preserve-tools` | Preserve unknown calls instead of degrading them to text. This can break resume. |
| `--sessions-root <dir>` | pi sessions root, as source or target. |
| `--projects-root <dir>` | Claude Code projects root, as source or target. |
| `--keep-reminders` | Claude → pi only: retain Claude `<system-reminder>` blocks. |
| `--pi-package <dir>` | Claude → pi only: write with this pi package. |

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
records. pi custom/extension records are dropped when writing Claude. Every
lossy step appears in the conversion report.

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

The neutral `Transcript` type in `src/ir.ts` is the seam between harnesses. A
new harness needs one reader and one writer rather than one converter per pair.

## Development

```
npm install
npm run typecheck
npm test
npm run build
```

## License

MIT
