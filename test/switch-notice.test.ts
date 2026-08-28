import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Transcript } from "../src/ir.js";
import { configureTellAgent, readConfig, shouldTellAgent, withSwitchNotice } from "../src/switch-notice.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const transcript: Transcript = {
	source: "pi",
	sessionId: "source",
	cwd: "/tmp/project",
	createdAt: 1_700_000_000_000,
	messages: [{ role: "user", ts: 1_700_000_001_000, blocks: [{ kind: "text", text: "continue the task" }] }],
	notes: [],
};

describe("switch notice", () => {
	it("stores ask, always, and never configuration", async () => {
		const root = await mkdtemp(join(tmpdir(), "harnext-config-")); roots.push(root);
		const path = join(root, "config.json");
		expect(await shouldTellAgent({ configPath: path, interactive: false })).toBe(false);
		await configureTellAgent("always", path);
		expect(await shouldTellAgent({ configPath: path, interactive: false })).toBe(true);
		await configureTellAgent("never", path);
		expect(await readConfig(path)).toEqual({ version: 1, tellAgent: "never" });
		expect(await shouldTellAgent({ configPath: path, interactive: false })).toBe(false);
	});

	it("adds one model-visible notice and does not duplicate it", () => {
		const first = withSwitchNotice(transcript, "pi");
		const second = withSwitchNotice(first, "claude");
		expect(first.messages).toHaveLength(2);
		expect(second.messages).toHaveLength(2);
		expect(JSON.stringify(second.messages)).toContain("MCP servers");
		expect(JSON.stringify(second.messages)).toContain("copied from pi");
	});
});
