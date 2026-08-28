/** Reader and discovery for Codex rollout JSONL sessions. */

import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { IrMessage, IrToolCall, Transcript } from "../ir.js";
import { Notes } from "../ir.js";

export const SOURCE_NAME = "codex";

export interface CodexSessionInfo {
	path: string;
	sessionId: string;
	cwd: string;
	modifiedAt: number;
	title?: string;
	firstPrompt?: string;
	archived?: boolean;
}

interface RolloutRecord {
	timestamp?: string;
	type?: string;
	payload?: Record<string, unknown>;
}

function object(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function ts(value: unknown, fallback: number): number {
	if (typeof value !== "string") return fallback;
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? fallback : parsed;
}

function textParts(content: unknown, kind: "input_text" | "output_text"): string[] {
	if (!Array.isArray(content)) return [];
	return content.flatMap((value) => {
		const part = object(value);
		return part?.type === kind && typeof part.text === "string" ? [part.text] : [];
	});
}

function harnessInjection(text: string): boolean {
	const trimmed = text.trimStart();
	return trimmed.startsWith("<environment_context>")
		|| trimmed.startsWith("<recommended_plugins>")
		|| trimmed.startsWith("# AGENTS.md instructions")
		|| trimmed.startsWith("<INSTRUCTIONS>");
}

export function parseCodexSession(text: string, sourcePath?: string): Transcript {
	const notes = new Notes();
	const records: RolloutRecord[] = [];
	for (const line of text.split("\n")) {
		if (line.trim() === "") continue;
		try {
			const parsed: unknown = JSON.parse(line);
			const record = object(parsed);
			if (record === undefined) notes.add("record.not-an-object");
			else records.push(record as RolloutRecord);
		} catch { notes.add("record.invalid-json"); }
	}
	const meta = records.find((record) => record.type === "session_meta")?.payload;
	if (meta === undefined) throw new Error("Not a Codex rollout: no session_meta record");
	const createdAt = ts(meta.timestamp, ts(records[0]?.timestamp, Date.now()));
	const messages: IrMessage[] = [];
	let model: string | undefined;
	for (const record of records) {
		if (record.type === "turn_context" && typeof record.payload?.model === "string") model = record.payload.model;
		if (record.type !== "response_item") continue;
		const payload = record.payload;
		if (payload === undefined || typeof payload.type !== "string") continue;
		const timestamp = ts(record.timestamp, createdAt);
		if (payload.type === "message" && payload.role === "user") {
			const parts = textParts(payload.content, "input_text").filter((part) => {
				if (!harnessInjection(part)) return true;
				notes.add("user.harness-injection-removed");
				return false;
			});
			if (parts.length > 0) messages.push({ role: "user", ts: timestamp, blocks: parts.map((part) => ({ kind: "text", text: part })) });
		} else if (payload.type === "message" && payload.role === "assistant") {
			const parts = textParts(payload.content, "output_text");
			if (parts.length > 0) messages.push({ role: "assistant", ts: timestamp, blocks: parts.map((part) => ({ kind: "text", text: part })), ...(model === undefined ? {} : { model }) });
		} else if (payload.type === "reasoning") {
			const summary = Array.isArray(payload.summary)
				? payload.summary.flatMap((item) => object(item)?.type === "summary_text" && typeof object(item)?.text === "string" ? [String(object(item)?.text)] : [])
				: [];
			if (summary.length > 0) messages.push({ role: "assistant", ts: timestamp, blocks: [{ kind: "thinking", text: summary.join("\n") }], ...(model === undefined ? {} : { model }) });
		} else if (payload.type === "function_call" && typeof payload.call_id === "string" && typeof payload.name === "string") {
			let args: Record<string, unknown> = {};
			if (typeof payload.arguments === "string") {
				try { args = object(JSON.parse(payload.arguments)) ?? {}; } catch { notes.add("tool.arguments-invalid-json", payload.name); }
			}
			const call: IrToolCall = { kind: "toolCall", id: payload.call_id, name: payload.name, arguments: args };
			messages.push({ role: "assistant", ts: timestamp, blocks: [call], ...(model === undefined ? {} : { model }) });
		} else if (payload.type === "function_call_output" && typeof payload.call_id === "string") {
			messages.push({ role: "toolResult", ts: timestamp, callId: payload.call_id, name: "", isError: false, blocks: [{ kind: "text", text: typeof payload.output === "string" ? payload.output : JSON.stringify(payload.output ?? "") }] });
		}
	}
	const first = messages.find((message) => message.role === "user");
	const firstPrompt = first?.role === "user" ? first.blocks.filter((block) => block.kind === "text").map((block) => block.kind === "text" ? block.text : "").join(" ").replace(/\s+/g, " ").slice(0, 120) : undefined;
	return {
		source: SOURCE_NAME,
		sessionId: typeof meta.id === "string" ? meta.id : typeof meta.session_id === "string" ? meta.session_id : sourcePath ?? "unknown",
		cwd: typeof meta.cwd === "string" ? meta.cwd : "",
		createdAt,
		...(firstPrompt === undefined || firstPrompt === "" ? {} : { title: firstPrompt }),
		...(model === undefined ? {} : { model: { provider: typeof meta.model_provider === "string" ? meta.model_provider : "openai", id: model } }),
		messages,
		notes: notes.list(),
	};
}

export function defaultCodexRoot(): string {
	return process.env.CODEX_HOME ?? join(homedir(), ".codex");
}

async function walkJsonl(root: string): Promise<string[]> {
	const result: string[] = [];
	async function walk(directory: string): Promise<void> {
		let entries;
		try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
		await Promise.all(entries.map(async (entry) => {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) await walk(path);
			else if (entry.isFile() && entry.name.endsWith(".jsonl")) result.push(path);
		}));
	}
	await walk(root);
	return result;
}

