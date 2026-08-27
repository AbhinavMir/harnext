#!/usr/bin/env node
/** harnext command line. */

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { digestTranscript } from "./digest.js";
import type { Transcript } from "./ir.js";
import { findClaudeSessions, readClaudeSessionFile, resolveClaudeSession } from "./readers/claude-code.js";
import { findPiSessions, readPiSessionFile, resolvePiSession } from "./readers/pi.js";
import {
	DEFAULT_MAX_TOOL_OUTPUT_CHARS as CLAUDE_MAX_TOOL_OUTPUT,
	toClaudeRecords,
	writeToClaudeCode,
} from "./writers/claude-code.js";
import { DEFAULT_MAX_TOOL_OUTPUT_CHARS, toPiEntries, writeToPi } from "./writers/pi.js";

type Direction = "claude-to-pi" | "pi-to-claude";

interface Options {
	direction: Direction;
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

const USAGE = `harnext - move coding-agent chat history between Claude Code and pi

Usage:
  harnext [claude-to-pi] [options]  Import Claude Code's newest session into pi (default)
  harnext pi-to-claude [options]    Import pi's newest session into Claude Code
  harnext <direction> --list        Show source sessions recorded for this directory

Options:
  --session <path|id>            Source session file, or a full or partial session id
  --cwd <dir>                    Project directory (default: the current directory)
  --digest                       Import one summary message instead of the full transcript
  --keep-reminders               Keep Claude's <system-reminder> blocks in user turns
  --preserve-tools               Keep target-unknown tool calls (can break resume)
  --max-tool-output <chars>      Cap on a single tool result (default: ${DEFAULT_MAX_TOOL_OUTPUT_CHARS}, 0 disables)
  --name <name>                  Display name/title for the imported session
  --sessions-root <dir>          pi sessions root (source or target, depending on direction)
  --projects-root <dir>          Claude Code projects root (source or target, depending on direction)
  --pi-package <dir>             Write pi with this @earendil-works/pi-coding-agent package
  --dry-run                      Report what the import would contain and write nothing
  -h, --help                     Show this help
  -v, --version                  Show the version
`;

function parseArgs(argv: string[]): Options {
	const options: Options = {
		direction: "claude-to-pi",
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

	let start = 0;
	const command = argv[0];
	if (command === "claude-to-pi" || command === "to-pi") {
		options.direction = "claude-to-pi";
		start = 1;
	} else if (command === "pi-to-claude" || command === "to-claude") {
		options.direction = "pi-to-claude";
		start = 1;
	}

	for (let index = start; index < argv.length; index += 1) {
		const arg = argv[index];
		const next = (): string => {
			const value = argv[index + 1];
			if (value === undefined) throw new Error(`${arg} needs a value`);
			index += 1;
			return value;
		};
		switch (arg) {
			case "--session": options.session = next(); break;
			case "--cwd": options.cwd = resolve(next()); break;
			case "--digest": options.digest = true; break;
			case "--keep-reminders": options.keepReminders = true; break;
			case "--preserve-tools": options.preserveTools = true; break;
			case "--max-tool-output": {
				const value = Number.parseInt(next(), 10);
				if (Number.isNaN(value) || value < 0) throw new Error("--max-tool-output needs a number of 0 or more");
				options.maxToolOutput = value;
				break;
			}
			case "--name": options.name = next(); break;
			case "--sessions-root": options.sessionsRoot = resolve(next()); break;
			case "--projects-root": options.projectsRoot = resolve(next()); break;
			case "--pi-package": options.piPackage = resolve(next()); break;
			case "--dry-run": options.dryRun = true; break;
			case "--list": options.list = true; break;
			case "-h": case "--help": options.help = true; break;
			case "-v": case "--version": options.version = true; break;
			default: throw new Error(`Unknown option or direction: ${arg}`);
		}
	}
	return options;
}

async function version(): Promise<string> {
	const here = dirname(fileURLToPath(import.meta.url));
	const parsed: unknown = JSON.parse(await readFile(join(here, "..", "package.json"), "utf8"));
	return typeof parsed === "object" && parsed !== null && "version" in parsed && typeof parsed.version === "string"
		? parsed.version
		: "unknown";
}

function notes(transcript: Transcript): string[] {
	return transcript.notes.map((note) => `  ${note.code}${note.detail === "" ? "" : ` (${note.detail})`}: ${note.count}`);
}

function piReport(transcript: Transcript, options: Options): string[] {
	const { stats } = toPiEntries(transcript, { preserveTools: options.preserveTools, maxToolOutputChars: options.maxToolOutput });
	const lines = [`  ${stats.messages} messages, ${stats.toolsMapped} tool calls mapped, ${stats.toolsDegraded} degraded to text`];
	if (stats.metaEntries > 0) lines.push(`  ${stats.metaEntries} harness records kept as pi custom entries`);
	if (stats.resultsSynthesized > 0) lines.push(`  ${stats.resultsSynthesized} tool calls had no recorded result`);
	if (stats.resultsOrphaned > 0) lines.push(`  ${stats.resultsOrphaned} tool results had no matching call`);
	if (stats.resultsTruncated > 0) lines.push(`  ${stats.resultsTruncated} tool results truncated`);
	if (stats.argumentsLost.length > 0) lines.push(`  arguments without a pi equivalent: ${stats.argumentsLost.join(", ")}`);
	return [...lines, ...notes(transcript)];
}

function claudeReport(transcript: Transcript, options: Options): string[] {
	const { stats } = toClaudeRecords(transcript, {
		preserveTools: options.preserveTools,
		maxToolOutputChars: options.maxToolOutput ?? CLAUDE_MAX_TOOL_OUTPUT,
		...(options.name === undefined ? {} : { title: options.name }),
	});
	const lines = [`  ${stats.messages} messages, ${stats.toolsMapped} tool calls mapped, ${stats.toolsDegraded} degraded to text`];
	if (stats.metaDropped > 0) lines.push(`  ${stats.metaDropped} pi harness records dropped from Claude's context`);
	if (stats.thinkingDegraded > 0) lines.push(`  ${stats.thinkingDegraded} unsigned thinking blocks kept as ordinary text`);
	if (stats.resultsSynthesized > 0) lines.push(`  ${stats.resultsSynthesized} tool calls had no recorded result`);
	if (stats.resultsOrphaned > 0) lines.push(`  ${stats.resultsOrphaned} tool results had no matching call`);
	if (stats.resultsTruncated > 0) lines.push(`  ${stats.resultsTruncated} tool results truncated`);
	if (stats.argumentsLost.length > 0) lines.push(`  arguments without a Claude equivalent: ${stats.argumentsLost.join(", ")}`);
	return [...lines, ...notes(transcript)];
}

async function listSource(options: Options): Promise<void> {
	const sessions = options.direction === "claude-to-pi"
		? await findClaudeSessions(options.cwd, options.projectsRoot)
		: await findPiSessions(options.cwd, options.sessionsRoot);
	if (sessions.length === 0) {
		process.stdout.write(`No ${options.direction === "claude-to-pi" ? "Claude Code" : "pi"} sessions recorded for ${options.cwd}\n`);
		return;
	}
	for (const session of sessions) {
		const when = new Date(session.modifiedAt).toISOString().replace("T", " ").slice(0, 16);
		process.stdout.write(`${session.sessionId.slice(0, 8)}  ${when}  ${session.title ?? session.firstPrompt ?? ""}\n`);
	}
}

async function run(argv: string[]): Promise<number> {
	const options = parseArgs(argv);
	if (options.help) { process.stdout.write(USAGE); return 0; }
	if (options.version) { process.stdout.write(`${await version()}\n`); return 0; }
	if (options.list) { await listSource(options); return 0; }

	if (options.direction === "claude-to-pi") {
		const source = await resolveClaudeSession(options.cwd, options.session, options.projectsRoot);
		const parsed = await readClaudeSessionFile(source.path, { keepSystemReminders: options.keepReminders });
		const transcript = options.digest ? digestTranscript(parsed) : parsed;
		if (options.dryRun) {
			process.stdout.write(`${source.path}\n${piReport(transcript, options).join("\n")}\n  nothing written (--dry-run)\n`);
			return 0;
		}
		const result = await writeToPi(transcript, {
			preserveTools: options.preserveTools,
			maxToolOutputChars: options.maxToolOutput,
			...(options.name === undefined ? {} : { name: options.name }),
			...(options.sessionsRoot === undefined ? {} : { sessionsRoot: options.sessionsRoot }),
			...(options.piPackage === undefined ? {} : { piPackage: options.piPackage }),
		});
		process.stdout.write(`${source.path}\n  -> ${result.path}\n${piReport(transcript, options).join("\n")}\n`);
		process.stdout.write(`  written by pi ${result.writtenBy.version} at ${result.writtenBy.origin}\n`);
		process.stdout.write(`\nResume it:\n  cd ${transcript.cwd} && pi --session ${result.sessionId.slice(0, 8)}\n`);
		return 0;
	}

	const source = await resolvePiSession(options.cwd, options.session, options.sessionsRoot);
	const parsed = await readPiSessionFile(source.path);
	const transcript = options.digest ? digestTranscript(parsed) : parsed;
	if (options.dryRun) {
		process.stdout.write(`${source.path}\n${claudeReport(transcript, options).join("\n")}\n  nothing written (--dry-run)\n`);
		return 0;
	}
	const result = await writeToClaudeCode(transcript, {
		preserveTools: options.preserveTools,
		maxToolOutputChars: options.maxToolOutput,
		...(options.name === undefined ? {} : { title: options.name }),
		...(options.projectsRoot === undefined ? {} : { projectsRoot: options.projectsRoot }),
	});
	process.stdout.write(`${source.path}\n  -> ${result.path}\n${claudeReport(transcript, options).join("\n")}\n`);
	process.stdout.write(`\nResume it:\n  cd ${transcript.cwd} && claude --resume ${result.sessionId}\n`);
	return 0;
}

run(process.argv.slice(2)).then(
	(code) => { process.exitCode = code; },
	(error: unknown) => {
		process.stderr.write(`harnext: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	},
);
