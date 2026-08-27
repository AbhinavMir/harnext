/** Reader for pi v3/v4 JSONL session files. */

import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { IrBlock, IrMessage, IrToolCall, Transcript } from "../ir.js";
import { Notes } from "../ir.js";
import { piSessionDirName } from "../pi-runtime.js";

export const SOURCE_NAME = "pi";

export interface PiSessionInfo {
	path: string;
	sessionId: string;
	cwd: string;
	modifiedAt: number;
	title?: string;
	firstPrompt?: string;
}

interface RecordValue {
	type?: string;
	kind?: string;
	id?: string;
	parentId?: string | null;
	timestamp?: string | number;
	createdAt?: number;
	cwd?: string;
	version?: number;
	name?: string;
	provider?: string;
	modelId?: string;
	customType?: string;
	data?: unknown;
	content?: unknown;
	message?: Record<string, unknown>;
}

function object(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function timestamp(value: unknown, fallback: number): number {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		if (!Number.isNaN(parsed)) return parsed;
	}
	return fallback;
}

function parse(text: string, notes: Notes): RecordValue[] {
	const records: RecordValue[] = [];
	for (const line of text.split("\n")) {
		if (line.trim() === "") continue;
		try {
			const value: unknown = JSON.parse(line);
			const record = object(value);
			if (record === undefined) notes.add("record.not-an-object");
			else records.push(record as RecordValue);
		} catch {
			notes.add("record.invalid-json");
		}
	}
	return records;
}

function activeBranch(records: RecordValue[], notes: Notes): RecordValue[] {
	// v4 interleaves branch entries with operation/lane records. Only entries
	// have parentId (including null at the root); lane records must not become
	// false leaves that hide the conversation branch.
	const entries = records.filter((record) =>
		typeof record.id === "string" && record.parentId !== undefined && record.type !== "session" && record.kind !== "header",
	);
	if (entries.length === 0) return [];
	const byId = new Map(entries.map((entry) => [entry.id as string, entry]));
	const parents = new Set(entries.map((entry) => entry.parentId).filter((id): id is string => typeof id === "string"));
	const leaves = entries.filter((entry) => !parents.has(entry.id as string));
	let leaf = leaves.at(-1) ?? entries.at(-1);
	const chain: RecordValue[] = [];
	const seen = new Set<string>();
	while (leaf !== undefined && typeof leaf.id === "string" && !seen.has(leaf.id)) {
		seen.add(leaf.id);
		chain.push(leaf);
		leaf = typeof leaf.parentId === "string" ? byId.get(leaf.parentId) : undefined;
	}
	chain.reverse();
	const dropped = entries.length - chain.length;
	if (dropped > 0) notes.add("branch.records-off-active-branch", String(dropped));
	return chain;
}

function blocks(content: unknown, notes: Notes): IrBlock[] {
	const values = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
	const result: IrBlock[] = [];
	for (const raw of values) {
		const block = object(raw);
		if (block?.type === "text" && typeof block.text === "string") result.push({ kind: "text", text: block.text });
		else if (block?.type === "thinking" && typeof block.thinking === "string") {
			result.push({ kind: "thinking", text: block.thinking });
			if (block.thinkingSignature !== undefined) notes.add("thinking.signature-dropped");
		} else if (block?.type === "image" && typeof block.data === "string") {
			result.push({ kind: "image", data: block.data, mimeType: typeof block.mimeType === "string" ? block.mimeType : "image/png" });
		}
	}
	return result;
}

function toolCalls(content: unknown): IrToolCall[] {
	if (!Array.isArray(content)) return [];
	const result: IrToolCall[] = [];
	for (const raw of content) {
		const block = object(raw);
		if (block?.type !== "toolCall" || typeof block.id !== "string" || typeof block.name !== "string") continue;
		result.push({ kind: "toolCall", id: block.id, name: block.name, arguments: object(block.arguments) ?? {} });
	}
	return result;
}

function metaText(record: RecordValue): string {
	const value = record.data ?? record.content;
	if (typeof value === "string") return value;
	return JSON.stringify(value ?? {});
}

