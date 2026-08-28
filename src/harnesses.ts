/** Unified harness registry used by selection, sync, and watchdog. */

import { execFile } from "node:child_process";
import { access, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { Transcript } from "./ir.js";
import { claudeProjectsRoot, findClaudeSessions, readClaudeSessionFile } from "./readers/claude-code.js";
import { defaultCodexRoot, findCodexSessions, readCodexSessionFile } from "./readers/codex.js";
import { defaultOmpSessionsRoot, findOmpSessions, readOmpSessionFile } from "./readers/omp.js";
import { defaultPiSessionsRoot, findPiSessions, readPiSessionFile } from "./readers/pi.js";
import { writeToClaudeCode } from "./writers/claude-code.js";
import { writeToCodex } from "./writers/codex.js";
import { writeToOmp } from "./writers/omp.js";
import { writeToPi } from "./writers/pi.js";

const exec = promisify(execFile);

export type HarnessId = "claude" | "pi" | "omp" | "codex";

export interface ChatInfo {
	harness: HarnessId;
	path: string;
	sessionId: string;
	cwd: string;
	modifiedAt: number;
	title?: string;
	firstPrompt?: string;
	archived?: boolean;
	alive?: boolean;
}

export interface WriteChatOptions {
	path?: string;
	sessionId?: string;
	overwrite?: boolean;
	name?: string;
}

export interface WrittenChat {
	harness: HarnessId;
	path: string;
	sessionId: string;
	resumeCommand: string;
}

export const HARNESS_LABELS: Record<HarnessId, string> = {
	claude: "Claude Code",
	pi: "pi",
	omp: "Oh My Pi",
	codex: "Codex",
};

export const HARNESSES: HarnessId[] = ["claude", "pi", "omp", "codex"];

function compactPrompt(transcript: Transcript): string | undefined {
	const first = transcript.messages.find((message) => message.role === "user");
	if (first?.role !== "user") return undefined;
	const text = first.blocks.filter((block) => block.kind === "text").map((block) => block.kind === "text" ? block.text : "").join(" ").replace(/\s+/g, " ").trim();
	return text === "" ? undefined : text.slice(0, 120);
}

async function exists(path: string): Promise<boolean> {
	try { await access(path); return true; } catch { return false; }
}

async function commandExists(command: string): Promise<boolean> {
	try { await exec(process.platform === "win32" ? "where" : "which", [command]); return true; } catch { return false; }
}

export async function installedHarnesses(): Promise<HarnessId[]> {
	const checks = await Promise.all([
		commandExists("claude"),
		commandExists("pi"),
		commandExists("omp"),
		commandExists("codex"),
	]);
	return HARNESSES.filter((_, index) => checks[index]);
}

async function walkJsonl(root: string): Promise<string[]> {
	const paths: string[] = [];
	async function walk(directory: string): Promise<void> {
		let entries;
		try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
		await Promise.all(entries.map(async (entry) => {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) await walk(path);
			else if (entry.isFile() && entry.name.endsWith(".jsonl")) paths.push(path);
		}));
	}
	await walk(root);
	return paths;
}

export async function readChat(chat: Pick<ChatInfo, "harness" | "path">): Promise<Transcript> {
	switch (chat.harness) {
		case "claude": return readClaudeSessionFile(chat.path);
		case "pi": return readPiSessionFile(chat.path);
		case "omp": return readOmpSessionFile(chat.path);
		case "codex": return readCodexSessionFile(chat.path);
	}
}

export async function inspectChat(harness: HarnessId, path: string): Promise<ChatInfo | undefined> {
	try {
		const transcript = await readChat({ harness, path });
		if (transcript.cwd === "" || transcript.sessionId === path) return undefined;
		const firstPrompt = compactPrompt(transcript);
		return {
			harness,
			path,
			sessionId: transcript.sessionId,
			cwd: transcript.cwd,
			modifiedAt: (await stat(path)).mtimeMs,
			...(transcript.title === undefined ? {} : { title: transcript.title }),
			...(firstPrompt === undefined ? {} : { firstPrompt }),
			...(path.includes("/archived_sessions/") ? { archived: true } : {}),
		};
	} catch { return undefined; }
}

export async function findRepoChats(cwd: string): Promise<ChatInfo[]> {
	const absolute = resolve(cwd);
	const [claude, pi, omp, codex] = await Promise.all([
		findClaudeSessions(absolute),
		findPiSessions(absolute),
		findOmpSessions(absolute),
		findCodexSessions(absolute),
	]);
	return [
		...claude.map((chat) => ({ harness: "claude" as const, ...chat })),
		...pi.map((chat) => ({ harness: "pi" as const, ...chat })),
		...omp.map((chat) => ({ harness: "omp" as const, ...chat })),
		...codex.map((chat) => ({ harness: "codex" as const, ...chat })),
	].sort((a, b) => b.modifiedAt - a.modifiedAt);
}

