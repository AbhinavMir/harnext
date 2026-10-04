/**
 * Active-agent inventory for `harnext ls`.
 *
 * Reports the running chats on the system with two extra signals read straight
 * from each harness's own records: cumulative token usage, and whether a Claude
 * Code remote-control (IDE) connection is open on that chat's working directory.
 * Signals a harness does not record stay undefined; the command prints them as
 * "—" rather than inventing a value.
 */

import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { findAllChats, type ChatInfo, type HarnessId } from "./harnesses.js";
import { markAlive } from "./alive.js";

export interface ActiveAgent extends ChatInfo {
	/** Cumulative tokens the harness recorded for this chat, when it records any. */
	tokens?: number;
	/** Claude Code remote-control (IDE) connection open on this chat's cwd; undefined where the concept does not apply. */
	rc?: boolean;
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

/** Working directories with an open Claude Code remote-control (IDE) lock. */
export async function remoteControlCwds(): Promise<Set<string>> {
	const directory = join(homedir(), ".claude", "ide");
	const cwds = new Set<string>();
	let names: string[];
	try { names = await readdir(directory); } catch { return cwds; }
	await Promise.all(names.filter((name) => name.endsWith(".lock")).map(async (name) => {
		try {
			const lock = JSON.parse(await readFile(join(directory, name), "utf8")) as { workspaceFolders?: unknown };
			if (Array.isArray(lock.workspaceFolders)) for (const folder of lock.workspaceFolders) if (typeof folder === "string") cwds.add(resolve(folder));
		} catch { /* skip unreadable lock */ }
	}));
	return cwds;
}

/** Every running chat on the system, with token usage and Claude remote-control status attached. */
export async function listActiveAgents(): Promise<ActiveAgent[]> {
	const alive = (await markAlive(await findAllChats())).filter((chat) => chat.alive === true);
	const rcCwds = await remoteControlCwds();
	return Promise.all(alive.map(async (chat) => ({
		...chat,
		tokens: await tokenUsage(chat.harness, chat.path),
		...(chat.harness === "claude" ? { rc: rcCwds.has(resolve(chat.cwd)) } : {}),
	})));
}
