/**
 * The writer drives pi's own SessionManager, so the honest test of "did this
 * produce a pi session" is to load the result back through pi and build the
 * context pi would send to a model.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { digestTranscript } from "../src/digest.js";
import { parseClaudeSession } from "../src/readers/claude-code.js";
import { writeToPi } from "../src/writers/pi.js";
import { assistantText, assistantToolUse, hookAttachment, jsonl, lastPrompt, toolResult, userText } from "./helpers.js";

const session = jsonl([
	userText({ uuid: "a", parent: null }, "read the readme"),
	hookAttachment({ uuid: "b", parent: "a" }, "session start hook"),
	assistantToolUse({ uuid: "c", parent: "b" }, { id: "call-1", name: "Read", input: { file_path: "/tmp/project/README.md" } }, [
		{ type: "thinking", thinking: "open it", signature: "sig" },
	]),
	toolResult({ uuid: "d", parent: "c" }, { id: "call-1", content: "# project" }),
	assistantToolUse({ uuid: "e", parent: "d" }, { id: "call-2", name: "TodoWrite", input: { todos: ["done"] } }),
	toolResult({ uuid: "f", parent: "e" }, { id: "call-2", content: "noted" }),
	assistantText({ uuid: "g", parent: "f" }, "the readme is a stub"),
	lastPrompt("g"),
]);

let root: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "harnext-"));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("Claude Code to pi", () => {
	it("writes a session pi can open", async () => {
		const transcript = parseClaudeSession(session);

		const result = await writeToPi(transcript, { sessionsRoot: root, name: "imported" });

		const opened = SessionManager.open(result.path);
		expect(opened.getSessionId()).toBe(result.sessionId);
		expect(opened.getHeader()?.cwd).toBe("/tmp/project");
		expect(opened.getSessionName()).toBe("imported");
	});

	it("builds a context pi can send to a model", async () => {
		const transcript = parseClaudeSession(session);

		const result = await writeToPi(transcript, { sessionsRoot: root });
		const context = SessionManager.open(result.path).buildSessionContext();

		expect(context.messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
			"assistant",
			"assistant",
		]);
		expect(context.model).toEqual({ provider: "anthropic", modelId: "claude-opus-5" });
	});

	it("answers every tool call it puts in the context", async () => {
		const transcript = parseClaudeSession(session);

		const result = await writeToPi(transcript, { sessionsRoot: root });
		const context = SessionManager.open(result.path).buildSessionContext();

		const calls = new Set<string>();
		const answered = new Set<string>();
		for (const message of context.messages) {
			if (message.role === "assistant") {
				for (const block of message.content) {
					if (block.type === "toolCall") calls.add(block.id);
				}
			}
			if (message.role === "toolResult") answered.add(message.toolCallId);
		}

		expect([...calls]).toEqual(["call-1"]);
		expect([...answered]).toEqual(["call-1"]);
	});

	it("keeps hook output out of the model's context", async () => {
		const transcript = parseClaudeSession(session);

		const result = await writeToPi(transcript, { sessionsRoot: root });
		const opened = SessionManager.open(result.path);

		const custom = opened.getEntries().filter((entry) => entry.type === "custom");
		expect(custom.map((entry) => entry.customType)).toEqual(["harnext:claude-hook_success"]);
		expect(JSON.stringify(opened.buildSessionContext().messages)).not.toContain("session start hook");
	});

	it("drops the Anthropic thinking signature but keeps the thinking", async () => {
		const transcript = parseClaudeSession(session);

		const result = await writeToPi(transcript, { sessionsRoot: root });
		const context = SessionManager.open(result.path).buildSessionContext();

		const serialized = JSON.stringify(context.messages);
		expect(serialized).toContain("open it");
		expect(serialized).not.toContain("sig");
	});

	it("writes a digest session as a single opening message", async () => {
		const transcript = digestTranscript(parseClaudeSession(session));

		const result = await writeToPi(transcript, { sessionsRoot: root });
		const context = SessionManager.open(result.path).buildSessionContext();

		expect(context.messages).toHaveLength(1);
		expect(context.messages[0]?.role).toBe("user");
	});
});
