#!/usr/bin/env node
/**
 * harnext command line.
 *
 * With no arguments it takes the newest Claude Code session recorded for the
 * current directory and writes it into pi.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { digestTranscript } from "./digest.js";
import type { Transcript } from "./ir.js";
import { findClaudeSessions, readClaudeSessionFile, resolveClaudeSession } from "./readers/claude-code.js";
import { DEFAULT_MAX_TOOL_OUTPUT_CHARS, toPiEntries, writeToPi } from "./writers/pi.js";

interface Options {
	cwd: string;
	session?: string;
	digest: boolean;
	keepReminders: boolean;
	preserveTools: boolean;
	maxToolOutput: number;
	name?: string;
	sessionsRoot?: string;
	projectsRoot?: string;
	piPackage?: string;
	dryRun: boolean;
	list: boolean;
	help: boolean;
	version: boolean;
}

const USAGE = `harnext - move a coding-agent chat history into another harness

Usage:
  harnext [options]              Import the newest Claude Code session for this directory into pi
  harnext --list                 Show the Claude Code sessions recorded for this directory

Options:
  --session <path|id>            Session file, or a full or partial session id
  --cwd <dir>                    Project directory (default: the current directory)
  --digest                       Import one summary message instead of the full transcript
  --keep-reminders               Keep Claude's <system-reminder> blocks in user turns
  --preserve-tools               Keep tool calls pi does not have (can break resume)
  --max-tool-output <chars>      Cap on a single tool result (default: ${DEFAULT_MAX_TOOL_OUTPUT_CHARS}, 0 disables)
  --name <name>                  Display name for the new pi session
  --sessions-root <dir>          pi sessions directory (default: ~/.pi/agent/sessions)
  --projects-root <dir>          Claude Code projects directory (default: ~/.claude/projects)
  --pi-package <dir>             Write with this @earendil-works/pi-coding-agent package
  --dry-run                      Report what the import would contain and write nothing
  -h, --help                     Show this help
  -v, --version                  Show the version
`;

function parseArgs(argv: string[]): Options {
	const options: Options = {
		cwd: process.cwd(),
		digest: false,
		keepReminders: false,
		preserveTools: false,
		maxToolOutput: DEFAULT_MAX_TOOL_OUTPUT_CHARS,
		dryRun: false,
		list: false,
		help: false,
		version: false,
	};

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		const next = (): string => {
			const value = argv[index + 1];
			if (value === undefined) throw new Error(`${arg} needs a value`);
			index += 1;
			return value;
		};
		switch (arg) {
			case "--session":
				options.session = next();
				break;
			case "--cwd":
				options.cwd = resolve(next());
				break;
			case "--digest":
				options.digest = true;
				break;
			case "--keep-reminders":
				options.keepReminders = true;
				break;
			case "--preserve-tools":
				options.preserveTools = true;
				break;
			case "--max-tool-output": {
				const value = Number.parseInt(next(), 10);
				if (Number.isNaN(value) || value < 0) throw new Error("--max-tool-output needs a number of 0 or more");
				options.maxToolOutput = value;
				break;
			}
			case "--name":
				options.name = next();
				break;
			case "--sessions-root":
				options.sessionsRoot = resolve(next());
				break;
			case "--projects-root":
				options.projectsRoot = resolve(next());
				break;
			case "--pi-package":
				options.piPackage = resolve(next());
				break;
			case "--dry-run":
				options.dryRun = true;
				break;
			case "--list":
				options.list = true;
				break;
			case "-h":
			case "--help":
				options.help = true;
				break;
			case "-v":
			case "--version":
				options.version = true;
				break;
			default:
				throw new Error(`Unknown option: ${arg}`);
		}
	}
	return options;
}

async function version(): Promise<string> {
	const here = dirname(fileURLToPath(import.meta.url));
	const text = await readFile(join(here, "..", "package.json"), "utf8");
	const parsed: unknown = JSON.parse(text);
	if (typeof parsed === "object" && parsed !== null && "version" in parsed) {
		const value = (parsed as { version: unknown }).version;
		if (typeof value === "string") return value;
	}
	return "unknown";
}

function report(transcript: Transcript, options: Options): string[] {
	const { stats } = toPiEntries(transcript, {
		preserveTools: options.preserveTools,
		maxToolOutputChars: options.maxToolOutput,
	});
	const lines = [
		`  ${stats.messages} messages, ${stats.toolsMapped} tool calls mapped, ${stats.toolsDegraded} degraded to text`,
	];
	if (stats.metaEntries > 0) lines.push(`  ${stats.metaEntries} harness records kept as pi custom entries`);
	if (stats.resultsSynthesized > 0) lines.push(`  ${stats.resultsSynthesized} tool calls had no recorded result`);
	if (stats.resultsOrphaned > 0) lines.push(`  ${stats.resultsOrphaned} tool results had no matching call`);
	if (stats.resultsTruncated > 0) lines.push(`  ${stats.resultsTruncated} tool results truncated`);
	if (stats.argumentsLost.length > 0) lines.push(`  arguments without a pi equivalent: ${stats.argumentsLost.join(", ")}`);
	for (const note of transcript.notes) {
		lines.push(`  ${note.code}${note.detail === "" ? "" : ` (${note.detail})`}: ${note.count}`);
	}
	return lines;
}

async function run(argv: string[]): Promise<number> {
	const options = parseArgs(argv);

	if (options.help) {
		process.stdout.write(USAGE);
		return 0;
	}
	if (options.version) {
		process.stdout.write(`${await version()}\n`);
		return 0;
	}

	if (options.list) {
		const sessions = await findClaudeSessions(options.cwd, options.projectsRoot);
		if (sessions.length === 0) {
			process.stdout.write(`No Claude Code sessions recorded for ${options.cwd}\n`);
			return 0;
		}
		for (const session of sessions) {
			const when = new Date(session.modifiedAt).toISOString().replace("T", " ").slice(0, 16);
			const label = session.title ?? session.firstPrompt ?? "";
			process.stdout.write(`${session.sessionId.slice(0, 8)}  ${when}  ${label}\n`);
		}
		return 0;
	}

	const source = await resolveClaudeSession(options.cwd, options.session, options.projectsRoot);
	const parsed = await readClaudeSessionFile(source.path, { keepSystemReminders: options.keepReminders });
	const transcript = options.digest ? digestTranscript(parsed) : parsed;

	if (options.dryRun) {
		process.stdout.write(`${source.path}\n`);
		process.stdout.write(`${report(transcript, options).join("\n")}\n`);
		process.stdout.write("  nothing written (--dry-run)\n");
		return 0;
	}

	const result = await writeToPi(transcript, {
		preserveTools: options.preserveTools,
		maxToolOutputChars: options.maxToolOutput,
		...(options.name === undefined ? {} : { name: options.name }),
		...(options.sessionsRoot === undefined ? {} : { sessionsRoot: options.sessionsRoot }),
		...(options.piPackage === undefined ? {} : { piPackage: options.piPackage }),
	});

	process.stdout.write(`${source.path}\n  -> ${result.path}\n`);
	process.stdout.write(`${report(transcript, options).join("\n")}\n`);
	process.stdout.write(`  written by pi ${result.writtenBy.version} at ${result.writtenBy.origin}\n`);
	process.stdout.write(`\nResume it:\n  cd ${transcript.cwd} && pi --session ${result.sessionId.slice(0, 8)}\n`);
	return 0;
}

run(process.argv.slice(2)).then(
	(code) => {
		process.exitCode = code;
	},
	(error: unknown) => {
		process.stderr.write(`harnext: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	},
);
