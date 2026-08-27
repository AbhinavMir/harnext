# harnext

Move a coding-agent chat history from one harness to another. Version 0.1 reads
Claude Code sessions and writes pi sessions.

```
cd your-project
npx @buildingthefuture/harnext
```

Installed globally, the command is `harnext`:

```
npm i -g @buildingthefuture/harnext
```

That takes the newest Claude Code session recorded for the directory, writes it
into pi's session store, and prints the command that resumes it:

```
/Users/you/.claude/projects/-Users-you-project/8f21….jsonl
  -> /Users/you/.pi/agent/sessions/--Users-you-project--/2026-08-26T22-31-58-253Z_01a04033….jsonl
  261 messages, 126 tool calls mapped, 2 degraded to text
  141 harness records kept as pi custom entries
  written by pi 0.84.2 at /Users/you/.local/lib/node_modules/@earendil-works/pi-coding-agent

Resume it:
  cd /Users/you/project && pi --session 01a04033
```

pi then opens the conversation with its full history and you keep working.

## Requirements

Node 22.19 or later, and an installed pi. harnext writes the session file with
the session code from your own pi installation, because pi's session format is
versioned: a file written by a different release is refused with "Session file
is not a valid pi session". Point harnext at a specific pi with `--pi-package`
or the `HARNEXT_PI_PACKAGE` environment variable.

The Node version is the one that trips people up. pi's own code does not parse
on Node 18, so harnext cannot load it there and says so, naming the version it
is running on. Check with `node --version` before reaching for anything else.

If `npx` reports `harnext: command not found`, name the binary explicitly:

```
npx --package @buildingthefuture/harnext harnext
```

## Commands

```
harnext                    Import the newest Claude Code session for this directory
harnext --list             Show the Claude Code sessions recorded for this directory
harnext --session 8f21     Import one session by id, id prefix, or file path
harnext --digest           Import a summary instead of the full transcript
harnext --dry-run          Report what the import contains and write nothing
```

| Option | Effect |
| --- | --- |
| `--cwd <dir>` | Project directory. Default: the current directory. |
| `--name <name>` | Display name for the new pi session. |
| `--max-tool-output <chars>` | Cap on one tool result. Default 10000. `0` disables the cap. |
| `--keep-reminders` | Keep Claude's `<system-reminder>` blocks. |
| `--preserve-tools` | Keep tool calls pi does not have. See below. |
| `--sessions-root <dir>` | pi session store. Default: pi's own. |
| `--projects-root <dir>` | Claude Code project store. Default: `~/.claude/projects`. |
| `--pi-package <dir>` | The `@earendil-works/pi-coding-agent` package to write with. |

## What happens to the transcript

**Only the live branch is imported.** A Claude Code session is a tree, not a
list: a rewind starts a new branch and keeps the old one. harnext walks back
from the leaf the session ended on, so abandoned branches drop out. The report
counts them.

**Tools are translated.** A tool call that names a tool the target does not have
is worse than no call at all, because the provider rejects the whole history on
the first resumed turn.

| Claude Code | pi | Note |
| --- | --- | --- |
| `Read` | `read` | `file_path` becomes `path` |
| `Write` | `write` | |
| `Edit`, `MultiEdit` | `edit` | one `edits[]` array; `replace_all` has no equivalent |
| `Bash` | `bash` | timeout converts from milliseconds to seconds |
| `Glob` | `find` | |
| `Grep` | `grep` | `-i` becomes `ignoreCase`, `-C` becomes `context` |
| `LS` | `ls` | |

Anything else — `TodoWrite`, `Task`, `WebFetch`, MCP tools — becomes a line of
text in the assistant turn that names the tool, its arguments and its result.
The conversation still records what happened, and nothing dangles. Use
`--preserve-tools` to keep the original call instead, for archives rather than
for resuming.

**Every tool call gets an answer.** A call the original session never resolved,
because the session ended mid-turn, receives a synthetic error result.

**Thinking survives, signatures do not.** The Anthropic thinking signature is
bound to the Anthropic API, and a resumed session can run on any provider.

**Harness records stay out of the model's context.** Hook output, mode changes
and slash-command echoes become pi `custom` entries: stored and visible, never
sent to a model. Claude's `<system-reminder>` blocks are removed from user
turns, because they describe Claude's own skills and tool policy.

**Subagent transcripts are dropped.** The parent `Task` result already carries
the outcome.

**Long tool results are truncated** at 10000 characters, with a marker. Raise or
disable the cap with `--max-tool-output`.

Every run reports what it did, including what it lost. `--dry-run` prints the
same report and writes nothing.

## Digest mode

`--digest` collapses the transcript into one opening message: what was asked,
which files changed, which commands ran, and where the session stopped. It is
assembled from the transcript, so it needs no model and runs offline. Use it
when the point is to carry the state of the work across, not the whole record.

## As a library

```ts
import { readClaudeSessionFile, resolveClaudeSession, writeToPi } from "@buildingthefuture/harnext";

const source = await resolveClaudeSession(process.cwd());
const transcript = await readClaudeSessionFile(source.path);
const result = await writeToPi(transcript);
console.log(result.path, result.stats);
```

## Adding a harness

harnext is a hub, not a converter. A reader turns a harness's files into a
neutral `Transcript` (`src/ir.ts`); a writer turns a `Transcript` into another
harness's files. Supporting N harnesses costs N readers and N writers, not one
converter per pair.

To add one, write `src/readers/<harness>.ts` or `src/writers/<harness>.ts`
against the `Transcript` type. Record every lossy step with `Notes.add`, so the
report tells the truth about what did not survive.

## Development

```
npm install
npm test
npm run build
```

The round-trip tests load harnext's output back through pi's own
`SessionManager` and build the context pi would send to a model. That is the
only assertion that means anything: a session file pi cannot open is not a
session.

## License

MIT
