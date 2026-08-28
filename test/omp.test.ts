import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Transcript } from "../src/ir.js";
import { parseOmpSession } from "../src/readers/omp.js";
import { writeToOmp } from "../src/writers/omp.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const transcript: Transcript = {
	source: "claude-code",
	sessionId: "source",
	cwd: "/tmp/omp-project",
	createdAt: 1_700_000_000_000,
	title: "OMP import",
	messages: [
		{ role: "user", ts: 1_700_000_001_000, blocks: [{ kind: "text", text: "first" }] },
		{ role: "assistant", ts: 1_700_000_002_000, blocks: [{ kind: "text", text: "answer" }] },
	],
	notes: [],
};

describe("Oh My Pi sessions", () => {
	it("writes a resumable v3 session and reads it back", async () => {
		const root = await mkdtemp(join(tmpdir(), "harnext-omp-")); roots.push(root);
		const written = await writeToOmp(transcript, { sessionsRoot: root, sessionId: "omp-session" });
		const parsed = parseOmpSession(await readFile(written.path, "utf8"), written.path);
		expect(parsed.source).toBe("oh-my-pi");
		expect(parsed.sessionId).toBe("omp-session");
		expect(parsed.title).toBe("OMP import");
		expect(parsed.messages.filter((message) => message.role === "user")).toHaveLength(1);
	});

	it("refreshes an existing mirror without changing its identity", async () => {
		const root = await mkdtemp(join(tmpdir(), "harnext-omp-")); roots.push(root);
		const first = await writeToOmp(transcript, { sessionsRoot: root, sessionId: "stable-id" });
		const updated = { ...transcript, messages: [...transcript.messages, { role: "user" as const, ts: 1_700_000_003_000, blocks: [{ kind: "text" as const, text: "new" }] }] };
		const second = await writeToOmp(updated, { path: first.path, sessionId: "stable-id", overwrite: true });
		expect(second.path).toBe(first.path);
		expect(parseOmpSession(await readFile(first.path, "utf8")).messages.at(-1)).toMatchObject({ role: "user" });
	});
});