export function parsePiSession(text: string, sourcePath?: string): Transcript {
	const notes = new Notes();
	const records = parse(text, notes);
	const header = records.find((record) => record.type === "session" || record.kind === "header");
	if (header === undefined) throw new Error("Not a pi session: no session header");
	const createdAt = timestamp(header.timestamp ?? header.createdAt, Date.now());
	let model: Transcript["model"];
	let title: string | undefined;
	const messages: IrMessage[] = [];

	for (const record of activeBranch(records, notes)) {
		const ts = timestamp(record.timestamp, createdAt);
		if (record.type === "model_change" && typeof record.modelId === "string") {
			model = { ...(typeof record.provider === "string" ? { provider: record.provider } : {}), id: record.modelId };
			continue;
		}
		if (record.type === "session_info" && typeof record.name === "string") {
			title = record.name;
			continue;
		}
		if (record.type === "custom" || record.type === "custom_message") {
			messages.push({ role: "meta", ts, kind: record.customType ?? "custom", text: metaText(record) });
			continue;
		}
		if (record.type !== "message" || record.message === undefined) continue;
		const message = record.message;
		if (message.role === "user") {
			const content = blocks(message.content, notes);
			if (content.length > 0) messages.push({ role: "user", ts, blocks: content });
		} else if (message.role === "assistant") {
			const content = [...blocks(message.content, notes), ...toolCalls(message.content)];
			if (content.length > 0) messages.push({
				role: "assistant",
				ts,
				blocks: content,
				...(typeof message.model === "string" ? { model: message.model } : {}),
			});
		} else if (message.role === "toolResult" && typeof message.toolCallId === "string") {
			messages.push({
				role: "toolResult",
				ts,
				callId: message.toolCallId,
				name: typeof message.toolName === "string" ? message.toolName : "",
				isError: message.isError === true,
				blocks: blocks(message.content, notes),
			});
		}
	}

	return {
		source: SOURCE_NAME,
		sessionId: typeof header.id === "string" ? header.id : (sourcePath ?? "unknown"),
		cwd: typeof header.cwd === "string" ? header.cwd : "",
		createdAt,
		...(title === undefined ? {} : { title }),
		...(model === undefined ? {} : { model }),
		messages,
		notes: notes.list(),
	};
}

export function defaultPiSessionsRoot(): string {
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	return join(agentDir, "sessions");
}

async function info(path: string): Promise<PiSessionInfo | undefined> {
	try {
		const transcript = parsePiSession(await readFile(path, "utf8"), path);
		const first = transcript.messages.find((message) => message.role === "user");
		const prompt = first?.role === "user"
			? first.blocks.filter((block) => block.kind === "text").map((block) => block.kind === "text" ? block.text : "").join(" ").replace(/\s+/g, " ").slice(0, 120)
			: undefined;
		return {
			path,
			sessionId: transcript.sessionId,
			cwd: transcript.cwd,
			modifiedAt: (await stat(path)).mtimeMs,
			...(transcript.title === undefined ? {} : { title: transcript.title }),
			...(prompt === undefined || prompt === "" ? {} : { firstPrompt: prompt }),
		};
	} catch {
		return undefined;
	}
}

export async function readPiSessionFile(path: string): Promise<Transcript> {
	return parsePiSession(await readFile(path, "utf8"), path);
}

export async function findPiSessions(cwd: string, sessionsRoot = defaultPiSessionsRoot()): Promise<PiSessionInfo[]> {
	const directory = join(sessionsRoot, piSessionDirName(resolve(cwd)));
	let names: string[];
	try { names = await readdir(directory); } catch { return []; }
	const sessions = await Promise.all(names.filter((name) => name.endsWith(".jsonl")).map((name) => info(join(directory, name))));
	return sessions.filter((item): item is PiSessionInfo => item !== undefined).sort((a, b) => b.modifiedAt - a.modifiedAt);
}

export async function resolvePiSession(cwd: string, session?: string, sessionsRoot = defaultPiSessionsRoot()): Promise<PiSessionInfo> {
	if (session !== undefined && (session.includes("/") || session.endsWith(".jsonl"))) {
		const found = await info(resolve(session));
		if (found === undefined) throw new Error(`Not a readable pi session file: ${session}`);
		return found;
	}
	const sessions = await findPiSessions(cwd, sessionsRoot);
	if (session !== undefined) {
		const matches = sessions.filter((candidate) => candidate.sessionId.startsWith(session));
		if (matches.length === 0) throw new Error(`No pi session in ${cwd} with id starting ${session}`);
		if (matches.length > 1) throw new Error(`Session id ${session} is ambiguous: ${matches.length} matches`);
		return matches[0] as PiSessionInfo;
	}
	if (sessions.length === 0) throw new Error(`No pi sessions recorded for ${cwd}`);
	return sessions[0] as PiSessionInfo;
}
