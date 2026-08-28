/** Writer for resumable Claude Code JSONL sessions. */

import { randomBytes, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { writeTextFile } from "../atomic.js";
import type { IrBlock, IrToolResultMessage, Transcript } from "../ir.js";
import { claudeProjectSlug, claudeProjectsRoot } from "../readers/claude-code.js";
import { mapPiTool } from "../tools.js";

export const TARGET_NAME = "claude-code";
export const DEFAULT_MAX_TOOL_OUTPUT_CHARS = 10_000;

export interface ClaudeWriteOptions {
	projectsRoot?: string;
	preserveTools?: boolean;
	maxToolOutputChars?: number;
	title?: string;
	/** Stable identity/path used when refreshing an inactive sync mirror. */
	sessionId?: string;
	path?: string;
	overwrite?: boolean;
}

export interface ClaudeWriteStats {
	messages: number;
	toolsMapped: number;
	toolsDegraded: number;
	resultsSynthesized: number;
	resultsOrphaned: number;
	resultsTruncated: number;
	metaDropped: number;
	thinkingDegraded: number;
	argumentsLost: string[];
}

export interface ClaudeWriteResult {
	path: string;
	sessionId: string;
	stats: ClaudeWriteStats;
}

interface ClaudeRecord extends Record<string, unknown> {
	type: string;
}

function cap(text: string, limit: number): { text: string; truncated: boolean } {
	if (limit <= 0 || text.length <= limit) return { text, truncated: false };
	return {
		text: `${text.slice(0, limit)}\n[harnext: ${text.length - limit} characters truncated]`,
		truncated: true,
	};
}

function resultText(result: IrToolResultMessage): string {
	return result.blocks.map((block) => block.kind === "image" ? `[image ${block.mimeType}]` : block.text).join("\n").trim();
}

function userContent(blocks: readonly IrBlock[]): Record<string, unknown>[] {
	const content: Record<string, unknown>[] = [];
	for (const block of blocks) {
		if (block.kind === "image") {
			content.push({ type: "image", source: { type: "base64", media_type: block.mimeType, data: block.data } });
		} else {
			content.push({ type: "text", text: block.text });
		}
	}
	return content;
}

function importedToolText(name: string, args: Record<string, unknown>, result: string): string {
	const lines = [`[harnext] imported call to \`${name}\`, a tool Claude Code does not have.`, `arguments: ${JSON.stringify(args)}`];
	if (result !== "") lines.push(`result: ${result}`);
	return lines.join("\n");
}

function messageId(): string {
	return `msg_${randomBytes(12).toString("hex")}`;
}

function iso(ts: number): string {
	return new Date(Number.isFinite(ts) ? ts : Date.now()).toISOString();
}

/** Build the exact record stream written to a Claude Code project JSONL file. */
export function toClaudeRecords(
	transcript: Transcript,
	options: ClaudeWriteOptions = {},
	sessionId: string = randomUUID(),
): { records: ClaudeRecord[]; stats: ClaudeWriteStats } {
	const limit = options.maxToolOutputChars ?? DEFAULT_MAX_TOOL_OUTPUT_CHARS;
	const stats: ClaudeWriteStats = {
		messages: 0,
		toolsMapped: 0,
		toolsDegraded: 0,
		resultsSynthesized: 0,
		resultsOrphaned: 0,
		resultsTruncated: 0,
		metaDropped: 0,
		thinkingDegraded: 0,
		argumentsLost: [],
	};
	const records: ClaudeRecord[] = [];
	const results = new Map<string, IrToolResultMessage>();
	for (const message of transcript.messages) if (message.role === "toolResult") results.set(message.callId, message);
	const consumed = new Set<string>();
	let parentUuid: string | null = null;
	let lastPrompt = "";

	const append = (record: Omit<ClaudeRecord, "type"> & { type: string; uuid: string }): void => {
		records.push(record);
		parentUuid = record.uuid;
	};
	const base = (uuid: string, ts: number) => ({
		uuid,
		parentUuid,
		sessionId,
		cwd: transcript.cwd,
		timestamp: iso(ts),
		isSidechain: false,
		userType: "external",
	});

	for (const message of transcript.messages) {
		if (message.role === "meta") {
			stats.metaDropped += 1;
			continue;
		}
		if (message.role === "toolResult") continue;

		if (message.role === "user") {
			const content = userContent(message.blocks);
			if (content.length === 0) continue;
			const uuid = randomUUID();
			lastPrompt = content.filter((block) => block.type === "text").map((block) => String(block.text)).join("\n");
			append({ ...base(uuid, message.ts), type: "user", uuid, message: { role: "user", content } });
			stats.messages += 1;
			continue;
		}

		const assistantContent: Record<string, unknown>[] = [];
		const toolResults: Record<string, unknown>[] = [];
		let hasToolUse = false;
		for (const block of message.blocks) {
			if (block.kind === "text") {
				assistantContent.push({ type: "text", text: block.text });
				continue;
			}
			if (block.kind === "thinking") {
				// Claude's API rejects a thinking block without its provider-signed
				// signature. Imported reasoning remains readable as ordinary text.
				assistantContent.push({ type: "text", text: `[Imported reasoning]\n${block.text}` });
				stats.thinkingDegraded += 1;
				continue;
			}
			if (block.kind === "image") {
				assistantContent.push({ type: "text", text: `[Imported image: ${block.mimeType}]` });
				continue;
			}

			const result = results.get(block.id);
			if (result !== undefined) consumed.add(block.id);
			const mapped = mapPiTool(block.name, block.arguments);
			if (mapped === undefined && options.preserveTools !== true) {
				const output = cap(result === undefined ? "" : resultText(result), limit);
				if (output.truncated) stats.resultsTruncated += 1;
				assistantContent.push({ type: "text", text: importedToolText(block.name, block.arguments, output.text) });
				stats.toolsDegraded += 1;
				continue;
			}

			const name = mapped?.name ?? block.name;
			const input = mapped?.arguments ?? block.arguments;
			if (mapped === undefined) stats.toolsDegraded += 1;
			else {
				stats.toolsMapped += 1;
				for (const lost of mapped.lost) if (!stats.argumentsLost.includes(lost)) stats.argumentsLost.push(lost);
			}
			assistantContent.push({ type: "tool_use", id: block.id, name, input });
			hasToolUse = true;
			if (result === undefined) {
				stats.resultsSynthesized += 1;
				toolResults.push({
					type: "tool_result",
					tool_use_id: block.id,
					content: "[harnext] the original pi session recorded no result for this call.",
					is_error: true,
				});
			} else {
				const output = cap(resultText(result), limit);
				if (output.truncated) stats.resultsTruncated += 1;
				toolResults.push({
					type: "tool_result",
					tool_use_id: block.id,
					content: output.text,
					...(result.isError ? { is_error: true } : {}),
				});
			}
		}

		if (assistantContent.length === 0) continue;
		const uuid = randomUUID();
		append({
			...base(uuid, message.ts),
			type: "assistant",
			uuid,
			message: {
				id: messageId(),
				type: "message",
				role: "assistant",
				model: message.model ?? transcript.model?.id ?? "claude-sonnet-4-6",
				content: assistantContent,
				stop_reason: hasToolUse ? "tool_use" : "end_turn",
				stop_sequence: null,
				usage: { input_tokens: 0, output_tokens: 0 },
			},
		});
		stats.messages += 1;

		if (toolResults.length > 0) {
			const resultUuid = randomUUID();
			append({
				...base(resultUuid, message.ts),
				type: "user",
				uuid: resultUuid,
				message: { role: "user", content: toolResults },
			});
			stats.messages += 1;
		}
	}

	for (const id of results.keys()) if (!consumed.has(id)) stats.resultsOrphaned += 1;
	if (parentUuid !== null) {
		records.push({ type: "last-prompt", sessionId, leafUuid: parentUuid, ...(lastPrompt === "" ? {} : { lastPrompt }) });
	}
	const title = options.title ?? transcript.title;
	if (title !== undefined && title !== "") records.push({ type: "ai-title", sessionId, aiTitle: title });
	return { records, stats };
}

export async function writeToClaudeCode(transcript: Transcript, options: ClaudeWriteOptions = {}): Promise<ClaudeWriteResult> {
	const sessionId = options.sessionId ?? randomUUID();
	const { records, stats } = toClaudeRecords(transcript, options, sessionId);
	const root = options.projectsRoot ?? claudeProjectsRoot();
	const directory = join(root, claudeProjectSlug(transcript.cwd));
	const path = options.path ?? join(directory, `${sessionId}.jsonl`);
	await mkdir(directory, { recursive: true });
	await writeTextFile(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, options.overwrite === true);
	return { path, sessionId, stats };
}
