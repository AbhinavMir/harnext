/** Exact live-session detection from process arguments and harness terminal state. */

import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { ChatInfo } from "./harnesses.js";
import { currentChatFromEnvironment } from "./harnesses.js";

const exec = promisify(execFile);

async function processCommands(): Promise<string[]> {
	if (process.platform === "win32") {
		try { return (await exec("wmic", ["process", "get", "CommandLine"])).stdout.split("\n"); } catch { return []; }
	}
	try { return (await exec("ps", ["-axo", "command="])).stdout.split("\n"); } catch { return []; }
}

function harnessCommand(harness: ChatInfo["harness"], command: string): boolean {
	switch (harness) {
		case "claude": return /(^|[/ ])claude( |$)/.test(command) && !command.includes(" daemon ") && !command.includes("bg-pty");
		case "pi": return /(^|[/ ])pi( |$)/.test(command);
		case "omp": return /(^|[/ ])omp( |$)/.test(command);
		case "codex": return /(^|[/ ])codex( |$)/.test(command) && !command.includes("app-server");
	}
}

/** Conservative write protection: any harness process rooted in this repo may own the mirror. */
export async function harnessRunningInCwd(harness: ChatInfo["harness"], cwd: string): Promise<boolean> {
	if (process.platform === "win32") return false;
	let rows: string[];
	try { rows = (await exec("ps", ["-axo", "pid=,command="])).stdout.split("\n"); } catch { return false; }
	for (const row of rows) {
		const match = /^\s*(\d+)\s+(.*)$/.exec(row);
		if (match === null || !harnessCommand(harness, match[2] ?? "")) continue;
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
		const command = match[3] ?? "";
		const harness = (["claude", "pi", "omp", "codex"] as const).find((candidate) => harnessCommand(candidate, command));
		if (harness === undefined) continue;
		let cwd: string | undefined;
		try {
			const output = await exec("lsof", ["-a", "-p", match[1] as string, "-d", "cwd", "-Fn"]);
			cwd = output.stdout.split("\n").find((line) => line.startsWith("n"))?.slice(1);
		} catch { continue; }
		if (cwd === undefined) continue;
		const startedAt = Date.parse(match[2] as string);
		const candidates = chats.filter((chat) => chat.harness === harness && resolve(chat.cwd) === resolve(cwd as string) && (Number.isNaN(startedAt) || chat.modifiedAt >= startedAt));
		const newest = candidates.sort((a, b) => b.modifiedAt - a.modifiedAt)[0];
		if (newest !== undefined) alive.add(resolve(newest.path));
	}
	return alive;
}

async function activeCodexIds(commands: string[]): Promise<Set<string>> {
	const ids = new Set<string>();
	if (!commands.some((command) => /(^|[/ ])codex( |$)/.test(command) && command.includes("app-server"))) return ids;
	const directory = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "thread-writer-locks");
	let names: string[];
	try { names = await readdir(directory); } catch { return ids; }
	for (const name of names) if (name.endsWith(".lock") && name !== ".coordination.lock") ids.add(name.slice(0, -5));
	return ids;
}

async function activeOmpPaths(): Promise<Set<string>> {
	const active = new Set<string>();
	const directory = join(homedir(), ".omp", "agent", "terminal-sessions");
	let names: string[];
	try { names = await readdir(directory); } catch { return active; }
	for (const name of names) {
		let lines: string[];
		try { lines = (await readFile(join(directory, name), "utf8")).split("\n"); } catch { continue; }
		const path = lines[1]?.trim();
		if (path === undefined || path === "") continue;
		try {
			const output = await exec("ps", ["-t", name, "-o", "command="]);
			if (output.stdout.split("\n").some((command) => /(^|[/ ])omp( |$)/.test(command))) active.add(resolve(path));
		} catch { continue; }
	}
	return active;
}

export async function markAlive(chats: ChatInfo[]): Promise<ChatInfo[]> {
	const commands = await processCommands();
	const [ompPaths, codexIds, cwdCandidates] = await Promise.all([activeOmpPaths(), activeCodexIds(commands), processCwdCandidates(chats)]);
	const current = currentChatFromEnvironment();
	return chats.map((chat) => {
		const id = chat.sessionId;
		const exactCurrent = current?.path !== undefined
			? resolve(current.path) === resolve(chat.path)
			: current?.harness === chat.harness && current.sessionId === id;
		const commandMatch = /^[0-9a-f]{8}/i.test(id) && commands.some((command) => {
			const short = id.slice(0, 8);
			switch (chat.harness) {
				case "claude": return harnessCommand("claude", command) && (command.includes(`--session-id ${id}`) || command.includes(`--resume ${id}`));
				case "pi": return harnessCommand("pi", command) && (command.includes(`--session ${id}`) || command.includes(`--session ${short}`));
				case "omp": return harnessCommand("omp", command) && (command.includes(`--resume=${id}`) || command.includes(`--resume=${short}`));
				case "codex": return harnessCommand("codex", command) && (command.includes(`resume ${id}`) || command.includes(`resume ${short}`));
			}
		});
		const alive = exactCurrent || commandMatch || cwdCandidates.has(resolve(chat.path))
			|| (chat.harness === "omp" && ompPaths.has(resolve(chat.path)))
			|| (chat.harness === "codex" && codexIds.has(chat.sessionId));
		return alive ? { ...chat, alive: true } : chat;
	});
}