export async function findAllChats(): Promise<ChatInfo[]> {
	const roots: [HarnessId, string][] = [
		["claude", claudeProjectsRoot()],
		["pi", defaultPiSessionsRoot()],
		["omp", defaultOmpSessionsRoot()],
		["codex", join(defaultCodexRoot(), "sessions")],
		["codex", join(defaultCodexRoot(), "archived_sessions")],
	];
	const groups = await Promise.all(roots.map(async ([harness, root]) => Promise.all((await walkJsonl(root)).map((path) => inspectChat(harness, path)))));
	return groups.flat().filter((chat): chat is ChatInfo => chat !== undefined).sort((a, b) => b.modifiedAt - a.modifiedAt);
}

export async function writeChat(target: HarnessId, transcript: Transcript, options: WriteChatOptions = {}): Promise<WrittenChat> {
	switch (target) {
		case "claude": {
			const result = await writeToClaudeCode(transcript, { path: options.path, sessionId: options.sessionId, overwrite: options.overwrite, title: options.name });
			return { harness: target, path: result.path, sessionId: result.sessionId, resumeCommand: `cd ${transcript.cwd} && claude --resume ${result.sessionId}` };
		}
		case "pi": {
			const result = await writeToPi(transcript, { path: options.path, sessionId: options.sessionId, overwrite: options.overwrite, name: options.name });
			return { harness: target, path: result.path, sessionId: result.sessionId, resumeCommand: `cd ${transcript.cwd} && pi --session ${result.sessionId.slice(0, 8)}` };
		}
		case "omp": {
			const result = await writeToOmp(transcript, { path: options.path, sessionId: options.sessionId, overwrite: options.overwrite, name: options.name });
			return { harness: target, path: result.path, sessionId: result.sessionId, resumeCommand: `cd ${transcript.cwd} && omp --resume ${result.sessionId.slice(0, 8)}` };
		}
		case "codex": {
			const result = await writeToCodex(transcript, { path: options.path, sessionId: options.sessionId, overwrite: options.overwrite, title: options.name });
			return { harness: target, path: result.path, sessionId: result.sessionId, resumeCommand: `cd ${transcript.cwd} && codex resume ${result.sessionId}` };
		}
	}
}

export function currentChatFromEnvironment(): { harness: HarnessId; path?: string; sessionId?: string } | undefined {
	const piFile = process.env.PI_SESSION_FILE;
	if (piFile !== undefined && piFile !== "") return { harness: piFile.includes(`${join(homedir(), ".omp")}/`) ? "omp" : "pi", path: piFile, sessionId: process.env.PI_SESSION_ID };
	const ompFile = process.env.OMP_SESSION_FILE;
	if (ompFile !== undefined && ompFile !== "") return { harness: "omp", path: ompFile, sessionId: process.env.OMP_SESSION_ID };
	const claudeId = process.env.CLAUDE_SESSION_ID;
	if (claudeId !== undefined && claudeId !== "") return { harness: "claude", sessionId: claudeId };
	const codexId = process.env.CODEX_THREAD_ID ?? process.env.CODEX_SESSION_ID;
	if (codexId !== undefined && codexId !== "") return { harness: "codex", sessionId: codexId };
	return undefined;
}

export async function resolveCurrentChat(cwd: string, inputChats?: ChatInfo[]): Promise<ChatInfo | undefined> {
	const chats = inputChats ?? await findRepoChats(cwd);
	const current = currentChatFromEnvironment();
	if (current !== undefined) {
		if (current.path !== undefined) {
			const currentPath = resolve(current.path);
			const found = chats.find((chat) => resolve(chat.path) === currentPath);
			if (found !== undefined) return found;
			const inspected = await inspectChat(current.harness, currentPath);
			if (inspected !== undefined) return inspected;
		}
		if (current.sessionId !== undefined) {
			const found = chats.find((chat) => chat.harness === current.harness && chat.sessionId === current.sessionId);
			if (found !== undefined) return found;
		}
	}
	return chats[0];
}

export function shortProject(cwd: string): string {
	return basename(cwd) || cwd;
}

export async function harnessStoreStatus(): Promise<{ harness: HarnessId; installed: boolean; root: string }[]> {
	const installed = new Set(await installedHarnesses());
	const rows: { harness: HarnessId; installed: boolean; root: string }[] = [
		{ harness: "claude", installed: installed.has("claude"), root: claudeProjectsRoot() },
		{ harness: "pi", installed: installed.has("pi"), root: defaultPiSessionsRoot() },
		{ harness: "omp", installed: installed.has("omp"), root: defaultOmpSessionsRoot() },
		{ harness: "codex", installed: installed.has("codex"), root: defaultCodexRoot() },
	];
	await Promise.all(rows.map(async (row) => { if (!row.installed && await exists(row.root)) row.installed = true; }));
	return rows;
}
