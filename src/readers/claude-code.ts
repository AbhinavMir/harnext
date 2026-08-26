/**
 * Reader for Claude Code session files.
 *
 * Claude Code stores one JSONL file per session under
 * `~/.claude/projects/<slug>/<session-id>.jsonl`. The records form a tree:
 * each record has a `uuid` and a `parentUuid`, and a rewind starts a new
 * branch instead of deleting the old one. This reader walks back from the
 * live leaf, so only the branch the user actually kept is converted.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { IrBlock, IrMessage, IrToolCall, Transcript } from "../ir.js";
import { Notes } from "../ir.js";

export const SOURCE_NAME = "claude-code";

const MAX_META_CHARS = 10_000;

export interface ClaudeReadOptions {
	/** Path the text was read from, used only when the file records no session id. */
	sourcePath?: string;
	/**
	 * Keep Claude Code's `<system-reminder>` blocks. They are harness plumbing —
	 * skill listings, tool policy, injected instruction files — addressed to
	 * Claude, and they describe tools and rules the receiving harness does not
	 * have. They are removed by default.
	 */
	keepSystemReminders?: boolean;
}

export interface ClaudeSessionInfo {
	path: string;
	sessionId: string;
	cwd: string;
	modifiedAt: number;
	title?: string;
	firstPrompt?: string;
}

interface ClaudeRecord {
	type?: string;
	uuid?: string;
	parentUuid?: string | null;
	timestamp?: string;
	sessionId?: string;
	cwd?: string;
	isSidechain?: boolean;
	isMeta?: boolean;
	leafUuid?: string;
	subtype?: string;
	title?: string;
	summary?: string;
	content?: unknown;
	message?: {
		role?: string;
		model?: string;
		content?: unknown;
	};
	attachment?: Record<string, unknown>;
	[key: string]: unknown;
}

export function claudeProjectSlug(cwd: string): string {
	return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

export function claudeProjectsRoot(): string {
	return join(homedir(), ".claude", "projects");
}

function parseTimestamp(value: unknown, fallback: number): number {
	if (typeof value !== "string") return fallback;
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? fallback : parsed;
}

function parseLines(text: string, notes: Notes): ClaudeRecord[] {
	const records: ClaudeRecord[] = [];
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "") continue;
		try {
			const value: unknown = JSON.parse(trimmed);
			if (typeof value === "object" && value !== null && !Array.isArray(value)) {
				records.push(value as ClaudeRecord);
			} else {
				notes.add("record.not-an-object");
			}
		} catch {
			notes.add("record.invalid-json");
		}
	}
	return records;
}

/** Walk from the live leaf back to the root, then reverse, so abandoned rewind branches drop out. */
function activeBranch(records: ClaudeRecord[], notes: Notes): ClaudeRecord[] {
	const byUuid = new Map<string, ClaudeRecord>();
	for (const record of records) {
		if (typeof record.uuid === "string") byUuid.set(record.uuid, record);
	}
	if (byUuid.size === 0) return [];

	let leaf: string | undefined;
	for (const record of records) {
		if (record.type === "last-prompt" && typeof record.leafUuid === "string" && byUuid.has(record.leafUuid)) {
			leaf = record.leafUuid;
		}
	}
	if (leaf === undefined) {
		let newest: { uuid: string; ts: number } | undefined;
		for (const [uuid, record] of byUuid) {
			const ts = parseTimestamp(record.timestamp, 0);
			if (newest === undefined || ts >= newest.ts) newest = { uuid, ts };
		}
		leaf = newest?.uuid;
	}
	if (leaf === undefined) return [];

	const chain: ClaudeRecord[] = [];
	const seen = new Set<string>();
	let cursor: string | null | undefined = leaf;
	while (typeof cursor === "string") {
		if (seen.has(cursor)) {
			notes.add("branch.cycle-detected");
			break;
		}
		seen.add(cursor);
		const record = byUuid.get(cursor);
		if (record === undefined) break;
		chain.push(record);
		cursor = record.parentUuid ?? null;
	}
	chain.reverse();

	const dropped = byUuid.size - chain.length;
	if (dropped > 0) notes.add("branch.records-off-active-branch", String(dropped));
	return chain;
}

