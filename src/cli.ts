#!/usr/bin/env node
/** harnext command line. */

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { markAlive } from "./alive.js";
import { digestTranscript } from "./digest.js";
import {
	HARNESSES,
	HARNESS_LABELS,
	currentChatFromEnvironment,
	findAllChats,
	findRepoChats,
	inspectChat,
	installedHarnesses,
	readChat,
	resolveCurrentChat,
	resumeCommandFor,
	searchAllChats,
	shortProject,
	writeChat,
	type ChatInfo,
	type ChatSearchHit,
	type HarnessId,
} from "./harnesses.js";
import { harnessAdapter } from "./adapters/index.js";
import { runGoalLoop, type GoalRoundEvent } from "./goal.js";
import { execFile } from "node:child_process";
import { postToHypertext, type HypertextExpiry } from "./hypertext.js";
import type { Transcript } from "./ir.js";
import {
	buildPromptExport,
	renderPromptExport,
	splitPromptExportForHtml,
	type ExportFormat,
	type ExportMode,
	writePromptExport,
} from "./prompt-export.js";
import { findClaudeSessions, readClaudeSessionFile, resolveClaudeSession } from "./readers/claude-code.js";
import { findPiSessions, readPiSessionFile, resolvePiSession } from "./readers/pi.js";
import {
	DEFAULT_MAX_TOOL_OUTPUT_CHARS as CLAUDE_MAX_TOOL_OUTPUT,
	toClaudeRecords,
	writeToClaudeCode,
} from "./writers/claude-code.js";
import { defaultStateRoot, runWatchdog, syncChat, type WatchdogEvent } from "./sync.js";
import { configureTellAgent, defaultConfigPath, shouldTellAgent, withSwitchNotice, type TellAgentMode } from "./switch-notice.js";
import { openCommandInNewTerminal } from "./terminal.js";
import { DEFAULT_MAX_TOOL_OUTPUT_CHARS, toPiEntries, writeToPi } from "./writers/pi.js";

type Direction = "claude-to-pi" | "pi-to-claude";
type Operation = "browse" | "chats" | "all" | "search" | "sync" | "watchdog" | "transfer" | "export" | "config" | "goal";
type ExportSource = HarnessId;

interface Options {
	operation: Operation;
	direction: Direction;
	exportSource: ExportSource;
	exportMode: ExportMode;
	exportFormat: ExportFormat;
	output?: string;
	redact: boolean;
	smartModel?: string;
	postHypertext: boolean;
	hypertextExpires?: HypertextExpiry;
	hypertextMaxViews?: number;
	hypertextPassword?: string;
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
	alive: boolean;
	to?: HarnessId | "all";
	intervalMs: number;
	tellAgentMode?: TellAgentMode;
	goal?: string;
	judge?: HarnessId;
	maxRounds: number;
	yolo: boolean;
	query?: string;
}

const USAGE = `harnext - switch and sync coding-agent chats

Usage:
  harnext [options]                  Choose any chat in this repo, then a destination
  harnext chats [alive]              Choose any chat on this system and open it in a new terminal
  harnext all [alive]                List every chat, optionally only confirmed live chats
  harnext search "<term>" [alive]    Find every chat that mentions the term, then open one
  harnext sync [options]             Copy the current chat into every installed harness
  harnext watchdog [options]         Keep one sync group current until stopped or conflicted
  harnext config                     Configure the receiving-agent switch notice
  harnext goal "<goal>" [options]    Direct a worker chat until the goal is verifiably reached
  harnext claude-to-pi [options]     Explicit Claude Code to pi transfer
  harnext pi-to-claude [options]     Explicit pi to Claude Code transfer
  harnext export [options]           Export user prompt history

Harnesses: claude, pi, omp, codex

Selection and sync options:
  --to <harness|all>              Skip the destination picker
  --session <path|id>             Select a source session by path or id prefix
  --interval <milliseconds>       Watchdog scan interval (default: 1500)
  --tell-agent <ask|always|never>  Set switch-notice behavior with harnext config

Goal options:
  --goal <goal>                   The goal, instead of the positional argument
  --judge <harness>               Harness that runs the director (default: the worker's harness)
  --max-rounds <n>                Safety cap on director rounds (default: 12)
  --yolo                          Let the worker run tools without approval prompts

Export options:
  --from <harness>                Source harness (default: claude)
  --mode <raw|smart>              Exact prompts or OpenRouter-cleaned replacements (default: raw)
  --format <html|markdown|text>    Output format (default: markdown)
  --output <path|->               Output path, or - for stdout
  --redact <on|off>               Local profanity/slur redaction (default: on)
  --smart-model <model>           OpenRouter model id; smart mode also needs OPENROUTER_API_KEY
  --post hypertext                Publish an HTML rendering to hypertext.one
  --expires <1h|1d|7d|30d|60d|90d>  hypertext.one lifetime (default: 30d)
  --max-views <number>            Optional hypertext.one view limit
  --password <value>              Optional hypertext.one reader password

Shared options:
  --cwd <dir>                     Project directory (default: the current directory)
  --digest                        Import one summary message instead of the full transcript
  --keep-reminders                Keep Claude's <system-reminder> blocks in user turns
  --preserve-tools                Keep target-unknown tool calls (can break resume)
  --max-tool-output <chars>       Cap on a single tool result (default: ${DEFAULT_MAX_TOOL_OUTPUT_CHARS}, 0 disables)
  --name <name>                   Display name/title for the imported session
  --sessions-root <dir>           pi sessions root for legacy transfer commands
  --projects-root <dir>           Claude projects root for legacy transfer commands
  --pi-package <dir>              Write pi with this package for legacy transfers
  --dry-run                       Report the import and write nothing
  --list                          List source sessions for a legacy transfer
  -h, --help                      Show this help
  -v, --version                   Show the version

Don't see your harness? https://github.com/AbhinavMir/harnext/blob/main/CONTRIBUTING.md
`;

