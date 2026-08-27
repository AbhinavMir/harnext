import { describe, expect, it } from "vitest";
import { parsePiSession } from "../src/readers/pi.js";

function jsonl(records: unknown[]): string {
	return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

const header = { type: "session", version: 3, id: "pi-1", timestamp: "2026-08-27T00:00:00.000Z", cwd: "/tmp/project" };

describe("parsePiSession", () => {
	it("reads messages, model and title from a v3 session", () => {
		const transcript = parsePiSession(jsonl([
			header,
			{ type: "session_info", id: "n", parentId: null, timestamp: "2026-08-27T00:00:00.001Z", name: "my work" },
			{ type: "model_change", id: "m", parentId: "n", timestamp: "2026-08-27T00:00:00.002Z", provider: "openai", modelId: "gpt-5" },
			{ type: "message", id: "u", parentId: "m", timestamp: "2026-08-27T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "hello" }] } },
			{ type: "message", id: "a", parentId: "u", timestamp: "2026-08-27T00:00:02.000Z", message: { role: "assistant", model: "gpt-5", content: [{ type: "text", text: "hi" }] } },
		]));

		expect(transcript).toMatchObject({ source: "pi", sessionId: "pi-1", cwd: "/tmp/project", title: "my work" });
		expect(transcript.model).toEqual({ provider: "openai", id: "gpt-5" });
		expect(transcript.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
	});

	it("reads tool calls, results, thinking and images", () => {
		const transcript = parsePiSession(jsonl([
			header,
			{ type: "message", id: "a", parentId: null, timestamp: "2026-08-27T00:00:01Z", message: { role: "assistant", content: [
				{ type: "thinking", thinking: "reason" },
				{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "x" } },
			] } },
			{ type: "message", id: "r", parentId: "a", timestamp: "2026-08-27T00:00:02Z", message: { role: "toolResult", toolCallId: "call-1", toolName: "read", isError: false, content: [
				{ type: "text", text: "body" },
				{ type: "image", data: "abc", mimeType: "image/png" },
			] } },
		]));

		expect(transcript.messages[0]).toMatchObject({ role: "assistant", blocks: [
			{ kind: "thinking", text: "reason" },
			{ kind: "toolCall", id: "call-1", name: "read", arguments: { path: "x" } },
		] });
		expect(transcript.messages[1]).toMatchObject({ role: "toolResult", name: "read", blocks: [
			{ kind: "text", text: "body" },
			{ kind: "image", data: "abc", mimeType: "image/png" },
		] });
	});

	it("keeps custom records as meta outside normal conversation", () => {
		const transcript = parsePiSession(jsonl([
			header,
			{ type: "custom", id: "c", parentId: null, timestamp: "2026-08-27T00:00:01Z", customType: "remote-pi", data: { state: "connected" } },
		]));

		expect(transcript.messages[0]).toMatchObject({ role: "meta", kind: "remote-pi", text: '{"state":"connected"}' });
	});

	it("keeps only the active leaf branch", () => {
		const transcript = parsePiSession(jsonl([
			header,
			{ type: "message", id: "u", parentId: null, timestamp: "2026-08-27T00:00:01Z", message: { role: "user", content: "go" } },
			{ type: "message", id: "old", parentId: "u", timestamp: "2026-08-27T00:00:02Z", message: { role: "assistant", content: "old" } },
			{ type: "message", id: "new", parentId: "u", timestamp: "2026-08-27T00:00:03Z", message: { role: "assistant", content: "new" } },
		]));

		expect(JSON.stringify(transcript.messages)).toContain("new");
		expect(JSON.stringify(transcript.messages)).not.toContain("old");
	});

	it("reads a v4 header and ignores interleaved lane records", () => {
		const transcript = parsePiSession(jsonl([
			{ kind: "header", version: 4, id: "v4", createdAt: 1_700_000_000_000, cwd: "/tmp/v4" },
			{ type: "message", id: "u", parentId: null, timestamp: 1_700_000_000_001, message: { role: "user", content: "hello" } },
			{ type: "operation_started", id: "op", seq: 2, lane: "main", timestamp: 1_700_000_000_002 },
		]));

		expect(transcript).toMatchObject({ sessionId: "v4", cwd: "/tmp/v4", createdAt: 1_700_000_000_000 });
		expect(transcript.messages).toHaveLength(1);
	});
});
