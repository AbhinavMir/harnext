import { describe, expect, it } from "vitest";
import { claudeProjectSlug, parseClaudeSession } from "../src/readers/claude-code.js";
import { assistantText, assistantToolUse, hookAttachment, jsonl, lastPrompt, toolResult, userStringContent, userText } from "./helpers.js";

describe("claudeProjectSlug", () => {
	it("replaces every character that is not alphanumeric", () => {
		expect(claudeProjectSlug("/Users/august/Code/abhinavmir.github.io")).toBe("-Users-august-Code-abhinavmir-github-io");
		expect(claudeProjectSlug("/Users/august/Code/admin_frontend")).toBe("-Users-august-Code-admin-frontend");
	});
});

describe("parseClaudeSession", () => {
	it("reads a plain exchange", () => {
		const text = jsonl([
			userText({ uuid: "a", parent: null }, "hello"),
			assistantText({ uuid: "b", parent: "a" }, "hi"),
			lastPrompt("b"),
		]);

		const transcript = parseClaudeSession(text);

		expect(transcript.source).toBe("claude-code");
		expect(transcript.cwd).toBe("/tmp/project");
		expect(transcript.model).toEqual({ provider: "anthropic", id: "claude-opus-5" });
		expect(transcript.messages).toHaveLength(2);
		expect(transcript.messages[0]).toMatchObject({ role: "user", blocks: [{ kind: "text", text: "hello" }] });
		expect(transcript.messages[1]).toMatchObject({ role: "assistant", model: "claude-opus-5" });
	});

	it("accepts message content given as a bare string", () => {
		const text = jsonl([userStringContent({ uuid: "a", parent: null }, "hello"), lastPrompt("a")]);

		const transcript = parseClaudeSession(text);

		expect(transcript.messages[0]).toMatchObject({ role: "user", blocks: [{ kind: "text", text: "hello" }] });
	});

	it("names tool results after the call that produced them", () => {
		const text = jsonl([
			userText({ uuid: "a", parent: null }, "read it"),
			assistantToolUse({ uuid: "b", parent: "a" }, { id: "call-1", name: "Read", input: { file_path: "/tmp/x" } }),
			toolResult({ uuid: "c", parent: "b" }, { id: "call-1", content: "file body" }),
			lastPrompt("c"),
		]);

		const transcript = parseClaudeSession(text);

		expect(transcript.messages[2]).toMatchObject({
			role: "toolResult",
			callId: "call-1",
			name: "Read",
			isError: false,
			blocks: [{ kind: "text", text: "file body" }],
		});
	});

	it("marks a failed tool result", () => {
		const text = jsonl([
			assistantToolUse({ uuid: "a", parent: null }, { id: "call-1", name: "Bash", input: { command: "false" } }),
			toolResult({ uuid: "b", parent: "a" }, { id: "call-1", content: "boom", isError: true }),
			lastPrompt("b"),
		]);

		const transcript = parseClaudeSession(text);

		expect(transcript.messages[1]).toMatchObject({ role: "toolResult", isError: true });
	});

	it("keeps thinking text and drops the provider signature", () => {
		const thinking = { type: "thinking", thinking: "let me see", signature: "sig-abc" };
		const text = jsonl([
			assistantToolUse({ uuid: "a", parent: null }, { id: "call-1", name: "Read", input: {} }, [thinking]),
			lastPrompt("a"),
		]);

		const transcript = parseClaudeSession(text);

		expect(transcript.messages[0]).toMatchObject({ blocks: [{ kind: "thinking", text: "let me see" }, { kind: "toolCall" }] });
		expect(JSON.stringify(transcript)).not.toContain("sig-abc");
		expect(transcript.notes.some((note) => note.code === "thinking.signature-dropped")).toBe(true);
	});

	it("keeps only the branch the session ended on", () => {
		const text = jsonl([
			userText({ uuid: "a", parent: null }, "first"),
			assistantText({ uuid: "abandoned", parent: "a" }, "answer that was rewound"),
			assistantText({ uuid: "kept", parent: "a" }, "answer that stayed"),
			lastPrompt("kept"),
		]);

		const transcript = parseClaudeSession(text);

		const texts = JSON.stringify(transcript.messages);
		expect(texts).toContain("answer that stayed");
		expect(texts).not.toContain("answer that was rewound");
		expect(transcript.notes.some((note) => note.code === "branch.records-off-active-branch")).toBe(true);
	});

	it("drops subagent sidechains", () => {
		const text = jsonl([
			userText({ uuid: "a", parent: null }, "go"),
			userText({ uuid: "b", parent: "a", sidechain: true }, "subagent prompt"),
			assistantText({ uuid: "c", parent: "b" }, "done"),
			lastPrompt("c"),
		]);

		const transcript = parseClaudeSession(text);

		expect(JSON.stringify(transcript.messages)).not.toContain("subagent prompt");
		expect(transcript.notes.some((note) => note.code === "sidechain.dropped")).toBe(true);
	});

	it("files hook output as a meta message", () => {
		const text = jsonl([
			userText({ uuid: "a", parent: null }, "go"),
			hookAttachment({ uuid: "b", parent: "a" }, "hook said this"),
			lastPrompt("b"),
		]);

		const transcript = parseClaudeSession(text);

		expect(transcript.messages[1]).toMatchObject({ role: "meta", kind: "hook_success", text: "hook said this" });
	});

	it("falls back to the newest record when no leaf is recorded", () => {
		const text = jsonl([userText({ uuid: "a", parent: null }, "hello"), assistantText({ uuid: "b", parent: "a" }, "hi")]);

		const transcript = parseClaudeSession(text);

		expect(transcript.messages).toHaveLength(2);
	});

	it("removes Claude's system reminders from user turns", () => {
		const text = jsonl([
			userText({ uuid: "a", parent: null }, "fix the bug\n<system-reminder>the user has skill X installed</system-reminder>"),
			lastPrompt("a"),
		]);

		const transcript = parseClaudeSession(text);

		expect(transcript.messages[0]).toMatchObject({ role: "user", blocks: [{ kind: "text", text: "fix the bug" }] });
		expect(transcript.notes.some((note) => note.code === "user.system-reminder-removed")).toBe(true);
	});

	it("drops a user turn that was nothing but a system reminder", () => {
		const text = jsonl([
			userText({ uuid: "a", parent: null }, "<system-reminder>plugin loaded</system-reminder>"),
			assistantText({ uuid: "b", parent: "a" }, "noted"),
			lastPrompt("b"),
		]);

		const transcript = parseClaudeSession(text);

		expect(transcript.messages.map((message) => message.role)).toEqual(["assistant"]);
	});

	it("keeps system reminders when asked to", () => {
		const text = jsonl([
			userText({ uuid: "a", parent: null }, "fix it\n<system-reminder>context</system-reminder>"),
			lastPrompt("a"),
		]);

		const transcript = parseClaudeSession(text, { keepSystemReminders: true });

		expect(JSON.stringify(transcript.messages)).toContain("system-reminder");
	});

	it("counts malformed lines instead of failing", () => {
		const text = `${jsonl([userText({ uuid: "a", parent: null }, "hello")])}not json\n`;

		const transcript = parseClaudeSession(text);

		expect(transcript.messages).toHaveLength(1);
		expect(transcript.notes.some((note) => note.code === "record.invalid-json")).toBe(true);
	});
});
