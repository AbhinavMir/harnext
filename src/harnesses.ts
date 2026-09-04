/** Unified harness registry used by selection, sync, watchdog, and chat launching. */

import { execFile } from "node:child_process";
import { access, readdir, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { HARNESS_ADAPTERS, harnessAdapter, type HarnessId, type WriteChatOptions } from "./adapters/index.js";
import type { Transcript } from "./ir.js";

const exec = promisify(execFile);

export type { HarnessAdapter, HarnessId, WriteChatOptions } from "./adapters/index.js";

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

export interface WrittenChat {
	harness: HarnessId;
	path: string;
	sessionId: string;
	resumeCommand: string;
}

export const HARNESSES: HarnessId[] = HARNESS_ADAPTERS.map((adapter) => adapter.id);
export const HARNESS_LABELS = Object.fromEntries(HARNESS_ADAPTERS.map((adapter) => [adapter.id, adapter.label])) as Record<HarnessId, string>;

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
	const checks = await Promise.all(HARNESS_ADAPTERS.map((adapter) => commandExists(adapter.command)));
	return HARNESS_ADAPTERS.filter((_, index) => checks[index]).map((adapter) => adapter.id);
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
	return harnessAdapter(chat.harness).read(chat.path);
}

export async function inspectChat(harness: HarnessId, path: string): Promise<ChatInfo | undefined> {
	try {
		const transcript = await harnessAdapter(harness).read(path);
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
	const groups = await Promise.all(HARNESS_ADAPTERS.map(async (adapter) => (await adapter.findRepoChats(absolute)).map((chat) => ({ harness: adapter.id, ...chat }))));
	return groups.flat().sort((a, b) => b.modifiedAt - a.modifiedAt);
}

export async function findAllChats(): Promise<ChatInfo[]> {
	const groups = await Promise.all(HARNESS_ADAPTERS.flatMap((adapter) => adapter.storeRoots().map(async (root) => Promise.all((await walkJsonl(root)).map((path) => inspectChat(adapter.id, path))))));
	return groups.flat().filter((chat): chat is ChatInfo => chat !== undefined).sort((a, b) => b.modifiedAt - a.modifiedAt);
}

export function resumeCommandFor(harness: HarnessId, sessionId: string, cwd: string): string {
	return harnessAdapter(harness).resumeCommand(sessionId, cwd);
}

export async function writeChat(target: HarnessId, transcript: Transcript, options: WriteChatOptions = {}): Promise<WrittenChat> {
	const adapter = harnessAdapter(target);
	const result = await adapter.write(transcript, options);
	return { harness: target, path: result.path, sessionId: result.sessionId, resumeCommand: adapter.resumeCommand(result.sessionId, transcript.cwd) };
}

export function currentChatFromEnvironment(): { harness: HarnessId; path?: string; sessionId?: string } | undefined {
	for (const adapter of HARNESS_ADAPTERS) {
		const current = adapter.currentChat();
		if (current !== undefined) return { harness: adapter.id, ...current };
	}
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
	const rows = HARNESS_ADAPTERS.map((adapter) => ({ harness: adapter.id, installed: installed.has(adapter.id), root: adapter.storeRoots()[0] ?? "" }));
	await Promise.all(rows.map(async (row) => { if (!row.installed && row.root !== "" && await exists(row.root)) row.installed = true; }));
	return rows;
}
