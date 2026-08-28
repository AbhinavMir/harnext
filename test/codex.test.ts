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