function parseArgs(argv: string[]): Options {
	const options: Options = {
		operation: "browse",
		direction: "claude-to-pi",
		exportSource: "claude",
		exportMode: "raw",
		exportFormat: "markdown",
		redact: true,
		postHypertext: false,
		cwd: process.cwd(),
		digest: false,
		keepReminders: false,
		preserveTools: false,
		maxToolOutput: DEFAULT_MAX_TOOL_OUTPUT_CHARS,
		dryRun: false,
		list: false,
		help: false,
		version: false,
		alive: false,
		intervalMs: 1500,
		maxRounds: 12,
		yolo: false,
	};

	let start = 0;
	const command = argv[0];
	if (command === "export") {
		options.operation = "export";
		start = 1;
	} else if (command === "chats" || command === "all") {
		options.operation = command;
		start = 1;
		if (argv[1] === "alive") { options.alive = true; start = 2; }
	} else if (command === "search") {
		options.operation = "search";
		start = 1;
		if (argv[1] !== undefined && !argv[1].startsWith("-")) { options.query = argv[1]; start = 2; }
		if (argv[start] === "alive") { options.alive = true; start += 1; }
	} else if (command === "sync") {
		options.operation = "sync";
		start = 1;
	} else if (command === "watchdog") {
		options.operation = "watchdog";
		start = 1;
	} else if (command === "config") {
		options.operation = "config";
		start = 1;
	} else if (command === "goal") {
		options.operation = "goal";
		start = 1;
		if (argv[1] !== undefined && !argv[1].startsWith("-")) { options.goal = argv[1]; start = 2; }
	} else if (command === "claude-to-pi" || command === "to-pi") {
		options.operation = "transfer";
		options.direction = "claude-to-pi";
		start = 1;
	} else if (command === "pi-to-claude" || command === "to-claude") {
		options.operation = "transfer";
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
			case "--from": {
				const value = next();
				if (!HARNESSES.includes(value as HarnessId)) throw new Error("--from must be claude, pi, omp, or codex");
				options.exportSource = value as HarnessId;
				break;
			}
			case "--to": {
				const value = next();
				if (value !== "all" && !HARNESSES.includes(value as HarnessId)) throw new Error("--to must be claude, pi, omp, codex, or all");
				options.to = value as HarnessId | "all";
				break;
			}
			case "--interval": {
				const value = Number.parseInt(next(), 10);
				if (!Number.isSafeInteger(value) || value < 250) throw new Error("--interval must be at least 250 milliseconds");
				options.intervalMs = value;
				break;
			}
			case "--tell-agent": {
				const value = next();
				if (value !== "ask" && value !== "always" && value !== "never") throw new Error("--tell-agent must be ask, always, or never");
				options.tellAgentMode = value;
				break;
			}
			case "--goal": options.goal = next(); break;
			case "--judge": {
				const value = next();
				if (!HARNESSES.includes(value as HarnessId)) throw new Error("--judge must be claude, pi, omp, or codex");
				options.judge = value as HarnessId;
				break;
			}
			case "--max-rounds": {
				const value = Number.parseInt(next(), 10);
				if (!Number.isSafeInteger(value) || value < 1) throw new Error("--max-rounds must be a positive integer");
				options.maxRounds = value;
				break;
			}
			case "--yolo": options.yolo = true; break;
			case "--mode": {
				const value = next();
				if (value !== "raw" && value !== "smart") throw new Error("--mode must be raw or smart");
				options.exportMode = value;
				break;
			}
			case "--format": {
				const value = next();
				if (value !== "html" && value !== "markdown" && value !== "text") throw new Error("--format must be html, markdown, or text");
				options.exportFormat = value;
				break;
			}
			case "--output": options.output = next(); break;
			case "--redact": {
				const value = next();
				if (value !== "on" && value !== "off") throw new Error("--redact must be on or off");
				options.redact = value === "on";
				break;
			}
			case "--smart-model": options.smartModel = next(); break;
			case "--post": {
				const value = next();
				if (value !== "hypertext") throw new Error("--post currently supports only hypertext");
				options.postHypertext = true;
				break;
			}
			case "--expires": {
				const value = next();
				if (!["1h", "1d", "7d", "30d", "60d", "90d"].includes(value)) throw new Error("invalid --expires value");
				options.hypertextExpires = value as HypertextExpiry;
				break;
			}
			case "--max-views": {
				const value = Number.parseInt(next(), 10);
				if (!Number.isSafeInteger(value) || value <= 0) throw new Error("--max-views must be a positive integer");
				options.hypertextMaxViews = value;
				break;
			}
			case "--password": options.hypertextPassword = next(); break;
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

function exportExtension(format: ExportFormat): string {
	return format === "markdown" ? "md" : format === "text" ? "txt" : "html";
}

async function resolveHarnessSource(options: Options, harness = options.exportSource): Promise<ChatInfo> {
	if (options.session !== undefined && (options.session.includes("/") || options.session.endsWith(".jsonl"))) {
		const found = await inspectChat(harness, resolve(options.session));
		if (found === undefined) throw new Error(`Not a readable ${HARNESS_LABELS[harness]} session: ${options.session}`);
		return found;
	}
	const sessions = (await findRepoChats(options.cwd)).filter((chat) => chat.harness === harness);
	if (options.session !== undefined) {
		const matches = sessions.filter((chat) => chat.sessionId.startsWith(options.session as string));
		if (matches.length === 0) throw new Error(`No ${HARNESS_LABELS[harness]} session in ${options.cwd} with id starting ${options.session}`);
		if (matches.length > 1) throw new Error(`Session id ${options.session} is ambiguous: ${matches.length} matches`);
		return matches[0] as ChatInfo;
	}
	if (sessions.length === 0) throw new Error(`No ${HARNESS_LABELS[harness]} sessions recorded for ${options.cwd}`);
	return sessions[0] as ChatInfo;
}

async function runExport(options: Options): Promise<number> {
	if (options.list) {
		const sessions = (await findRepoChats(options.cwd)).filter((chat) => chat.harness === options.exportSource);
		if (sessions.length === 0) {
			process.stdout.write(`No ${HARNESS_LABELS[options.exportSource]} sessions recorded for ${options.cwd}\n`);
			return 0;
		}
		for (const session of sessions) {
			const when = new Date(session.modifiedAt).toISOString().replace("T", " ").slice(0, 16);
			process.stdout.write(`${session.sessionId.slice(0, 8)}  ${when}  ${session.title ?? session.firstPrompt ?? ""}\n`);
		}
		return 0;
	}
	const source = await resolveHarnessSource(options);
	const transcript = await readChat(source);
	const record = await buildPromptExport(transcript, {
		mode: options.exportMode,
		redact: options.redact,
		...(options.exportMode === "smart" ? { smart: { model: options.smartModel } } : {}),
	});
	const content = renderPromptExport(record, options.exportFormat);
	const output = options.output ?? resolve(options.cwd, `prompt-history-${record.sourceSessionId.slice(0, 8)}.${exportExtension(options.exportFormat)}`);
	if (output === "-") process.stdout.write(content);
	else {
		await writePromptExport(resolve(output), content);
		process.stdout.write(`${source.path}\n  -> ${resolve(output)}\n`);
	}
	process.stderr.write(`${record.prompts.length} prompts exported (${record.mode}, redaction ${record.redacted ? "on" : "off"}, ${record.redactionMatches} matches)\n`);

	if (options.postHypertext) {
		const pages = splitPromptExportForHtml(record);
		for (const [offset, page] of pages.entries()) {
			const suffix = pages.length === 1 ? "" : ` · part ${offset + 1}/${pages.length}`;
			const posted = await postToHypertext(renderPromptExport(page, "html"), {
				title: `${options.name ?? `Prompt history · ${record.source}`}${suffix}`,
				...(options.hypertextExpires === undefined ? {} : { expires: options.hypertextExpires }),
				...(options.hypertextMaxViews === undefined ? {} : { maxViews: options.hypertextMaxViews }),
				...(options.hypertextPassword === undefined ? {} : { password: options.hypertextPassword }),
			});
			process.stderr.write(`Published${suffix}: ${posted.url}\nOwner token (shown once; needed to edit/delete): ${posted.ownerToken}\n`);
		}
	}
	return 0;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const PROJECT_WIDTH = 16;

function whenLabel(ms: number): string {
	const date = new Date(ms);
	const two = (value: number): string => String(value).padStart(2, "0");
	const day = `${MONTHS[date.getMonth()]} ${two(date.getDate())}`;
	return date.getFullYear() === new Date().getFullYear() ? `${day} ${two(date.getHours())}:${two(date.getMinutes())}` : `${day} ${date.getFullYear()}`;
}

function chatTitle(chat: ChatInfo): string {
	const raw = chat.title ?? chat.firstPrompt ?? "";
	const command = /<command-name>([^<]*)<\/command-name>/.exec(raw);
	const args = /<command-args>([^<]*)<\/command-args>/.exec(raw);
	const text = (command === null ? raw.replace(/<[^>]+>/g, " ") : `${command[1] ?? ""} ${args?.[1] ?? ""}`).replace(/\s+/g, " ").trim();
	const title = text === "" ? "(untitled)" : text;
	return chat.archived === true ? `[archived] ${title}` : title;
}

function fit(text: string, width: number): string {
	return text.length <= width ? text.padEnd(width) : `${text.slice(0, Math.max(0, width - 1))}…`;
}

const useColor = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;
const paint = (open: string, close: string) => (text: string): string => useColor ? `${open}${text}${close}` : text;
const ansi = {
	dim: paint("\x1b[2m", "\x1b[22m"),
	bold: paint("\x1b[1m", "\x1b[22m"),
	cyan: paint("\x1b[36m", "\x1b[39m"),
	green: paint("\x1b[32m", "\x1b[39m"),
	yellow: paint("\x1b[33m", "\x1b[39m"),
};

/** Reverse-video the matched term everywhere it appears in a snippet. */
function highlight(text: string, term: string): string {
	if (!useColor || term === "") return text;
	const lower = text.toLowerCase();
	const needle = term.toLowerCase();
	let out = "";
	let from = 0;
	for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, at + needle.length)) {
		out += text.slice(from, at) + `\x1b[7m${text.slice(at, at + needle.length)}\x1b[27m`;
		from = at + needle.length;
	}
	return out + text.slice(from);
}

/** A stderr spinner that reports search progress without polluting stdout. */
function startSearchProgress(term: string): { update: (done: number, total: number) => void; finish: (found: number) => void } {
	if (process.stderr.isTTY !== true || process.env.NO_COLOR !== undefined) {
		process.stderr.write(`Searching every chat for "${term}"...\n`);
		return { update: () => {}, finish: () => {} };
	}
	const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
	let frame = 0;
	let label = `scanning chats for "${term}"...`;
	const timer = setInterval(() => {
		frame = (frame + 1) % frames.length;
		process.stderr.write(`\r\x1b[2K${ansi.cyan(frames[frame] as string)} ${label}`);
	}, 80);
	return {
		update: (done, total) => { label = `scanned ${done}/${total} chats for "${term}"...`; },
		finish: (found) => {
			clearInterval(timer);
			process.stderr.write(`\r\x1b[2K${ansi.green("✓")} ${found} ${found === 1 ? "chat" : "chats"} mention "${term}"\n`);
		},
	};
}

interface ChatColumns { indexed: boolean; project: boolean; title: number }

function chatColumns(chats: ChatInfo[], indexed: boolean): ChatColumns {
	const project = new Set(chats.map((chat) => resolve(chat.cwd))).size > 1;
	const fixed = (indexed ? 5 : 0) + 2 + 12 + 9 + 13 + (project ? PROJECT_WIDTH + 1 : 0);
	const width = process.stdout.columns ?? 120;
	return { indexed, project, title: Math.max(24, width - fixed - 1) };
}

function chatHeader(columns: ChatColumns): string {
	const index = columns.indexed ? "  #  " : "";
	const project = columns.project ? `${"project".padEnd(PROJECT_WIDTH)} ` : "";
	return `${index}  ${"harness".padEnd(11)} ${"id".padEnd(8)} ${"modified".padEnd(12)} ${project}title`;
}

function chatLine(chat: ChatInfo, columns: ChatColumns, index?: number): string {
	const number = index === undefined ? "" : `${String(index).padStart(3)}  `;
	const live = chat.alive === true ? "●" : " ";
	const project = columns.project ? `${fit(shortProject(chat.cwd), PROJECT_WIDTH)} ` : "";
	return `${number}${live} ${HARNESS_LABELS[chat.harness].padEnd(11)} ${chat.sessionId.slice(0, 8)} ${whenLabel(chat.modifiedAt).padEnd(12)} ${project}${fit(chatTitle(chat), columns.title).trimEnd()}`;
}

function chatChoices(chats: ChatInfo[]): { choices: { label: string; value: ChatInfo }[]; header: string } {
	const columns = chatColumns(chats, true);
	return { choices: chats.map((chat) => ({ label: chatLine(chat, columns), value: chat })), header: chatHeader(columns) };
}

function printChats(chats: ChatInfo[], indexed = false): void {
	if (chats.length === 0) {
		process.stdout.write("No matching chats.\n");
		return;
	}
	const columns = chatColumns(chats, indexed);
	if (process.stdout.isTTY) process.stdout.write(`${chatHeader(columns)}\n`);
	for (const [offset, chat] of chats.entries()) process.stdout.write(`${chatLine(chat, columns, indexed ? offset + 1 : undefined)}\n`);
}

async function choose<T>(label: string, choices: { label: string; value: T }[], header?: string): Promise<T> {
	if (!process.stdin.isTTY) throw new Error(`${label} needs an interactive terminal or an explicit option`);
	if (header !== undefined) process.stdout.write(`${header}\n`);
	for (const [offset, choice] of choices.entries()) process.stdout.write(`${String(offset + 1).padStart(3)}  ${choice.label}\n`);
	const readline = createInterface({ input: process.stdin, output: process.stdout });
	try {
		while (true) {
			const answer = (await readline.question(`${label} [1-${choices.length}]: `)).trim();
			const selected = Number.parseInt(answer, 10);
			if (Number.isSafeInteger(selected) && selected >= 1 && selected <= choices.length) return (choices[selected - 1] as { value: T }).value;
			process.stderr.write("Enter one of the listed numbers.\n");
		}
	} finally { readline.close(); }
}

async function selectedRepoChat(options: Options, preferCurrent: boolean): Promise<ChatInfo> {
	const chats = await findRepoChats(options.cwd);
	if (chats.length === 0) throw new Error(`No supported harness chats recorded for ${options.cwd}`);
	if (options.session !== undefined) {
		const absolute = options.session.includes("/") ? resolve(options.session) : undefined;
		const matches = chats.filter((chat) => absolute === undefined ? chat.sessionId.startsWith(options.session as string) : resolve(chat.path) === absolute);
		if (matches.length === 0) throw new Error(`No chat in ${options.cwd} matches ${options.session}`);
		if (matches.length > 1) throw new Error(`Chat id ${options.session} is ambiguous across ${matches.length} harnesses`);
		return matches[0] as ChatInfo;
	}
	if (preferCurrent && currentChatFromEnvironment() !== undefined) {
		const current = await resolveCurrentChat(options.cwd, chats);
		if (current !== undefined) return current;
	}
	if (!process.stdin.isTTY) return chats[0] as ChatInfo;
	const listed = chatChoices(chats);
	return choose("Choose chat", listed.choices, listed.header);
}

async function reportSync(result: Awaited<ReturnType<typeof syncChat>>): Promise<void> {
	process.stdout.write(`Source: ${HARNESS_LABELS[result.source.harness]} ${result.source.sessionId.slice(0, 8)} · ${result.source.path}\n`);
	for (const member of result.written) process.stdout.write(`${HARNESS_LABELS[member.harness]}: synced · ${member.path}\n  ${resumeCommandFor(member.harness, member.sessionId, result.group.cwd)}\n`);
	for (const member of result.skippedAlive) process.stdout.write(`${HARNESS_LABELS[member.harness]}: open; left unchanged\n`);
	for (const harness of result.unavailable) process.stdout.write(`${HARNESS_LABELS[harness]}: not installed\n`);
	process.stdout.write(`State: ${join(defaultStateRoot(), "groups", `${result.group.id}.json`)}\n`);
}

async function runBrowse(options: Options): Promise<number> {
	const chats = await markAlive(await findRepoChats(options.cwd));
	if (chats.length === 0) { printChats(chats); return 0; }
	if (!process.stdin.isTTY && options.to === undefined) { printChats(chats); return 0; }
	let source: ChatInfo;
	if (options.session !== undefined) source = await selectedRepoChat(options, false);
	else if (!process.stdin.isTTY) source = chats[0] as ChatInfo;
	else {
		const listed = chatChoices(chats);
		source = await choose("Choose chat", listed.choices, listed.header);
	}
	const installed = (await installedHarnesses()).filter((harness) => harness !== source.harness);
	if (installed.length === 0) throw new Error("No other supported harness is installed");
	const target = options.to ?? await choose<HarnessId | "all">("Copy to", [
		...installed.map((harness) => ({ label: HARNESS_LABELS[harness], value: harness as HarnessId | "all" })),
		{ label: "All installed harnesses", value: "all" },
	]);
	if (target === "all") {
		if (options.dryRun) {
			process.stdout.write(`${source.path}\n  would sync to: ${installed.map((harness) => HARNESS_LABELS[harness]).join(", ")}\n  nothing written (--dry-run)\n`);
			return 0;
		}
		const tellAgent = await shouldTellAgent();
		await reportSync(await syncChat(source, { tellAgent }));
		return 0;
	}
	if (!installed.includes(target)) throw new Error(`${HARNESS_LABELS[target]} is not installed or is the source harness`);
	if (options.dryRun) {
		process.stdout.write(`${source.path}\n  would copy to ${HARNESS_LABELS[target]}\n  nothing written (--dry-run)\n`);
		return 0;
	}
	let transcript = options.digest ? digestTranscript(await readChat(source)) : await readChat(source);
	if (await shouldTellAgent()) transcript = withSwitchNotice(transcript, source.harness);
	const result = await writeChat(target, transcript, { name: options.name ?? transcript.title });
	process.stdout.write(`${source.path}\n  -> ${result.path}\n\nResume it:\n  ${result.resumeCommand}\n`);
	return 0;
}

async function allChats(options: Options): Promise<ChatInfo[]> {
	let chats = await markAlive(await findAllChats());
	if (options.alive) chats = chats.filter((chat) => chat.alive === true);
	return chats;
}

async function runAllChats(options: Options): Promise<number> {
	printChats(await allChats(options));
	return 0;
}

async function runChats(options: Options): Promise<number> {
	const chats = await allChats(options);
	if (chats.length === 0) { printChats(chats); return 0; }
	if (!process.stdin.isTTY && options.session === undefined) { printChats(chats); return 0; }
	let chat: ChatInfo;
	if (options.session !== undefined) {
		const absolute = options.session.includes("/") ? resolve(options.session) : undefined;
		const matches = chats.filter((candidate) => absolute === undefined ? candidate.sessionId.startsWith(options.session as string) : resolve(candidate.path) === absolute);
		if (matches.length === 0) throw new Error(`No chat on this system matches ${options.session}`);
		if (matches.length > 1) throw new Error(`Chat id ${options.session} is ambiguous across ${matches.length} harnesses`);
		chat = matches[0] as ChatInfo;
	} else {
		const listed = chatChoices(chats);
		chat = await choose("Open chat", listed.choices, listed.header);
	}
	return openChat(chat, options.dryRun);
}

async function openChat(chat: ChatInfo, dryRun: boolean): Promise<number> {
	const command = resumeCommandFor(chat.harness, chat.sessionId, chat.cwd);
	if (dryRun) {
		process.stdout.write(`${command}\n  nothing opened (--dry-run)\n`);
		return 0;
	}
	if (!(await installedHarnesses()).includes(chat.harness)) throw new Error(`${HARNESS_LABELS[chat.harness]} is not installed`);
	const launched = await openCommandInNewTerminal(command);
	process.stdout.write(`Opened ${HARNESS_LABELS[chat.harness]} ${chat.sessionId.slice(0, 8)} in ${launched.terminal}.\n`);
	return 0;
}

/** Two lines per hit: a colored chat line, then a match count and the highlighted snippet. */
function renderSearchItem(hit: ChatSearchHit, columns: ChatColumns, term: string, index?: number): string {
	const number = index === undefined ? "" : `${ansi.bold(ansi.cyan(String(index).padStart(3)))}  `;
	const live = hit.alive === true ? ansi.green("●") : " ";
	const harness = ansi.dim(HARNESS_LABELS[hit.harness].padEnd(11));
	const id = ansi.dim(hit.sessionId.slice(0, 8));
	const when = ansi.dim(whenLabel(hit.modifiedAt).padEnd(12));
	const project = columns.project ? `${ansi.dim(fit(shortProject(hit.cwd), PROJECT_WIDTH))} ` : "";
	const title = fit(chatTitle(hit), columns.title).trimEnd();
	const line = `${number}${live} ${harness} ${id} ${when} ${project}${title}`;
	const count = ansi.yellow(`${hit.matchCount}×`.padStart(5));
	return `${line}\n       ${count}  ${highlight(hit.snippet, term)}`;
}

function searchHeading(term: string, count: number): string {
	return ansi.bold(`${count} ${count === 1 ? "chat" : "chats"} mention "${term}"`);
}

function printSearchHits(hits: ChatSearchHit[], term: string): void {
	if (hits.length === 0) { process.stdout.write(`No chats mention "${term}".\n`); return; }
	const columns = chatColumns(hits, false);
	if (process.stdout.isTTY) process.stdout.write(`${searchHeading(term, hits.length)}\n`);
	for (const hit of hits) process.stdout.write(`${renderSearchItem(hit, columns, term)}\n`);
}

async function chooseHit(hits: ChatSearchHit[], term: string): Promise<ChatSearchHit | undefined> {
	const columns = chatColumns(hits, true);
	process.stdout.write(`${searchHeading(term, hits.length)}\n`);
	for (const [offset, hit] of hits.entries()) process.stdout.write(`${renderSearchItem(hit, columns, term, offset + 1)}\n`);
	const readline = createInterface({ input: process.stdin, output: process.stdout });
	try {
		while (true) {
			const answer = (await readline.question(`\nOpen which chat? ${ansi.dim(`[1-${hits.length}, Enter to cancel]`)} `)).trim();
			if (answer === "" || answer.toLowerCase() === "q") return undefined;
			const selected = Number.parseInt(answer, 10);
			if (Number.isSafeInteger(selected) && selected >= 1 && selected <= hits.length) return hits[selected - 1] as ChatSearchHit;
			process.stderr.write("Enter a listed number, or press Enter to cancel.\n");
		}
	} finally { readline.close(); }
}

async function runSearch(options: Options): Promise<number> {
	if (options.query === undefined || options.query === "") throw new Error('search needs a term, for example: harnext search "auth bug"');
	const progress = startSearchProgress(options.query);
	let hits = await searchAllChats(options.query, progress.update);
	if (options.alive) hits = (await markAlive(hits)).filter((hit): hit is ChatSearchHit => hit.alive === true);
	progress.finish(hits.length);
	if (hits.length === 0) { process.stdout.write(`No chats mention "${options.query}".\n`); return 0; }
	if (options.session !== undefined) {
		const absolute = options.session.includes("/") ? resolve(options.session) : undefined;
		const matches = hits.filter((hit) => absolute === undefined ? hit.sessionId.startsWith(options.session as string) : resolve(hit.path) === absolute);
		if (matches.length === 0) throw new Error(`No matching chat has id ${options.session}`);
		if (matches.length > 1) throw new Error(`Chat id ${options.session} is ambiguous across ${matches.length} chats`);
		return openChat(matches[0] as ChatSearchHit, options.dryRun);
	}
	if (!process.stdin.isTTY) { printSearchHits(hits, options.query); return 0; }
	const chat = await chooseHit(hits, options.query);
	if (chat === undefined) { process.stdout.write("Cancelled.\n"); return 0; }
	return openChat(chat, options.dryRun);
}

function watchdogMessage(event: WatchdogEvent): void {
	if (event.type === "synced") process.stdout.write(`${new Date().toISOString()}  ${HARNESS_LABELS[event.source?.harness as HarnessId]} -> ${event.targets?.map((target) => HARNESS_LABELS[target.harness]).join(", ")}\n`);
	if (event.type === "waiting") process.stdout.write(`${new Date().toISOString()}  waiting: ${event.targets?.map((target) => HARNESS_LABELS[target.harness]).join(", ")} is open\n`);
}

function runHeadless(spec: { command: string; args: string[]; input?: string }, cwd: string): Promise<string> {
	return new Promise((resolve) => {
		const child = execFile(spec.command, spec.args, { cwd, maxBuffer: 64 * 1024 * 1024, timeout: 900_000 }, (error, stdout, stderr) => {
			const combined = `${stdout ?? ""}${stderr ? `\n${stderr}` : ""}`.trim();
			resolve(combined === "" && error !== null ? `[harnext] ${spec.command} exited without output: ${error.message}` : combined);
		});
		if (spec.input !== undefined) child.stdin?.end(spec.input);
	});
}

async function runGoal(options: Options): Promise<number> {
	const goal = options.goal;
	if (goal === undefined || goal.trim() === "") throw new Error(`Provide the goal: harnext goal "<goal>" or --goal <goal>`);
	const worker = await selectedRepoChat(options, true);
	const workerAdapter = harnessAdapter(worker.harness);
	const directorAdapter = options.judge === undefined ? workerAdapter : harnessAdapter(options.judge);
	const installed = new Set(await installedHarnesses());
	if (!installed.has(workerAdapter.id)) throw new Error(`${HARNESS_LABELS[workerAdapter.id]} is not installed; it runs the worker session`);
	if (!installed.has(directorAdapter.id)) throw new Error(`${HARNESS_LABELS[directorAdapter.id]} is not installed; it runs the director`);

	process.stderr.write(`Goal loop: ${HARNESS_LABELS[directorAdapter.id]} directs ${HARNESS_LABELS[worker.harness]} ${worker.sessionId.slice(0, 8)} in ${shortProject(worker.cwd)}.\n`);
	process.stderr.write(`Goal: ${goal.trim()}\n`);
	if (!options.yolo) process.stderr.write("Worker runs without --yolo, so tool approvals can stall it. Add --yolo to let it act on its own.\n");

	const onEvent = (event: GoalRoundEvent): void => {
		if (event.phase !== "verdict") return;
		process.stderr.write(`\nRound ${event.round} [${event.done ? "reached" : "continue"}]: ${event.reason}\n`);
		if (!event.done && event.instruction !== undefined) process.stderr.write(`  -> ${event.instruction.replace(/\s+/g, " ").slice(0, 200)}\n`);
	};

	const result = await runGoalLoop({ goal, maxRounds: options.maxRounds }, {
		director: (prompt) => runHeadless(directorAdapter.headless(prompt, { cwd: worker.cwd }), worker.cwd),
		worker: (instruction) => runHeadless(workerAdapter.headless(instruction, { cwd: worker.cwd, sessionId: worker.sessionId, yolo: options.yolo }), worker.cwd),
		onEvent,
	});

	process.stdout.write(`\n${result.reached ? "GOAL REACHED" : "GOAL NOT REACHED"} after ${result.rounds} round(s).\n`);
	process.stdout.write(`${result.reason}\n`);
	process.stdout.write(`Resume the worker: ${resumeCommandFor(worker.harness, worker.sessionId, worker.cwd)}\n`);
	return result.reached ? 0 : 1;
}

async function runConfig(options: Options): Promise<number> {
	const config = await configureTellAgent(options.tellAgentMode);
	process.stdout.write(`Tell receiving agent: ${config.tellAgent}\nConfig: ${defaultConfigPath()}\n`);
	return 0;
}

async function runSyncCommand(options: Options, watchdog: boolean): Promise<number> {
	const source = await selectedRepoChat(options, true);
	if (options.dryRun) {
		const targets = (await installedHarnesses()).filter((harness) => harness !== source.harness);
		process.stdout.write(`${source.path}\n  would ${watchdog ? "watch and sync" : "sync"} to: ${targets.map((harness) => HARNESS_LABELS[harness]).join(", ")}\n  nothing written (--dry-run)\n`);
		return 0;
	}
	const tellAgent = await shouldTellAgent();
	if (!watchdog) {
		await reportSync(await syncChat(source, { tellAgent }));
		return 0;
	}
	process.stdout.write(`Watching ${HARNESS_LABELS[source.harness]} ${source.sessionId.slice(0, 8)} every ${options.intervalMs}ms. Ctrl-C stops it.\n`);
	const controller = new AbortController();
	const stop = (): void => controller.abort();
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
	try {
		await runWatchdog(source, { intervalMs: options.intervalMs, signal: controller.signal, onEvent: watchdogMessage, tellAgent });
	} catch (error) {
		if (!(error instanceof Error && error.name === "AbortError")) throw error;
	} finally {
		process.removeListener("SIGINT", stop);
		process.removeListener("SIGTERM", stop);
	}
	return 0;
}

async function run(argv: string[]): Promise<number> {
	const options = parseArgs(argv);
	if (options.help) { process.stdout.write(USAGE); return 0; }
	if (options.version) { process.stdout.write(`${await version()}\n`); return 0; }
	if (options.operation === "export") return runExport(options);
	if (options.operation === "browse") return runBrowse(options);
	if (options.operation === "chats") return runChats(options);
	if (options.operation === "all") return runAllChats(options);
	if (options.operation === "search") return runSearch(options);
	if (options.operation === "sync") return runSyncCommand(options, false);
	if (options.operation === "watchdog") return runSyncCommand(options, true);
	if (options.operation === "config") return runConfig(options);
	if (options.operation === "goal") return runGoal(options);
	if (options.list) { await listSource(options); return 0; }

	if (options.direction === "claude-to-pi") {
		const source = await resolveClaudeSession(options.cwd, options.session, options.projectsRoot);
		const parsed = await readClaudeSessionFile(source.path, { keepSystemReminders: options.keepReminders });
		let transcript = options.digest ? digestTranscript(parsed) : parsed;
		if (options.dryRun) {
			process.stdout.write(`${source.path}\n${piReport(transcript, options).join("\n")}\n  nothing written (--dry-run)\n`);
			return 0;
		}
		if (await shouldTellAgent()) transcript = withSwitchNotice(transcript, "claude");
		const result = await writeToPi(transcript, {
			preserveTools: options.preserveTools,
			maxToolOutputChars: options.maxToolOutput,
			...(options.name === undefined ? {} : { name: options.name }),
			...(options.sessionsRoot === undefined ? {} : { sessionsRoot: options.sessionsRoot }),
			...(options.piPackage === undefined ? {} : { piPackage: options.piPackage }),
		});
		process.stdout.write(`${source.path}\n  -> ${result.path}\n${piReport(transcript, options).join("\n")}\n`);
		process.stdout.write(`  written by pi ${result.writtenBy.version} at ${result.writtenBy.origin}\n`);
		process.stdout.write(`\nResume it:\n  ${resumeCommandFor("pi", result.sessionId, transcript.cwd)}\n`);
		return 0;
	}

	const source = await resolvePiSession(options.cwd, options.session, options.sessionsRoot);
	const parsed = await readPiSessionFile(source.path);
	let transcript = options.digest ? digestTranscript(parsed) : parsed;
	if (options.dryRun) {
		process.stdout.write(`${source.path}\n${claudeReport(transcript, options).join("\n")}\n  nothing written (--dry-run)\n`);
		return 0;
	}
	if (await shouldTellAgent()) transcript = withSwitchNotice(transcript, "pi");
	const result = await writeToClaudeCode(transcript, {
		preserveTools: options.preserveTools,
		maxToolOutputChars: options.maxToolOutput,
		...(options.name === undefined ? {} : { title: options.name }),
		...(options.projectsRoot === undefined ? {} : { projectsRoot: options.projectsRoot }),
	});
	process.stdout.write(`${source.path}\n  -> ${result.path}\n${claudeReport(transcript, options).join("\n")}\n`);
	process.stdout.write(`\nResume it:\n  ${resumeCommandFor("claude", result.sessionId, transcript.cwd)}\n`);
	return 0;
}

process.stdout.on("error", (error: NodeJS.ErrnoException) => {
	if (error.code === "EPIPE") process.exit(0);
	throw error;
});

run(process.argv.slice(2)).then(
	(code) => { process.exitCode = code; },
	(error: unknown) => {
		process.stderr.write(`harnext: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	},
);
