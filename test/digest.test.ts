import { describe, expect, it } from "vitest";
import { digestText, digestTranscript } from "../src/digest.js";
import type { Transcript } from "../src/ir.js";

const transcript: Transcript = {
	source: "claude-code",
	sessionId: "session-1",
	cwd: "/tmp/project",
	createdAt: Date.parse("2026-08-26T10:00:00.000Z"),
	title: "add the parser",
	messages: [
		{ role: "user", ts: 1, blocks: [{ kind: "text", text: "add a parser" }] },
		{
			role: "assistant",
			ts: 2,
			blocks: [
				{ kind: "toolCall", id: "c1", name: "Write", arguments: { file_path: "/tmp/project/parser.ts", content: "x" } },
				{ kind: "toolCall", id: "c2", name: "Bash", arguments: { command: "npm test" } },
			],
		},
		{ role: "toolResult", ts: 3, callId: "c1", name: "Write", isError: false, blocks: [{ kind: "text", text: "ok" }] },
		{ role: "assistant", ts: 4, blocks: [{ kind: "text", text: "parser added, tests pass" }] },
	],
	notes: [],
};

describe("digestText", () => {
	it("states where the session came from", () => {
		const text = digestText(transcript);

		expect(text).toContain("2026-08-26T10:00:00.000Z");
		expect(text).toContain("/tmp/project");
		expect(text).toContain("add the parser");
	});

	it("lists the prompts, the files changed and the commands run", () => {
		const text = digestText(transcript);

		expect(text).toContain("1. add a parser");
		expect(text).toContain("`/tmp/project/parser.ts`");
		expect(text).toContain("`npm test`");
	});

	it("ends with the last thing the assistant said", () => {
		expect(digestText(transcript)).toContain("parser added, tests pass");
	});

	it("leaves out sections it has nothing for", () => {
		const empty = digestText({ ...transcript, messages: [] });

		expect(empty).not.toContain("## Files written or edited");
		expect(empty).not.toContain("## Commands run");
	});
});

describe("digestTranscript", () => {
	it("replaces the whole conversation with one user message", () => {
		const digested = digestTranscript(transcript);

		expect(digested.messages).toHaveLength(1);
		expect(digested.messages[0]).toMatchObject({ role: "user" });
		expect(digested.sessionId).toBe(transcript.sessionId);
	});
});
