/** Exact live-session detection from process arguments and harness adapter evidence. */

import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { HARNESS_ADAPTERS, harnessAdapter } from "./adapters/index.js";
import type { ChatInfo } from "./harnesses.js";
import { currentChatFromEnvironment } from "./harnesses.js";

const exec = promisify(execFile);

async function processCommands(): Promise<string[]> {
	if (process.platform === "win32") {
		try { return (await exec("wmic", ["process", "get", "CommandLine"])).stdout.split("\n"); } catch { return []; }
	}
	try { return (await exec("ps", ["-axo", "command="])).stdout.split("\n"); } catch { return []; }
}

/** Conservative write protection: any harness process rooted in this repo may own the mirror. */
export async function harnessRunningInCwd(harness: ChatInfo["harness"], cwd: string): Promise<boolean> {
	if (process.platform === "win32") return false;
	const adapter = harnessAdapter(harness);
	let rows: string[];
	try { rows = (await exec("ps", ["-axo", "pid=,command="])).stdout.split("\n"); } catch { return false; }
	for (const row of rows) {
		const match = /^\s*(\d+)\s+(.*)$/.exec(row);
		if (match === null || !adapter.processMatches(match[2] ?? "")) continue;
		try {
			const output = await exec("lsof", ["-a", "-p", match[1] as string, "-d", "cwd", "-Fn"]);
			if (output.stdout.split("\n").some((line) => line.startsWith("n") && resolve(line.slice(1)) === resolve(cwd))) return true;
		} catch { continue; }
	}
	return false;
}

async function processCwdCandidates(chats: ChatInfo[]): Promise<Set<string>> {
	const alive = new Set<string>();
	if (process.platform === "win32") return alive;
	let rows: string[];
	try { rows = (await exec("ps", ["-axo", "pid=,lstart=,command="])).stdout.split("\n"); } catch { return alive; }
	for (const row of rows) {
		const match = /^\s*(\d+)\s+(.{24})\s+(.*)$/.exec(row);
		if (match === null) continue;
		const adapter = HARNESS_ADAPTERS.find((candidate) => candidate.processMatches(match[3] ?? ""));
		if (adapter === undefined) continue;
		let cwd: string | undefined;
		try {
			const output = await exec("lsof", ["-a", "-p", match[1] as string, "-d", "cwd", "-Fn"]);
			cwd = output.stdout.split("\n").find((line) => line.startsWith("n"))?.slice(1);
		} catch { continue; }
		if (cwd === undefined) continue;
		const startedAt = Date.parse(match[2] as string);
		const candidates = chats.filter((chat) => chat.harness === adapter.id && resolve(chat.cwd) === resolve(cwd as string) && (Number.isNaN(startedAt) || chat.modifiedAt >= startedAt));
		const newest = candidates.sort((a, b) => b.modifiedAt - a.modifiedAt)[0];
		if (newest !== undefined) alive.add(resolve(newest.path));
	}
	return alive;
}

export async function markAlive(chats: ChatInfo[]): Promise<ChatInfo[]> {
	const commands = await processCommands();
	const [adapterEvidence, cwdCandidates] = await Promise.all([
		Promise.all(HARNESS_ADAPTERS.map(async (adapter) => [adapter.id, await adapter.activeChats?.(commands) ?? {}] as const)),
		processCwdCandidates(chats),
	]);
	const evidence = new Map(adapterEvidence.map(([id, active]) => [id, {
		paths: new Set((active.paths ?? []).map((path) => resolve(path))),
		sessionIds: new Set(active.sessionIds ?? []),
	}]));
	const current = currentChatFromEnvironment();
	return chats.map((chat) => {
		const id = chat.sessionId;
		const exactCurrent = current?.path !== undefined
			? resolve(current.path) === resolve(chat.path)
			: current?.harness === chat.harness && current.sessionId === id;
		const adapter = harnessAdapter(chat.harness);
		const commandMatch = /^[0-9a-f]{8}/i.test(id) && commands.some((command) => adapter.sessionProcessMatches(command, id));
		const active = evidence.get(chat.harness);
		const alive = exactCurrent || commandMatch || cwdCandidates.has(resolve(chat.path))
			|| active?.paths.has(resolve(chat.path)) === true
			|| active?.sessionIds.has(chat.sessionId) === true;
		return alive ? { ...chat, alive: true } : chat;
	});
}