const SYSTEM_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

function stripSystemReminders(text: string, notes: Notes): string | undefined {
	if (!SYSTEM_REMINDER.test(text)) {
		SYSTEM_REMINDER.lastIndex = 0;
		return text;
	}
	SYSTEM_REMINDER.lastIndex = 0;
	const stripped = text.replace(SYSTEM_REMINDER, "").trim();
	notes.add("user.system-reminder-removed");
	return stripped === "" ? undefined : stripped;
}

function contentBlocks(content: unknown): unknown[] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	if (Array.isArray(content)) return content;
	return [];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (typeof value === "object" && value !== null && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	return undefined;
}

function toIrBlocks(content: unknown, notes: Notes): IrBlock[] {
	const blocks: IrBlock[] = [];
	for (const raw of contentBlocks(content)) {
		const block = asRecord(raw);
		if (block === undefined) continue;
		switch (block.type) {
			case "text": {
				if (typeof block.text === "string" && block.text !== "") blocks.push({ kind: "text", text: block.text });
				break;
			}
			case "thinking": {
				// The Anthropic `signature` is not carried over: it is bound to the
				// Anthropic API and a resumed session may run on another provider.
				if (typeof block.thinking === "string" && block.thinking !== "") {
					blocks.push({ kind: "thinking", text: block.thinking });
					if (typeof block.signature === "string") notes.add("thinking.signature-dropped");
				}
				break;
			}
			case "redacted_thinking": {
				notes.add("thinking.redacted-dropped");
				break;
			}
			case "image": {
				const source = asRecord(block.source);
				if (source !== undefined && typeof source.data === "string") {
					blocks.push({
						kind: "image",
						data: source.data,
						mimeType: typeof source.media_type === "string" ? source.media_type : "image/png",
					});
				} else {
					notes.add("image.unsupported-source");
				}
				break;
			}
			default:
				break;
		}
	}
	return blocks;
}

function toolCalls(content: unknown): IrToolCall[] {
	const calls: IrToolCall[] = [];
	for (const raw of contentBlocks(content)) {
		const block = asRecord(raw);
		if (block?.type !== "tool_use") continue;
		if (typeof block.id !== "string" || typeof block.name !== "string") continue;
		calls.push({
			kind: "toolCall",
			id: block.id,
			name: block.name,
			arguments: asRecord(block.input) ?? {},
		});
	}
	return calls;
}

function metaText(record: ClaudeRecord): string {
	const candidates: unknown[] = [
		record.content,
		record.attachment?.stdout,
		record.attachment?.content,
		record.summary,
		record.title,
	];
	for (const candidate of candidates) {
		if (typeof candidate === "string" && candidate.trim() !== "") return candidate.slice(0, MAX_META_CHARS);
	}
	const payload = record.attachment ?? record;
	return JSON.stringify(payload).slice(0, MAX_META_CHARS);
}

function metaKind(record: ClaudeRecord): string {
	if (typeof record.subtype === "string") return record.subtype;
	const attachmentType = record.attachment?.type;
	if (typeof attachmentType === "string") return attachmentType;
	return record.type ?? "unknown";
}

function withoutSystemReminders(blocks: IrBlock[], notes: Notes): IrBlock[] {
	const kept: IrBlock[] = [];
	for (const block of blocks) {
		if (block.kind !== "text") {
			kept.push(block);
			continue;
		}
		const text = stripSystemReminders(block.text, notes);
		if (text !== undefined) kept.push({ kind: "text", text });
	}
	return kept;
}

