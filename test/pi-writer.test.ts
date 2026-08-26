import { describe, expect, it } from "vitest";
import type { Message, ToolCall } from "@earendil-works/pi-ai";
import type { IrMessage, Transcript } from "../src/ir.js";
import { toPiEntries } from "../src/writers/pi.js";

function transcript(messages: IrMessage[]): Transcript {
	return {
		source: "claude-code",
		sessionId: "session-1",
		cwd: "/tmp/project",
		createdAt: 1_700_000_000_000,
		messages,
		notes: [],
	};
}

function messages(entries: ReturnType<typeof toPiEntries>["entries"]): Message[] {
	return entries.filter((entry) => entry.kind === "message").map((entry) => entry.message);
}

describe("toPiEntries", () => {
	it("emits a mapped tool call next to its result", () => {
		const { entries, stats } = toPiEntries(
			transcript([
				{
					role: "assistant",
					ts: 1,
					blocks: [{ kind: "toolCall", id: "call-1", name: "Read", arguments: { file_path: "/tmp/x" } }],
				},
				{ role: "toolResult", ts: 2, callId: "call-1", name: "Read", isError: false, blocks: [{ kind: "text", text: "body" }] },
			]),
		);

		const [assistant, result] = messages(entries);
		expect(assistant).toMatchObject({ role: "assistant", stopReason: "toolUse" });
		expect((assistant as { content: ToolCall[] }).content[0]).toMatchObject({
			type: "toolCall",
			name: "read",
			arguments: { path: "/tmp/x" },
		});
		expect(result).toMatchObject({ role: "toolResult", toolCallId: "call-1", toolName: "read", isError: false });
		expect(stats.toolsMapped).toBe(1);
	});

	it("degrades a tool pi does not have into assistant text, call and result together", () => {
		const { entries, stats } = toPiEntries(
			transcript([
				{
					role: "assistant",
					ts: 1,
					blocks: [{ kind: "toolCall", id: "call-1", name: "TodoWrite", arguments: { todos: ["a"] } }],
				},
				{ role: "toolResult", ts: 2, callId: "call-1", name: "TodoWrite", isError: false, blocks: [{ kind: "text", text: "saved" }] },
			]),
		);

		const written = messages(entries);
		expect(written).toHaveLength(1);
		expect(JSON.stringify(written[0])).toContain("TodoWrite");
		expect(JSON.stringify(written[0])).toContain("saved");
		expect(JSON.stringify(written[0])).not.toContain("toolCall");
		expect(stats.toolsDegraded).toBe(1);
	});

	it("keeps an unmapped tool call when asked to preserve tools", () => {
		const { entries } = toPiEntries(
			transcript([
				{ role: "assistant", ts: 1, blocks: [{ kind: "toolCall", id: "call-1", name: "TodoWrite", arguments: {} }] },
			]),
			{ preserveTools: true },
		);

		expect(JSON.stringify(messages(entries))).toContain('"name":"TodoWrite"');
	});

	it("answers a tool call the original session never resolved", () => {
		const { entries, stats } = toPiEntries(
			transcript([
				{
					role: "assistant",
					ts: 1,
					blocks: [{ kind: "toolCall", id: "call-1", name: "Read", arguments: { file_path: "/tmp/x" } }],
				},
			]),
		);

		const [, result] = messages(entries);
		expect(result).toMatchObject({ role: "toolResult", toolCallId: "call-1", isError: true });
		expect(stats.resultsSynthesized).toBe(1);
	});

	it("truncates a long tool result and says so", () => {
		const { entries, stats } = toPiEntries(
			transcript([
				{ role: "assistant", ts: 1, blocks: [{ kind: "toolCall", id: "call-1", name: "Read", arguments: {} }] },
				{
					role: "toolResult",
					ts: 2,
					callId: "call-1",
					name: "Read",
					isError: false,
					blocks: [{ kind: "text", text: "x".repeat(500) }],
				},
			]),
			{ maxToolOutputChars: 100 },
		);

		const [, result] = messages(entries);
		expect(JSON.stringify(result)).toContain("400 characters truncated");
		expect(stats.resultsTruncated).toBe(1);
	});

	it("keeps a whole tool result when the cap is disabled", () => {
		const { stats } = toPiEntries(
			transcript([
				{ role: "assistant", ts: 1, blocks: [{ kind: "toolCall", id: "call-1", name: "Read", arguments: {} }] },
				{
					role: "toolResult",
					ts: 2,
					callId: "call-1",
					name: "Read",
					isError: false,
					blocks: [{ kind: "text", text: "x".repeat(50_000) }],
				},
			]),
			{ maxToolOutputChars: 0 },
		);

		expect(stats.resultsTruncated).toBe(0);
	});

	it("collapses consecutive user turns", () => {
		const { entries } = toPiEntries(
			transcript([
				{ role: "user", ts: 1, blocks: [{ kind: "text", text: "first" }] },
				{ role: "user", ts: 2, blocks: [{ kind: "text", text: "second" }] },
			]),
		);

		const written = messages(entries);
		expect(written).toHaveLength(1);
		expect(written[0]).toMatchObject({
			role: "user",
			content: [
				{ type: "text", text: "first" },
				{ type: "text", text: "second" },
			],
		});
	});

	it("files meta messages as pi custom entries, not as chat turns", () => {
		const { entries, stats } = toPiEntries(
			transcript([{ role: "meta", ts: 1, kind: "hook_success", text: "hook output" }]),
		);

		expect(messages(entries)).toHaveLength(0);
		expect(entries[0]).toMatchObject({ kind: "custom", customType: "harnext:claude-hook_success" });
		expect(stats.metaEntries).toBe(1);
	});

	it("counts a tool result whose call is not on the branch", () => {
		const { stats } = toPiEntries(
			transcript([{ role: "toolResult", ts: 1, callId: "call-9", name: "Read", isError: false, blocks: [] }]),
		);

		expect(stats.resultsOrphaned).toBe(1);
	});

	it("carries thinking across without a signature field", () => {
		const { entries } = toPiEntries(
			transcript([{ role: "assistant", ts: 1, blocks: [{ kind: "thinking", text: "reasoning" }] }]),
		);

		expect(messages(entries)[0]).toMatchObject({
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "thinking", thinking: "reasoning" }],
		});
		expect(JSON.stringify(entries)).not.toContain("thinkingSignature");
	});
});
