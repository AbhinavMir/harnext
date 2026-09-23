import { describe, expect, it } from "vitest";
import type { Transcript } from "../src/ir.js";
import { searchTranscript } from "../src/harnesses.js";

function transcript(overrides: Partial<Transcript> = {}): Transcript {
	return {
		source: "pi",
		sessionId: "s1",
		cwd: "/tmp/project",
		createdAt: 0,
		messages: [],
		notes: [],
		...overrides,
	};
}

describe("searchTranscript", () => {
	it("matches case-insensitively across prompts, replies, reasoning and tool calls", () => {
		const t = transcript({
			title: "Auth work",
			messages: [
				{ role: "user", ts: 1, blocks: [{ kind: "text", text: "fix the LOGIN flow" }] },
				{ role: "assistant", ts: 2, blocks: [
					{ kind: "thinking", text: "the login token expires" },
					{ kind: "toolCall", id: "c1", name: "read", arguments: { path: "login.ts" } },
				] },
			],
		});
		const hit = searchTranscript(t, "login");
		expect(hit?.matchCount).toBe(3);
		expect(hit?.snippet.toLowerCase()).toContain("login");
	});

	it("returns undefined when the term is absent or empty", () => {
		const t = transcript({ messages: [{ role: "user", ts: 1, blocks: [{ kind: "text", text: "hello" }] }] });
		expect(searchTranscript(t, "missing")).toBeUndefined();
		expect(searchTranscript(t, "")).toBeUndefined();
	});

	it("ignores image blocks and does not crash on them", () => {
		const t = transcript({
			title: "pixels",
			messages: [{ role: "user", ts: 1, blocks: [{ kind: "image", data: "AAAA", mimeType: "image/png" }] }],
		});
		expect(searchTranscript(t, "pixels")?.matchCount).toBe(1);
		expect(searchTranscript(t, "aaaa")).toBeUndefined();
	});
});