/** Convert one branch of Claude Code records into neutral messages. */
export function parseClaudeSession(text: string, options: ClaudeReadOptions = {}): Transcript {
	const notes = new Notes();
	const records = parseLines(text, notes);
	const chain = activeBranch(records, notes);

	let sessionId = "";
	let cwd = "";
	let title: string | undefined;
	let model: string | undefined;
	let createdAt = Number.POSITIVE_INFINITY;

	for (const record of records) {
		if (sessionId === "" && typeof record.sessionId === "string") sessionId = record.sessionId;
		if (cwd === "" && typeof record.cwd === "string") cwd = record.cwd;
		if (record.type === "ai-title" && typeof record.title === "string") title = record.title;
		if (title === undefined && record.type === "summary" && typeof record.summary === "string") {
			title = record.summary;
		}
		const ts = parseTimestamp(record.timestamp, Number.POSITIVE_INFINITY);
		if (ts < createdAt) createdAt = ts;
	}
	if (!Number.isFinite(createdAt)) createdAt = Date.now();

	const messages: IrMessage[] = [];
	let previousTs = createdAt;

	for (const record of chain) {
		const ts = parseTimestamp(record.timestamp, previousTs);
		previousTs = ts;

		if (record.isSidechain === true) {
			// Subagent transcripts live on their own chain. The parent's Task tool
			// result already carries the outcome, so the detail is redundant here.
			notes.add("sidechain.dropped");
			continue;
		}

		if (record.type === "assistant") {
			const blocks = [...toIrBlocks(record.message?.content, notes), ...toolCalls(record.message?.content)];
			if (blocks.length === 0) continue;
			if (model === undefined && typeof record.message?.model === "string") model = record.message.model;
			messages.push({
				role: "assistant",
				ts,
				blocks,
				...(typeof record.message?.model === "string" ? { model: record.message.model } : {}),
			});
			continue;
		}

		if (record.type === "user") {
			const results = contentBlocks(record.message?.content)
				.map(asRecord)
				.filter((block): block is Record<string, unknown> => block?.type === "tool_result");
			for (const result of results) {
				if (typeof result.tool_use_id !== "string") continue;
				messages.push({
					role: "toolResult",
					ts,
					callId: result.tool_use_id,
					name: "",
					isError: result.is_error === true,
					blocks: toIrBlocks(result.content, notes),
				});
			}
			let blocks = toIrBlocks(record.message?.content, notes);
			if (options.keepSystemReminders !== true) blocks = withoutSystemReminders(blocks, notes);
			if (blocks.length === 0) continue;
			if (record.isMeta === true) {
				messages.push({ role: "meta", ts, kind: "user-meta", text: blocks.map(blockText).join("\n") });
				continue;
			}
			messages.push({ role: "user", ts, blocks });
			continue;
		}

		if (record.type === "system" || record.type === "attachment") {
			messages.push({ role: "meta", ts, kind: metaKind(record), text: metaText(record) });
		}
	}

	nameToolResults(messages, notes);

	return {
		source: SOURCE_NAME,
		sessionId: sessionId === "" ? (options.sourcePath ?? "unknown") : sessionId,
		cwd,
		createdAt,
		...(title === undefined ? {} : { title }),
		...(model === undefined ? {} : { model: { provider: "anthropic", id: model } }),
		messages,
		notes: notes.list(),
	};
}

function blockText(block: IrBlock): string {
	if (block.kind === "text" || block.kind === "thinking") return block.text;
	return `[image ${block.mimeType}]`;
}

/** Claude stores the tool name on the call, not the result. Copy it across so writers can map both. */
function nameToolResults(messages: IrMessage[], notes: Notes): void {
	const namesById = new Map<string, string>();
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const block of message.blocks) {
			if (block.kind === "toolCall") namesById.set(block.id, block.name);
		}
	}
	for (const message of messages) {
		if (message.role !== "toolResult") continue;
		const name = namesById.get(message.callId);
		if (name === undefined) {
			notes.add("toolResult.orphan", message.callId);
			continue;
		}
		message.name = name;
	}
}

