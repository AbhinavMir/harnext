import { describe, expect, it } from "vitest";
import { parseTokenUsage } from "../src/agents.js";

describe("parseTokenUsage", () => {
	it("sums distinct Claude Code tokens and excludes cache reads", () => {
		const text = [
			JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 9999, output_tokens: 20 } } }),
			JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 9999, output_tokens: 4 } } }),
			JSON.stringify({ type: "user", message: { role: "user", content: [] } }),
		].join("\n");
		// (10+5+20) + (1+0+4) = 40, cache_read ignored
		expect(parseTokenUsage("claude", text)).toBe(40);
	});

	it("takes the running total for Codex", () => {
		const text = [
			JSON.stringify({ type: "event_msg", payload: { info: { total_token_usage: { input_tokens: 100, total_tokens: 100 } } } }),
			JSON.stringify({ type: "event_msg", payload: { info: { total_token_usage: { input_tokens: 300, total_tokens: 340 } } } }),
		].join("\n");
		expect(parseTokenUsage("codex", text)).toBe(340);
	});

	it("reports undefined when a harness records no usage", () => {
		expect(parseTokenUsage("pi", '{"anything":true}')).toBeUndefined();
		expect(parseTokenUsage("omp", '{"anything":true}')).toBeUndefined();
		expect(parseTokenUsage("claude", '{"type":"user"}')).toBeUndefined();
	});
});

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeRemoteSessionIds } from "../src/agents.js";

describe("claudeRemoteSessionIds", () => {
	it("reports a session remote only when it has a non-null bridgeSessionId", async () => {
		const dir = await mkdtemp(join(tmpdir(), "harnext-sessions-"));
		await writeFile(join(dir, "1.json"), JSON.stringify({ sessionId: "remote-one", bridgeSessionId: "session_abc" }));
		await writeFile(join(dir, "2.json"), JSON.stringify({ sessionId: "local-one", bridgeSessionId: null }));
		await writeFile(join(dir, "3.json"), JSON.stringify({ sessionId: "empty-bridge", bridgeSessionId: "" }));
		const ids = await claudeRemoteSessionIds(dir);
		expect(ids.has("remote-one")).toBe(true);
		expect(ids.has("local-one")).toBe(false);
		expect(ids.has("empty-bridge")).toBe(false);
	});
});
