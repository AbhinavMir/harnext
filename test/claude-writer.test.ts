import { describe, expect, it } from "vitest";
import type { IrMessage, Transcript } from "../src/ir.js";
import { parseClaudeSession } from "../src/readers/claude-code.js";
import { toClaudeRecords } from "../src/writers/claude-code.js";

function transcript(messages: IrMessage[]): Transcript {
	return { source: "pi", sessionId: "pi-1", cwd: "/tmp/project", createdAt: 1_700_000_000_000, messages, notes: [] };
}

function text(records: unknown[]): string {
	return records.map((record) => JSON.stringify(record)).join("\n");
}

describe("toClaudeRecords", () => {
	it("writes a chain Claude's reader can load", () => {
		const { records } = toClaudeRecords(transcript([
			{ role: "user", ts: 1, blocks: [{ kind: "text", text: "hello" }] },
			{ role: "assistant", ts: 2, blocks: [{ kind: "text", text: "hi" }] },
		]), {}, "claude-1");

		const parsed = parseClaudeSession(`${text(records)}\n`);

		expect(parsed.sessionId).toBe("claude-1");
		expect(parsed.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
	});

	it("maps a pi tool call and pairs its result", () => {
		const { records, stats } = toClaudeRecords(transcript([
			{ role: "assistant", ts: 1, blocks: [{ kind: "toolCall", id: "c1", name: "read", arguments: { path: "README.md" } }] },
			{ role: "toolResult", ts: 2, callId: "c1", name: "read", isError: false, blocks: [{ kind: "text", text: "body" }] },
		]), {}, "claude-1");

		const serialized = text(records);
		expect(serialized).toContain('"name":"Read"');
		expect(serialized).toContain('"file_path":"README.md"');
		expect(serialized).toContain('"tool_use_id":"c1"');
		expect(stats.toolsMapped).toBe(1);

		const parsed = parseClaudeSession(`${serialized}\n`);
		expect(parsed.messages.map((message) => message.role)).toEqual(["assistant", "toolResult"]);
		expect(parsed.messages[1]).toMatchObject({ role: "toolResult", callId: "c1", name: "Read" });
	});

	it("rewrites provider-specific tool ids to Claude-safe ids", () => {
		const original = "call_abc|fc_123";
		const { records } = toClaudeRecords(transcript([
			{ role: "assistant", ts: 1, blocks: [{ kind: "toolCall", id: original, name: "read", arguments: { path: "README.md" } }] },
			{ role: "toolResult", ts: 2, callId: original, name: "read", isError: false, blocks: [{ kind: "text", text: "body" }] },
		]), {}, "claude-1");
		const assistant = records.find((record) => record.type === "assistant") as { message: { content: { type: string; id?: string }[] } };
		const user = records.find((record) => record.type === "user") as { message: { content: { type: string; tool_use_id?: string }[] } };
		const id = assistant.message.content.find((block) => block.type === "tool_use")?.id;

		expect(id).toMatch(/^[a-zA-Z0-9_-]+$/);
		expect(id).not.toBe(original);
		expect(user.message.content.find((block) => block.type === "tool_result")?.tool_use_id).toBe(id);
	});

	it("records a Claude model so resume does not reject a foreign id", () => {
		const foreign: Transcript = {
			source: "pi",
			sessionId: "pi-1",
			cwd: "/tmp/project",
			createdAt: 1_700_000_000_000,
			model: { provider: "openai-codex", id: "gpt-6-astra" },
			messages: [
				{ role: "assistant", ts: 1, blocks: [{ kind: "text", text: "one" }], model: "gpt-5.6-sol" },
				{ role: "assistant", ts: 2, blocks: [{ kind: "text", text: "two" }], model: "<synthetic>" },
				{ role: "assistant", ts: 3, blocks: [{ kind: "text", text: "three" }], model: "claude-opus-5" },
			],
			notes: [],
		};
		const { records } = toClaudeRecords(foreign, {}, "claude-1");
		const models = records
			.filter((record) => record.type === "assistant")
			.map((record) => (record as { message: { model: string } }).message.model);
		expect(models).toEqual(["claude-sonnet-4-6", "claude-sonnet-4-6", "claude-opus-5"]);
		for (const model of models) expect(model).toMatch(/^claude-/);
	});

	it("degrades a pi-only tool call with its result", () => {
		const { records, stats } = toClaudeRecords(transcript([
			{ role: "assistant", ts: 1, blocks: [{ kind: "toolCall", id: "c1", name: "agent_send", arguments: { to: "peer" } }] },
			{ role: "toolResult", ts: 2, callId: "c1", name: "agent_send", isError: false, blocks: [{ kind: "text", text: "received" }] },
		]), {}, "claude-1");

		const serialized = text(records);
		expect(serialized).toContain("agent_send");
		expect(serialized).toContain("received");
		expect(serialized).not.toContain('"type":"tool_use"');
		expect(stats.toolsDegraded).toBe(1);
	});

	it("degrades unsigned thinking to ordinary assistant text", () => {
		const { records, stats } = toClaudeRecords(transcript([
			{ role: "assistant", ts: 1, blocks: [{ kind: "thinking", text: "reason" }] },
		]), {}, "claude-1");

		expect(text(records)).toContain("[Imported reasoning]\\nreason");
		expect(text(records)).not.toContain('"type":"thinking"');
		expect(stats.thinkingDegraded).toBe(1);
	});

	it("synthesizes a result for an unanswered tool call", () => {
		const { records, stats } = toClaudeRecords(transcript([
			{ role: "assistant", ts: 1, blocks: [{ kind: "toolCall", id: "c1", name: "bash", arguments: { command: "pwd" } }] },
		]), {}, "claude-1");

		expect(text(records)).toContain("recorded no result");
		expect(stats.resultsSynthesized).toBe(1);
	});

	it("drops pi harness metadata from Claude's model context", () => {
		const { records, stats } = toClaudeRecords(transcript([
			{ role: "meta", ts: 1, kind: "remote-pi", text: "mesh state" },
			{ role: "user", ts: 2, blocks: [{ kind: "text", text: "hello" }] },
		]), {}, "claude-1");

		expect(text(records)).not.toContain("mesh state");
		expect(stats.metaDropped).toBe(1);
	});

	it("writes the Claude metadata records used for resume and titles", () => {
		const { records } = toClaudeRecords({ ...transcript([{ role: "user", ts: 1, blocks: [{ kind: "text", text: "hello" }] }]), title: "imported" }, {}, "claude-1");

		expect(records.at(-2)).toMatchObject({ type: "last-prompt", sessionId: "claude-1", lastPrompt: "hello" });
		expect(records.at(-1)).toEqual({ type: "ai-title", sessionId: "claude-1", aiTitle: "imported" });
	});
});
