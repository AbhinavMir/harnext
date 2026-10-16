import { describe, expect, it } from "vitest";
import type { Transcript } from "../src/ir.js";
import { parseCodexSession } from "../src/readers/codex.js";
import { toCodexRecords } from "../src/writers/codex.js";

const transcript: Transcript = {
	source: "pi",
	sessionId: "source",
	cwd: "/tmp/codex-project",
	createdAt: 1_700_000_000_000,
	title: "Codex import",
	model: { provider: "openai", id: "gpt-5" },
	messages: [
		{ role: "user", ts: 1_700_000_001_000, blocks: [{ kind: "text", text: "inspect it" }] },
		{ role: "assistant", ts: 1_700_000_002_000, model: "gpt-5", blocks: [{ kind: "toolCall", id: "call-1", name: "read", arguments: { path: "a.ts" } }] },
		{ role: "toolResult", ts: 1_700_000_003_000, callId: "call-1", name: "read", isError: false, blocks: [{ kind: "text", text: "contents" }] },
		{ role: "assistant", ts: 1_700_000_004_000, blocks: [{ kind: "text", text: "done" }] },
	],
	notes: [],
};

describe("Codex rollouts", () => {
	it("round trips messages and completed tool calls", () => {
		const built = toCodexRecords(transcript, { sessionId: "codex-id" });
		const parsed = parseCodexSession(`${built.records.map((record) => JSON.stringify(record)).join("\n")}\n`);
		expect(parsed.source).toBe("codex");
		expect(parsed.sessionId).toBe("codex-id");
		expect(parsed.messages).toEqual(expect.arrayContaining([
			expect.objectContaining({ role: "user" }),
			expect.objectContaining({ role: "toolResult", callId: "call-1" }),
		]));
		expect(built.stats).toEqual({ messages: 2, toolCalls: 1, orphanedResults: 0 });
	});

	it("removes Codex harness injections from user history", () => {
		const built = toCodexRecords(transcript, { sessionId: "codex-id" });
		built.records.splice(1, 0, {
			timestamp: new Date().toISOString(),
			type: "response_item",
			payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>private harness state</environment_context>" }] },
		});
		const parsed = parseCodexSession(built.records.map((record) => JSON.stringify(record)).join("\n"));
		expect(JSON.stringify(parsed.messages)).not.toContain("private harness state");
		expect(parsed.notes).toContainEqual(expect.objectContaining({ code: "user.harness-injection-removed" }));
	});
});

describe("toCodexRecords call ids", () => {
	it("shortens an over-long composite tool id and keeps call and output in sync", () => {
		const original = "call_8igRONyIRu3uydBzdtqbxbl2|fc_076b744557c3ba08016a9bc036689887d2be225e0dad5bcb1b";
		const { records } = toCodexRecords({
			source: "pi",
			sessionId: "source",
			cwd: "/tmp/codex-project",
			createdAt: 1_700_000_000_000,
			messages: [
				{ role: "assistant", ts: 1, blocks: [{ kind: "toolCall", id: original, name: "read", arguments: { path: "a.ts" } }] },
				{ role: "toolResult", ts: 2, callId: original, name: "read", isError: false, blocks: [{ kind: "text", text: "body" }] },
			],
			notes: [],
		});
		const call = records.find((r) => (r.payload as { type?: string }).type === "function_call") as { payload: { call_id: string } };
		const output = records.find((r) => (r.payload as { type?: string }).type === "function_call_output") as { payload: { call_id: string } };
		expect(call.payload.call_id.length).toBeLessThanOrEqual(64);
		expect(call.payload.call_id).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(call.payload.call_id).not.toBe(original);
		expect(output.payload.call_id).toBe(call.payload.call_id);
	});

	it("leaves a short, valid tool id unchanged", () => {
		const { records } = toCodexRecords({
			source: "pi", sessionId: "source", cwd: "/tmp/codex-project", createdAt: 1_700_000_000_000,
			messages: [{ role: "assistant", ts: 1, blocks: [{ kind: "toolCall", id: "call_abc123", name: "read", arguments: {} }] }],
			notes: [],
		});
		const call = records.find((r) => (r.payload as { type?: string }).type === "function_call") as { payload: { call_id: string } };
		expect(call.payload.call_id).toBe("call_abc123");
	});
});
