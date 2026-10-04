/**
 * Active-agent inventory for `harnext ls`.
 *
 * Reports the running chats on the system with two extra signals read straight
 * from each harness's own records: cumulative token usage, and whether a Claude
 * Code remote-control (IDE) connection is open on that chat's working directory.
 * Signals a harness does not record stay undefined; the command prints them as
 * "—" rather than inventing a value.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { findAllChats, type ChatInfo, type HarnessId } from "./harnesses.js";
import { markAlive } from "./alive.js";

export interface ActiveAgent extends ChatInfo {
	/** Cumulative tokens the harness recorded for this chat, when it records any. */
	tokens?: number;
	/** Remote connection open for this chat; undefined where the harness has no remote concept. */
	remote?: boolean;
}

/** Sum the distinct tokens a transcript records; cache re-reads are excluded so turns are not double counted. */
export function parseTokenUsage(harness: HarnessId, text: string): number | undefined {
	if (harness === "claude") {
		let total = 0;
		let seen = false;
		for (const line of text.split("\n")) {
			if (!line.includes("\"usage\"")) continue;
			try {
				const usage = (JSON.parse(line) as { message?: { usage?: Record<string, unknown> } }).message?.usage;
				if (usage === undefined) continue;
				const field = (key: string): number => (typeof usage[key] === "number" ? usage[key] as number : 0);
				total += field("input_tokens") + field("cache_creation_input_tokens") + field("output_tokens");
				seen = true;
			} catch { /* skip malformed line */ }
		}
		return seen ? total : undefined;
	}
	if (harness === "codex") {
		let max = 0;
		let seen = false;
		for (const match of text.matchAll(/"total_tokens"\s*:\s*(\d+)/g)) {
			max = Math.max(max, Number(match[1]));
			seen = true;
		}
		return seen ? max : undefined;
	}
	return undefined;
}

async function tokenUsage(harness: HarnessId, path: string): Promise<number | undefined> {
	try { return parseTokenUsage(harness, await readFile(path, "utf8")); } catch { return undefined; }
}

/** Claude Code session ids that have a remote bridge open, read from the daemon's session registry. */
export async function claudeRemoteSessionIds(directory = join(homedir(), ".claude", "sessions")): Promise<Set<string>> {
	const ids = new Set<string>();
	let names: string[];
	try { names = await readdir(directory); } catch { return ids; }
	await Promise.all(names.filter((name) => name.endsWith(".json")).map(async (name) => {
		try {
			const entry = JSON.parse(await readFile(join(directory, name), "utf8")) as { sessionId?: unknown; bridgeSessionId?: unknown };
			if (typeof entry.sessionId === "string" && typeof entry.bridgeSessionId === "string" && entry.bridgeSessionId !== "") ids.add(entry.sessionId);
		} catch { /* skip unreadable entry */ }
	}));
	return ids;
}

/** Whether pi's remote mesh broker is running on this machine. */
export async function piRemoteActive(): Promise<boolean> {
	for (const base of [join(homedir(), ".pi", "remote"), join(homedir(), ".config", "pi", "remote")]) {
		try { await stat(join(base, "sessions", "local", "broker.sock")); return true; } catch { /* try next */ }
	}
	return false;
}

/** Every running chat on the system, with token usage and remote status attached. */
export async function listActiveAgents(): Promise<ActiveAgent[]> {
	const alive = (await markAlive(await findAllChats())).filter((chat) => chat.alive === true);
	const [remoteClaude, remotePi] = await Promise.all([claudeRemoteSessionIds(), piRemoteActive()]);
	return Promise.all(alive.map(async (chat) => ({
		...chat,
		tokens: await tokenUsage(chat.harness, chat.path),
		...(chat.harness === "claude" ? { remote: remoteClaude.has(chat.sessionId) } : {}),
		...(chat.harness === "pi" ? { remote: remotePi } : {}),
	})));
}
