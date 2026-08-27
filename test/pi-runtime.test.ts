import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadPiSessionApi, PiNotFoundError, piSessionDirName, piSessionFileName } from "../src/pi-runtime.js";

let root: string;

async function fakePiPackage(directory: string, source: string): Promise<string> {
	const dist = join(directory, "dist");
	await mkdir(dist, { recursive: true });
	await writeFile(join(directory, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "9.9.9" }));
	await writeFile(join(dist, "index.js"), source);
	return directory;
}

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "harnext-runtime-"));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("loadPiSessionApi", () => {
	it("loads a package that exports SessionManager.inMemory", async () => {
		const directory = await fakePiPackage(join(root, "good"), "export const SessionManager = { inMemory: () => ({}) };\n");

		const api = await loadPiSessionApi({ override: directory });

		expect(api.version).toBe("9.9.9");
		expect(api.origin).toBe(directory);
	});

	it("reports why a package would not load, instead of calling pi missing", async () => {
		// A syntax error stands in for the real case: pi's code needs a newer
		// Node than the one running harnext.
		const directory = await fakePiPackage(join(root, "broken"), "export const SessionManager = { inMemory: (\n");

		await expect(loadPiSessionApi({ override: directory })).rejects.toThrow(PiNotFoundError);
		await expect(loadPiSessionApi({ override: directory })).rejects.toThrow(/could not load its session code/);
	});

	it("names the package that exports no SessionManager", async () => {
		const directory = await fakePiPackage(join(root, "empty"), "export const nothing = 1;\n");

		await expect(loadPiSessionApi({ override: directory })).rejects.toThrow(/no usable SessionManager/);
	});

	it("carries the failures on the error for callers to inspect", async () => {
		const directory = await fakePiPackage(join(root, "empty2"), "export const nothing = 1;\n");

		const error = await loadPiSessionApi({ override: directory }).catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(PiNotFoundError);
		expect((error as PiNotFoundError).failures[0]?.root).toBe(directory);
	});
});

describe("pi path rules", () => {
	it("names a session directory the way pi does", () => {
		expect(piSessionDirName("/Users/august/Code/harnext")).toBe("--Users-august-Code-harnext--");
	});

	it("names a session file the way pi does", () => {
		expect(piSessionFileName({ type: "session", id: "abc", timestamp: "2026-08-26T22:31:58.253Z" })).toBe(
			"2026-08-26T22-31-58-253Z_abc.jsonl",
		);
	});
});