export async function readClaudeSessionFile(path: string, options: ClaudeReadOptions = {}): Promise<Transcript> {
	return parseClaudeSession(await readFile(path, "utf8"), { ...options, sourcePath: path });
}

async function sessionInfo(path: string): Promise<ClaudeSessionInfo | undefined> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch {
		return undefined;
	}
	let sessionId = "";
	let cwd = "";
	let title: string | undefined;
	let firstPrompt: string | undefined;
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "") continue;
		let record: ClaudeRecord;
		try {
			record = JSON.parse(trimmed) as ClaudeRecord;
		} catch {
			continue;
		}
		if (sessionId === "" && typeof record.sessionId === "string") sessionId = record.sessionId;
		if (cwd === "" && typeof record.cwd === "string") cwd = record.cwd;
		if (record.type === "ai-title" && typeof record.title === "string") title = record.title;
		if (firstPrompt === undefined && record.type === "user" && record.isSidechain !== true && record.isMeta !== true) {
			const prompt = contentBlocks(record.message?.content)
				.map(asRecord)
				.find((block) => block?.type === "text")?.text;
			if (typeof prompt === "string") firstPrompt = prompt.replace(/\s+/g, " ").slice(0, 120);
		}
	}
	if (sessionId === "" || cwd === "") return undefined;
	const info = await stat(path);
	return {
		path,
		sessionId,
		cwd,
		modifiedAt: info.mtimeMs,
		...(title === undefined ? {} : { title }),
		...(firstPrompt === undefined ? {} : { firstPrompt }),
	};
}

/** List Claude Code sessions recorded for one working directory, newest first. */
export async function findClaudeSessions(cwd: string, projectsRoot = claudeProjectsRoot()): Promise<ClaudeSessionInfo[]> {
	const target = resolve(cwd);
	const directories: string[] = [];
	const slugged = join(projectsRoot, claudeProjectSlug(target));
	try {
		await stat(slugged);
		directories.push(slugged);
	} catch {
		// The slug rule has changed across Claude Code versions. Fall back to
		// reading every project directory and matching on the recorded cwd.
		try {
			for (const entry of await readdir(projectsRoot, { withFileTypes: true })) {
				if (entry.isDirectory()) directories.push(join(projectsRoot, entry.name));
			}
		} catch {
			return [];
		}
	}

	const sessions: ClaudeSessionInfo[] = [];
	for (const directory of directories) {
		let entries: string[];
		try {
			entries = await readdir(directory);
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (!entry.endsWith(".jsonl")) continue;
			const info = await sessionInfo(join(directory, entry));
			if (info !== undefined && resolve(info.cwd) === target) sessions.push(info);
		}
	}
	return sessions.sort((a, b) => b.modifiedAt - a.modifiedAt);
}

/** Resolve a `--session` argument: a file path, a full or partial session id, or the newest session for `cwd`. */
export async function resolveClaudeSession(
	cwd: string,
	session?: string,
	projectsRoot = claudeProjectsRoot(),
): Promise<ClaudeSessionInfo> {
	if (session !== undefined && (session.includes("/") || session.endsWith(".jsonl"))) {
		const info = await sessionInfo(resolve(session));
		if (info === undefined) throw new Error(`Not a readable Claude Code session file: ${session}`);
		return info;
	}

	const sessions = await findClaudeSessions(cwd, projectsRoot);
	if (session !== undefined) {
		const matches = sessions.filter((candidate) => candidate.sessionId.startsWith(session));
		const first = matches[0];
		if (first === undefined) throw new Error(`No Claude Code session in ${cwd} with id starting ${session}`);
		if (matches.length > 1) throw new Error(`Session id ${session} is ambiguous: ${matches.length} matches`);
		return first;
	}

	const newest = sessions[0];
	if (newest === undefined) throw new Error(`No Claude Code sessions recorded for ${cwd}`);
	return newest;
}
