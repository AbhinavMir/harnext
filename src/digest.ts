/**
 * Digest mode.
 *
 * Full replay carries every turn into the new harness, which is faithful but
 * expensive: a long session arrives as a long session. A digest collapses the
 * same transcript into one opening message that states what was asked, what
 * was touched and where things stopped. It is assembled from the transcript
 * itself, so it needs no model and runs offline.
 */

import type { IrMessage, Transcript } from "./ir.js";

const MAX_PROMPTS = 30;
const MAX_PROMPT_CHARS = 600;
const MAX_PATHS = 40;
const MAX_COMMANDS = 30;
const MAX_COMMAND_CHARS = 200;
const MAX_CLOSING_CHARS = 2000;

const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit", "write", "edit"]);
const SHELL_TOOLS = new Set(["Bash", "bash"]);

function textBlocks(message: IrMessage): string {
	if (message.role === "user") {
		return message.blocks
			.map((block) => (block.kind === "image" ? `[image ${block.mimeType}]` : block.text))
			.join("\n")
			.trim();
	}
	if (message.role === "assistant") {
		return message.blocks
			.filter((block) => block.kind === "text")
			.map((block) => (block.kind === "text" ? block.text : ""))
			.join("\n")
			.trim();
	}
	return "";
}

function clip(text: string, limit: number): string {
	const collapsed = text.replace(/\r/g, "").trim();
	return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit)}…`;
}

function section(title: string, lines: string[]): string[] {
	if (lines.length === 0) return [];
	return ["", `## ${title}`, ...lines];
}

/** Render a transcript as one message of prose. */
export function digestText(transcript: Transcript): string {
	const prompts: string[] = [];
	const paths = new Map<string, number>();
	const commands: string[] = [];
	let closing = "";
	let toolCalls = 0;

	for (const message of transcript.messages) {
		if (message.role === "user") {
			const text = textBlocks(message);
			if (text !== "") prompts.push(text);
			continue;
		}
		if (message.role !== "assistant") continue;

		const text = textBlocks(message);
		if (text !== "") closing = text;

		for (const block of message.blocks) {
			if (block.kind !== "toolCall") continue;
			toolCalls += 1;
			if (WRITE_TOOLS.has(block.name)) {
				const path = block.arguments.file_path ?? block.arguments.path ?? block.arguments.notebook_path;
				if (typeof path === "string") paths.set(path, (paths.get(path) ?? 0) + 1);
			}
			if (SHELL_TOOLS.has(block.name) && typeof block.arguments.command === "string") {
				commands.push(clip(block.arguments.command, MAX_COMMAND_CHARS));
			}
		}
	}

	const started = new Date(transcript.createdAt).toISOString();
	const lines: string[] = [
		"# Imported session",
		"",
		`This is a condensed record of an earlier ${transcript.source} session, not a live conversation.`,
		`It started ${started} in \`${transcript.cwd}\` and holds ${prompts.length} prompts and ${toolCalls} tool calls.`,
	];
	if (transcript.title !== undefined && transcript.title !== "") lines.push(`The session was titled "${transcript.title}".`);

	lines.push(
		...section(
			"What was asked",
			prompts.slice(0, MAX_PROMPTS).map((prompt, index) => `${index + 1}. ${clip(prompt, MAX_PROMPT_CHARS)}`),
		),
	);
	if (prompts.length > MAX_PROMPTS) lines.push(`(${prompts.length - MAX_PROMPTS} more prompts are not listed.)`);

	const pathLines = [...paths.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, MAX_PATHS)
		.map(([path, count]) => `- \`${path}\` (${count} ${count === 1 ? "change" : "changes"})`);
	lines.push(...section("Files written or edited", pathLines));
	if (paths.size > MAX_PATHS) lines.push(`(${paths.size - MAX_PATHS} more files are not listed.)`);

	const uniqueCommands = [...new Set(commands)];
	lines.push(...section("Commands run", uniqueCommands.slice(0, MAX_COMMANDS).map((command) => `- \`${command}\``)));
	if (uniqueCommands.length > MAX_COMMANDS) {
		lines.push(`(${uniqueCommands.length - MAX_COMMANDS} more commands are not listed.)`);
	}

	if (closing !== "") lines.push(...section("Where it ended", [clip(closing, MAX_CLOSING_CHARS)]));

	return lines.join("\n");
}

/** Replace a transcript's messages with a single digest message. */
export function digestTranscript(transcript: Transcript): Transcript {
	return {
		...transcript,
		messages: [{ role: "user", ts: transcript.createdAt, blocks: [{ kind: "text", text: digestText(transcript) }] }],
	};
}