async function info(path: string): Promise<CodexSessionInfo | undefined> {
	try {
		const transcript = parseCodexSession(await readFile(path, "utf8"), path);
		return {
			path,
			sessionId: transcript.sessionId,
			cwd: transcript.cwd,
			modifiedAt: (await stat(path)).mtimeMs,
			...(transcript.title === undefined ? {} : { title: transcript.title, firstPrompt: transcript.title }),
			...(path.includes("/archived_sessions/") ? { archived: true } : {}),
		};
	} catch { return undefined; }
}

export async function readCodexSessionFile(path: string): Promise<Transcript> {
	return parseCodexSession(await readFile(path, "utf8"), path);
}

export async function findAllCodexSessions(codexRoot = defaultCodexRoot()): Promise<CodexSessionInfo[]> {
	const paths = [...await walkJsonl(join(codexRoot, "sessions")), ...await walkJsonl(join(codexRoot, "archived_sessions"))];
	const sessions = await Promise.all(paths.map(info));
	return sessions.filter((item): item is CodexSessionInfo => item !== undefined).sort((a, b) => b.modifiedAt - a.modifiedAt);
}

export async function findCodexSessions(cwd: string, codexRoot = defaultCodexRoot()): Promise<CodexSessionInfo[]> {
	const target = resolve(cwd);
	return (await findAllCodexSessions(codexRoot)).filter((session) => resolve(session.cwd) === target);
}

export async function resolveCodexSession(cwd: string, session?: string, codexRoot = defaultCodexRoot()): Promise<CodexSessionInfo> {
	if (session !== undefined && (session.includes("/") || session.endsWith(".jsonl"))) {
		const found = await info(resolve(session));
		if (found === undefined) throw new Error(`Not a readable Codex rollout: ${session}`);
		return found;
	}
	const sessions = await findCodexSessions(cwd, codexRoot);
	if (session !== undefined) {
		const matches = sessions.filter((candidate) => candidate.sessionId.startsWith(session));
		if (matches.length === 0) throw new Error(`No Codex session in ${cwd} with id starting ${session}`);
		if (matches.length > 1) throw new Error(`Session id ${session} is ambiguous: ${matches.length} matches`);
		return matches[0] as CodexSessionInfo;
	}
	if (sessions.length === 0) throw new Error(`No Codex sessions recorded for ${cwd}`);
	return sessions[0] as CodexSessionInfo;
}
