/** Writer for resumable Codex rollout sessions. */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { writeTextFile } from "../atomic.js";
import type { IrToolResultMessage, Transcript } from "../ir.js";
import { defaultCodexRoot } from "../readers/codex.js";

export interface CodexWriteOptions {
	codexRoot?: string;
	codexCommand?: string;
	sessionId?: string;
	path?: string;
	title?: string;
	overwrite?: boolean;
	migrate?: boolean;
}

export interface CodexWriteStats {
	messages: number;
	toolCalls: number;
	orphanedResults: number;
}

export interface CodexWriteResult {
	path: string;
	sessionId: string;
	stats: CodexWriteStats;
	migrated: boolean;
}

function iso(value: number): string {
	return new Date(Number.isFinite(value) ? value : Date.now()).toISOString();
}

function record(timestamp: number, type: string, payload: Record<string, unknown>): Record<string, unknown> {
	return { timestamp: iso(timestamp), type, payload };
}

export function toCodexRecords(transcript: Transcript, options: CodexWriteOptions = {}): { records: Record<string, unknown>[]; sessionId: string; stats: CodexWriteStats } {
	const sessionId = options.sessionId ?? randomUUID();
	const modelProvider = transcript.model?.provider ?? "openai";
	const records: Record<string, unknown>[] = [record(transcript.createdAt, "session_meta", {
		id: sessionId,
		session_id: sessionId,
		timestamp: iso(transcript.createdAt),
		cwd: transcript.cwd,
		originator: "harnext",
		cli_version: "harnext",
		source: "cli",
		model_provider: modelProvider,
	})];
	if (transcript.model?.id !== undefined) records.push(record(transcript.createdAt, "turn_context", { model: transcript.model.id, cwd: transcript.cwd }));
	const results = new Map<string, IrToolResultMessage>();
	for (const message of transcript.messages) if (message.role === "toolResult") results.set(message.callId, message);
	const consumed = new Set<string>();
	const stats: CodexWriteStats = { messages: 0, toolCalls: 0, orphanedResults: 0 };
	for (const message of transcript.messages) {
		if (message.role === "meta" || message.role === "toolResult") continue;
		if (message.role === "user") {
			const content = message.blocks.map((block) => ({ type: "input_text", text: block.kind === "image" ? `[image ${block.mimeType}]` : block.text }));
			if (content.length > 0) {
				const display = content.map((part) => part.text).join("\n");
				records.push(record(message.ts, "event_msg", { type: "user_message", message: display, images: [], local_images: [], audio: [], local_audio: [], text_elements: [] }));
				records.push(record(message.ts, "response_item", { type: "message", role: "user", content }));
				stats.messages += 1;
			}
			continue;
		}
		const text = message.blocks.filter((block) => block.kind === "text").map((block) => block.kind === "text" ? block.text : "");
		if (text.length > 0) {
			records.push(record(message.ts, "response_item", { type: "message", role: "assistant", content: text.map((value) => ({ type: "output_text", text: value })) }));
			stats.messages += 1;
		}
		for (const block of message.blocks) {
			if (block.kind === "thinking") {
				records.push(record(message.ts, "response_item", { type: "reasoning", summary: [{ type: "summary_text", text: block.text }], content: null, encrypted_content: null }));
				continue;
			}
			if (block.kind !== "toolCall") continue;
			records.push(record(message.ts, "response_item", { type: "function_call", name: block.name, arguments: JSON.stringify(block.arguments), call_id: block.id }));
			stats.toolCalls += 1;
			const result = results.get(block.id);
			if (result !== undefined) {
				consumed.add(block.id);
				const output = result.blocks.map((item) => item.kind === "image" ? `[image ${item.mimeType}]` : item.text).join("\n");
				records.push(record(result.ts, "response_item", { type: "function_call_output", call_id: block.id, output }));
			}
		}
	}
	for (const callId of results.keys()) if (!consumed.has(callId)) stats.orphanedResults += 1;
	return { records, sessionId, stats };
}

async function runMigration(command: string, sessionId: string): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const child = spawn(command, ["migrate-rollouts", "--apply", "--thread", sessionId], { stdio: ["ignore", "pipe", "pipe"] });
		let stderr = "";
		child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
		child.on("error", reject);
		child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`Codex could not register imported rollout: ${stderr.trim() || `exit ${String(code)}`}`)));
	});
}

export async function writeToCodex(transcript: Transcript, options: CodexWriteOptions = {}): Promise<CodexWriteResult> {
	const built = toCodexRecords(transcript, options);
	const now = new Date();
	const datePath = [String(now.getUTCFullYear()), String(now.getUTCMonth() + 1).padStart(2, "0"), String(now.getUTCDate()).padStart(2, "0")];
	const stamp = now.toISOString().replace(/[:.]/g, "-");
	const path = options.path ?? join(options.codexRoot ?? defaultCodexRoot(), "sessions", ...datePath, `rollout-${stamp}-${built.sessionId}.jsonl`);
	await mkdir(dirname(path), { recursive: true });
	await writeTextFile(path, `${built.records.map((item) => JSON.stringify(item)).join("\n")}\n`, options.overwrite === true);
	const shouldMigrate = options.migrate ?? options.overwrite !== true;
	if (shouldMigrate) await runMigration(options.codexCommand ?? "codex", built.sessionId);
	return { path, sessionId: built.sessionId, stats: built.stats, migrated: shouldMigrate };
}
