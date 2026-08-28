import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Transcript } from "../src/ir.js";
import { readClaudeSessionFile } from "../src/readers/claude-code.js";
import { readOmpSessionFile } from "../src/readers/omp.js";
import { transcriptFingerprint, watchdogIteration, type SyncGroup } from "../src/sync.js";
import { writeToClaudeCode } from "../src/writers/claude-code.js";
import { writeToOmp } from "../src/writers/omp.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function transcript(messages = 1): Transcript {
	return {
		source: "oh-my-pi",
		sessionId: "source",
		cwd: "/tmp/sync-project",
		createdAt: 1_700_000_000_000,
		title: "Synced chat",
		messages: Array.from({ length: messages }, (_, offset) => ({ role: "user" as const, ts: 1_700_000_001_000 + offset, blocks: [{ kind: "text" as const, text: `prompt ${offset + 1}` }] })),
		notes: [],
	};
}

async function fixture(): Promise<{ root: string; group: SyncGroup; ompPath: string; claudePath: string }> {
	const root = await mkdtemp(join(tmpdir(), "harnext-sync-")); roots.push(root);
	const omp = await writeToOmp(transcript(), { sessionsRoot: join(root, "omp"), sessionId: "omp-id" });
	const claude = await writeToClaudeCode(transcript(), { projectsRoot: join(root, "claude"), sessionId: "claude-id" });
	const ompFingerprint = transcriptFingerprint(await readOmpSessionFile(omp.path));
	const claudeFingerprint = transcriptFingerprint(await readClaudeSessionFile(claude.path));
	return {
		root,
		ompPath: omp.path,
		claudePath: claude.path,
		group: {
			version: 1,
			id: "group",
			cwd: "/tmp/sync-project",
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			members: {
				omp: { harness: "omp", path: omp.path, sessionId: "omp-id", fingerprint: ompFingerprint },
				claude: { harness: "claude", path: claude.path, sessionId: "claude-id", fingerprint: claudeFingerprint },
			},
		},
	};
}

describe("watchdog", () => {
	it("propagates the only changed member to inactive mirrors", async () => {
		const item = await fixture();
		await writeToOmp(transcript(2), { path: item.ompPath, sessionId: "omp-id", overwrite: true });
		const event = await watchdogIteration(item.group, join(item.root, "state"));
		expect(event.type).toBe("synced");
		expect(JSON.stringify((await readClaudeSessionFile(item.claudePath)).messages)).toContain("prompt 2");
	});

	it("stops before overwriting concurrent divergent changes", async () => {
		const item = await fixture();
		await writeToOmp(transcript(2), { path: item.ompPath, sessionId: "omp-id", overwrite: true });
		await writeToClaudeCode(transcript(3), { path: item.claudePath, sessionId: "claude-id", overwrite: true });
		await expect(watchdogIteration(item.group, join(item.root, "state"))).rejects.toThrow("Sync conflict");
	});
});
