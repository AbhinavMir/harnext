/** Builders for Claude Code session records, so tests read as transcripts rather than as JSON. */

let counter = 0;

export function uuid(label: string): string {
	return `uuid-${label}`;
}

export interface RecordOptions {
	uuid: string;
	parent: string | null;
	timestamp?: string;
	sidechain?: boolean;
}

function base(options: RecordOptions): Record<string, unknown> {
	counter += 1;
	return {
		uuid: options.uuid,
		parentUuid: options.parent,
		sessionId: "session-1",
		cwd: "/tmp/project",
		timestamp: options.timestamp ?? new Date(1_700_000_000_000 + counter * 1000).toISOString(),
		isSidechain: options.sidechain ?? false,
		version: "2.0.0",
	};
}

export function userText(options: RecordOptions, text: string): Record<string, unknown> {
	return { ...base(options), type: "user", message: { role: "user", content: [{ type: "text", text }] } };
}

export function userStringContent(options: RecordOptions, text: string): Record<string, unknown> {
	return { ...base(options), type: "user", message: { role: "user", content: text } };
}

export function assistantText(options: RecordOptions, text: string): Record<string, unknown> {
	return {
		...base(options),
		type: "assistant",
		message: { role: "assistant", model: "claude-opus-5", content: [{ type: "text", text }] },
	};
}

export function assistantToolUse(
	options: RecordOptions,
	call: { id: string; name: string; input: Record<string, unknown> },
	extra: Record<string, unknown>[] = [],
): Record<string, unknown> {
	return {
		...base(options),
		type: "assistant",
		message: {
			role: "assistant",
			model: "claude-opus-5",
			content: [...extra, { type: "tool_use", id: call.id, name: call.name, input: call.input }],
		},
	};
}

export function toolResult(
	options: RecordOptions,
	result: { id: string; content: unknown; isError?: boolean },
): Record<string, unknown> {
	return {
		...base(options),
		type: "user",
		message: {
			role: "user",
			content: [
				{
					type: "tool_result",
					tool_use_id: result.id,
					content: result.content,
					...(result.isError === true ? { is_error: true } : {}),
				},
			],
		},
	};
}

export function lastPrompt(leafUuid: string): Record<string, unknown> {
	return { type: "last-prompt", leafUuid, sessionId: "session-1" };
}

export function hookAttachment(options: RecordOptions, stdout: string): Record<string, unknown> {
	return { ...base(options), type: "attachment", attachment: { type: "hook_success", stdout } };
}

export function jsonl(records: Record<string, unknown>[]): string {
	return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}
