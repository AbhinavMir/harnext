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
	shortProject,
	writeChat,
	type ChatInfo,
	type HarnessId,
} from "./harnesses.js";
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
import { DEFAULT_MAX_TOOL_OUTPUT_CHARS, toPiEntries, writeToPi } from "./writers/pi.js";

type Direction = "claude-to-pi" | "pi-to-claude";
type Operation = "browse" | "all" | "sync" | "watchdog" | "transfer" | "export";
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
}

const USAGE = `harnext - switch and sync coding-agent chats

Usage:
  harnext [options]                  Choose any chat in this repo, then a destination
  harnext all [alive]                List every chat, optionally only confirmed live chats
  harnext sync [options]             Copy the current chat into every installed harness
  harnext watchdog [options]         Keep one sync group current until stopped or conflicted
  harnext claude-to-pi [options]     Explicit Claude Code to pi transfer
  harnext pi-to-claude [options]     Explicit pi to Claude Code transfer
  harnext export [options]           Export user prompt history

Harnesses: claude, pi, omp, codex

Selection and sync options:
  --to <harness|all>              Skip the destination picker
  --session <path|id>             Select a source session by path or id prefix
  --interval <milliseconds>       Watchdog scan interval (default: 1500)

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
	};

	let start = 0;
	const command = argv[0];
	if (command === "export") {
		options.operation = "export";
		start = 1;
	} else if (command === "all") {
		options.operation = "all";
		start = 1;
		if (argv[1] === "alive") { options.alive = true; start = 2; }
	} else if (command === "sync") {
		options.operation = "sync";
		start = 1;
	} else if (command === "watchdog") {
		options.operation = "watchdog";
		start = 1;
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

function chatLine(chat: ChatInfo, index?: number): string {
	const when = new Date(chat.modifiedAt).toISOString().replace("T", " ").slice(0, 16);
	const number = index === undefined ? "" : `${String(index).padStart(3)}  `;
	const live = chat.alive === true ? "●" : " ";
	const archived = chat.archived === true ? " archived" : "";
	const title = (chat.title ?? chat.firstPrompt ?? "(untitled)").replace(/\s+/g, " ").slice(0, 90);
	return `${number}${live} ${HARNESS_LABELS[chat.harness].padEnd(11)} ${chat.sessionId.slice(0, 8)}  ${when}  ${shortProject(chat.cwd)}${archived}  ${title}`;
}

function printChats(chats: ChatInfo[], indexed = false): void {
	if (chats.length === 0) {
		process.stdout.write("No matching chats.\n");
		return;
	}
	for (const [offset, chat] of chats.entries()) process.stdout.write(`${chatLine(chat, indexed ? offset + 1 : undefined)}\n`);
}

async function choose<T>(label: string, choices: { label: string; value: T }[]): Promise<T> {
	if (!process.stdin.isTTY) throw new Error(`${label} needs an interactive terminal or an explicit option`);
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
	return choose("Choose chat", chats.map((chat) => ({ label: chatLine(chat), value: chat })));
}

function resumeMember(harness: HarnessId, sessionId: string, cwd: string): string {
	switch (harness) {
		case "claude": return `cd ${cwd} && claude --resume ${sessionId}`;
		case "pi": return `cd ${cwd} && pi --session ${sessionId.slice(0, 8)}`;
		case "omp": return `cd ${cwd} && omp --resume ${sessionId.slice(0, 8)}`;
		case "codex": return `cd ${cwd} && codex resume ${sessionId}`;
	}
}

async function reportSync(result: Awaited<ReturnType<typeof syncChat>>): Promise<void> {
	process.stdout.write(`Source: ${HARNESS_LABELS[result.source.harness]} ${result.source.sessionId.slice(0, 8)} · ${result.source.path}\n`);
	for (const member of result.written) process.stdout.write(`${HARNESS_LABELS[member.harness]}: synced · ${member.path}\n  ${resumeMember(member.harness, member.sessionId, result.group.cwd)}\n`);
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
	else source = await choose("Choose chat", chats.map((chat) => ({ label: chatLine(chat), value: chat })));
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
		await reportSync(await syncChat(source));
		return 0;
	}
	if (!installed.includes(target)) throw new Error(`${HARNESS_LABELS[target]} is not installed or is the source harness`);
	if (options.dryRun) {
		process.stdout.write(`${source.path}\n  would copy to ${HARNESS_LABELS[target]}\n  nothing written (--dry-run)\n`);
		return 0;
	}
	const transcript = options.digest ? digestTranscript(await readChat(source)) : await readChat(source);
	const result = await writeChat(target, transcript, { name: options.name ?? transcript.title });
	process.stdout.write(`${source.path}\n  -> ${result.path}\n\nResume it:\n  ${result.resumeCommand}\n`);
	return 0;
}

async function runAllChats(options: Options): Promise<number> {
	let chats = await markAlive(await findAllChats());
	if (options.alive) chats = chats.filter((chat) => chat.alive === true);
	printChats(chats);
	return 0;
}

function watchdogMessage(event: WatchdogEvent): void {
	if (event.type === "synced") process.stdout.write(`${new Date().toISOString()}  ${HARNESS_LABELS[event.source?.harness as HarnessId]} -> ${event.targets?.map((target) => HARNESS_LABELS[target.harness]).join(", ")}\n`);
	if (event.type === "waiting") process.stdout.write(`${new Date().toISOString()}  waiting: ${event.targets?.map((target) => HARNESS_LABELS[target.harness]).join(", ")} is open\n`);
}

async function runSyncCommand(options: Options, watchdog: boolean): Promise<number> {
	const source = await selectedRepoChat(options, true);
	if (options.dryRun) {
		const targets = (await installedHarnesses()).filter((harness) => harness !== source.harness);
		process.stdout.write(`${source.path}\n  would ${watchdog ? "watch and sync" : "sync"} to: ${targets.map((harness) => HARNESS_LABELS[harness]).join(", ")}\n  nothing written (--dry-run)\n`);
		return 0;
	}
	if (!watchdog) {
		await reportSync(await syncChat(source));
		return 0;
	}
	process.stdout.write(`Watching ${HARNESS_LABELS[source.harness]} ${source.sessionId.slice(0, 8)} every ${options.intervalMs}ms. Ctrl-C stops it.\n`);
	const controller = new AbortController();
	const stop = (): void => controller.abort();
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
	try {
		await runWatchdog(source, { intervalMs: options.intervalMs, signal: controller.signal, onEvent: watchdogMessage });
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
	if (options.operation === "all") return runAllChats(options);
	if (options.operation === "sync") return runSyncCommand(options, false);
	if (options.operation === "watchdog") return runSyncCommand(options, true);
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
