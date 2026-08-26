/**
 * Writer for pi sessions.
 *
 * The message shapes below mirror pi's own message types. They are declared
 * here rather than imported so harnext's published types do not drag in pi's
 * packages; the round-trip test checks them against the real ones.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { IrBlock, IrToolResultMessage, Transcript } from "../ir.js";
import { loadPiSessionApi, piSessionDirName, piSessionFileName } from "../pi-runtime.js";
import { mapTool } from "../tools.js";

export const TARGET_NAME = "pi";

export const DEFAULT_MAX_TOOL_OUTPUT_CHARS = 10_000;

export interface PiText {
	type: "text";
	text: string;
}

export interface PiThinking {
	type: "thinking";
	thinking: string;
}

export interface PiImage {
	type: "image";
	data: string;
	mimeType: string;
}

export interface PiToolCall {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

export interface PiUserMessage {
	role: "user";
	content: (PiText | PiImage)[];
	timestamp: number;
}

export interface PiAssistantMessage {
	role: "assistant";
	content: (PiText | PiThinking | PiToolCall)[];
	api: string;
	provider: string;
	model: string;
	usage: PiUsage;
	stopReason: "stop" | "toolUse";
	timestamp: number;
}

export interface PiToolResultMessage {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: (PiText | PiImage)[];
	isError: boolean;
	timestamp: number;
}

export interface PiUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

export type PiMessage = PiUserMessage | PiAssistantMessage | PiToolResultMessage;

export type PiEntry =
	| { kind: "message"; message: PiMessage }
	| { kind: "custom"; customType: string; data: unknown };

export interface PiWriteOptions {
	/** Root of pi's session store. Defaults to whatever the installed pi uses. */
	sessionsRoot?: string;
	/** Keep tool calls pi does not have instead of degrading them to text. Breaks resume on strict providers. */
	preserveTools?: boolean;
	/** Cap on a single tool result, in characters. 0 disables the cap. */
	maxToolOutputChars?: number;
	/** Session display name. Defaults to the transcript title. */
	name?: string;
	/** Path to a specific `@earendil-works/pi-coding-agent` package to write with. */
	piPackage?: string;
}

export interface WriteStats {
	messages: number;
	toolsMapped: number;
	toolsDegraded: number;
	resultsSynthesized: number;
	/** Results whose tool call is not on the imported branch. */
	resultsOrphaned: number;
	resultsTruncated: number;
	metaEntries: number;
	argumentsLost: string[];
}

export interface PiWriteResult {
	path: string;
	sessionId: string;
	stats: WriteStats;
	/** Which pi installation wrote the file. */
	writtenBy: { origin: string; version: string };
}

const ZERO_USAGE: PiUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function truncate(text: string, limit: number): { text: string; truncated: boolean } {
	if (limit <= 0 || text.length <= limit) return { text, truncated: false };
	const removed = text.length - limit;
	return { text: `${text.slice(0, limit)}\n[harnext: ${removed} characters truncated]`, truncated: true };
}

function toPlainContent(blocks: readonly IrBlock[]): (PiText | PiImage)[] {
	const content: (PiText | PiImage)[] = [];
	for (const block of blocks) {
		if (block.kind === "image") content.push({ type: "image", data: block.data, mimeType: block.mimeType });
		else content.push({ type: "text", text: block.text });
	}
	return content;
}

function resultText(message: IrToolResultMessage): string {
	return message.blocks
		.map((block) => (block.kind === "image" ? `[image ${block.mimeType}]` : block.text))
		.join("\n")
		.trim();
}

function describeUnmapped(name: string, input: Record<string, unknown>, output: string): string {
	const lines = [`[harnext] imported call to \`${name}\`, a tool pi does not have.`, `arguments: ${JSON.stringify(input)}`];
	if (output !== "") lines.push(`result: ${output}`);
	return lines.join("\n");
}

/**
 * Build the pi entry stream for a transcript.
 *
 * Tool calls and their results are paired here rather than emitted in source
 * order. A call with no result makes a provider reject the whole history on
 * the next turn, so an unanswered call gets a synthetic error result.
 */
export function toPiEntries(transcript: Transcript, options: PiWriteOptions = {}): { entries: PiEntry[]; stats: WriteStats } {
	const limit = options.maxToolOutputChars ?? DEFAULT_MAX_TOOL_OUTPUT_CHARS;
	const stats: WriteStats = {
		messages: 0,
		toolsMapped: 0,
		toolsDegraded: 0,
		resultsSynthesized: 0,
		resultsOrphaned: 0,
		resultsTruncated: 0,
		metaEntries: 0,
		argumentsLost: [],
	};

	const resultsByCallId = new Map<string, IrToolResultMessage>();
	for (const message of transcript.messages) {
		if (message.role === "toolResult") resultsByCallId.set(message.callId, message);
	}
	const consumed = new Set<string>();
	const entries: PiEntry[] = [];
	const model = transcript.model?.id ?? "claude-code-import";

	for (const message of transcript.messages) {
		if (message.role === "meta") {
			// A "custom" entry is stored and shown but stays out of the model's
			// context, which is where harness bookkeeping belongs.
			entries.push({
				kind: "custom",
				customType: `harnext:claude-${message.kind}`,
				data: { text: message.text, timestamp: message.ts },
			});
			stats.metaEntries += 1;
			continue;
		}

		if (message.role === "toolResult") continue; // Emitted next to the call that produced it.

		if (message.role === "user") {
			const content = toPlainContent(message.blocks);
			if (content.length === 0) continue;
			const previous = entries.at(-1);
			if (previous?.kind === "message" && previous.message.role === "user") {
				// Consecutive user turns are collapsed: some providers reject them.
				previous.message.content = [...previous.message.content, ...content];
				continue;
			}
			entries.push({ kind: "message", message: { role: "user", content, timestamp: message.ts } });
			stats.messages += 1;
			continue;
		}

		const content: (PiText | PiThinking | PiToolCall)[] = [];
		const pendingResults: PiToolResultMessage[] = [];

		for (const block of message.blocks) {
			if (block.kind === "text") {
				content.push({ type: "text", text: block.text });
				continue;
			}
			if (block.kind === "thinking") {
				content.push({ type: "thinking", thinking: block.text });
				continue;
			}
			if (block.kind === "image") {
				content.push({ type: "text", text: `[image ${block.mimeType}]` });
				continue;
			}

			const mapped = mapTool(block.name, block.arguments);
			const result = resultsByCallId.get(block.id);
			if (result !== undefined) consumed.add(block.id);

			if (mapped === undefined && options.preserveTools !== true) {
				const capped = truncate(result === undefined ? "" : resultText(result), limit);
				if (capped.truncated) stats.resultsTruncated += 1;
				content.push({ type: "text", text: describeUnmapped(block.name, block.arguments, capped.text) });
				stats.toolsDegraded += 1;
				continue;
			}

			const name = mapped?.name ?? block.name;
			if (mapped !== undefined) {
				stats.toolsMapped += 1;
				for (const lost of mapped.lost) {
					if (!stats.argumentsLost.includes(lost)) stats.argumentsLost.push(lost);
				}
			} else {
				stats.toolsDegraded += 1;
			}
			content.push({ type: "toolCall", id: block.id, name, arguments: mapped?.arguments ?? block.arguments });

			if (result === undefined) {
				stats.resultsSynthesized += 1;
				pendingResults.push({
					role: "toolResult",
					toolCallId: block.id,
					toolName: name,
					content: [{ type: "text", text: "[harnext] the original session recorded no result for this call." }],
					isError: true,
					timestamp: message.ts,
				});
				continue;
			}

			const capped = truncate(resultText(result), limit);
			if (capped.truncated) stats.resultsTruncated += 1;
			pendingResults.push({
				role: "toolResult",
				toolCallId: block.id,
				toolName: name,
				content: [{ type: "text", text: capped.text }],
				isError: result.isError,
				timestamp: result.ts,
			});
		}

		if (content.length === 0 && pendingResults.length === 0) continue;

		entries.push({
			kind: "message",
			message: {
				role: "assistant",
				content,
				api: "anthropic-messages",
				provider: "anthropic",
				model: message.model ?? model,
				usage: ZERO_USAGE,
				stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
				timestamp: message.ts,
			},
		});
		stats.messages += 1;
		for (const result of pendingResults) {
			entries.push({ kind: "message", message: result });
			stats.messages += 1;
		}
	}

	for (const callId of resultsByCallId.keys()) {
		if (!consumed.has(callId)) stats.resultsOrphaned += 1;
	}

	return { entries, stats };
}

/** Create a pi session from a transcript and return the file it was written to. */
export async function writeToPi(transcript: Transcript, options: PiWriteOptions = {}): Promise<PiWriteResult> {
	const { entries, stats } = toPiEntries(transcript, options);
	const cwd = transcript.cwd === "" ? process.cwd() : transcript.cwd;
	const api = await loadPiSessionApi(options.piPackage === undefined ? {} : { override: options.piPackage });

	const sessionDir =
		options.sessionsRoot === undefined
			? api.defaultSessionDir(cwd)
			: join(options.sessionsRoot, piSessionDirName(cwd));
	const session = api.createSession(cwd);

	const name = options.name ?? transcript.title;
	if (name !== undefined && name !== "") session.appendSessionInfo(name);
	if (transcript.model?.provider !== undefined && transcript.model.id !== undefined) {
		session.appendModelChange(transcript.model.provider, transcript.model.id);
	}

	for (const entry of entries) {
		if (entry.kind === "message") session.appendMessage(entry.message);
		else session.appendCustomEntry(entry.customType, entry.data);
	}

	const header = session.getHeader();
	if (header === null) throw new Error("pi built a session without a header");
	const path = join(sessionDir, piSessionFileName(header));
	const lines = [header, ...session.getEntries()].map((entry) => JSON.stringify(entry));
	await mkdir(sessionDir, { recursive: true });
	await writeFile(path, `${lines.join("\n")}\n`, { flag: "wx" });

	return { path, sessionId: session.getSessionId(), stats, writtenBy: { origin: api.origin, version: api.version } };
}
