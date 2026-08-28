/** One-shot fan-out sync and conflict-stopping watchdog. */

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { harnessRunningInCwd, markAlive } from "./alive.js";
import { writeTextFile } from "./atomic.js";
import {
	HARNESSES,
	HARNESS_LABELS,
	findRepoChats,
	installedHarnesses,
	readChat,
	resolveCurrentChat,
	writeChat,
	type ChatInfo,
	type HarnessId,
} from "./harnesses.js";
import type { Transcript } from "./ir.js";

export interface SyncMember {
	harness: HarnessId;
	path: string;
	sessionId: string;
	fingerprint: string;
}

export interface SyncGroup {
	version: 1;
	id: string;
	cwd: string;
	createdAt: string;
	updatedAt: string;
	members: Partial<Record<HarnessId, SyncMember>>;
}

export interface SyncResult {
	group: SyncGroup;
	source: ChatInfo;
	written: SyncMember[];
	skippedAlive: SyncMember[];
	unavailable: HarnessId[];
}

export function defaultStateRoot(): string {
	return process.env.HARNEXT_STATE_DIR ?? join(homedir(), ".harnext");
}

function groupsRoot(stateRoot: string): string {
	return join(stateRoot, "groups");
}

function normalized(transcript: Transcript): unknown {
	return {
		cwd: resolve(transcript.cwd),
		title: transcript.title,
		model: transcript.model,
		messages: transcript.messages,
	};
}

export function transcriptFingerprint(transcript: Transcript): string {
	return createHash("sha256").update(JSON.stringify(normalized(transcript))).digest("hex");
}

async function fingerprint(chat: Pick<ChatInfo, "harness" | "path">): Promise<string> {
	return transcriptFingerprint(await readChat(chat));
}

async function loadGroups(stateRoot = defaultStateRoot()): Promise<SyncGroup[]> {
	let names: string[];
	try { names = await readdir(groupsRoot(stateRoot)); } catch { return []; }
	const groups = await Promise.all(names.filter((name) => name.endsWith(".json")).map(async (name) => {
		try {
			const parsed: unknown = JSON.parse(await readFile(join(groupsRoot(stateRoot), name), "utf8"));
			return typeof parsed === "object" && parsed !== null && "version" in parsed && (parsed as { version: unknown }).version === 1 ? parsed as SyncGroup : undefined;
		} catch { return undefined; }
	}));
	return groups.filter((group): group is SyncGroup => group !== undefined);
}

async function saveGroup(group: SyncGroup, stateRoot = defaultStateRoot()): Promise<void> {
	const directory = groupsRoot(stateRoot);
	await mkdir(directory, { recursive: true });
	await writeTextFile(join(directory, `${group.id}.json`), `${JSON.stringify(group, null, 2)}\n`, true);
}

function newGroup(source: ChatInfo): SyncGroup {
	const id = createHash("sha256").update(`${resolve(source.cwd)}\0${source.harness}\0${source.sessionId}`).digest("hex").slice(0, 16);
	const now = new Date().toISOString();
	return { version: 1, id, cwd: resolve(source.cwd), createdAt: now, updatedAt: now, members: {} };
}

function findGroup(groups: SyncGroup[], source: ChatInfo): SyncGroup | undefined {
	const sourcePath = resolve(source.path);
	return groups.find((group) => Object.values(group.members).some((member) => member !== undefined && (resolve(member.path) === sourcePath || (member.harness === source.harness && member.sessionId === source.sessionId))));
}

function asChat(member: SyncMember, cwd: string): ChatInfo {
	return { ...member, cwd, modifiedAt: 0 };
}

async function stableTranscript(chat: Pick<ChatInfo, "harness" | "path">): Promise<Transcript> {
	const before = await stat(chat.path);
	await delay(250);
	const after = await stat(chat.path);
	if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error(`Session is still being written: ${chat.path}`);
	return readChat(chat);
}

async function refreshTargets(group: SyncGroup, source: ChatInfo, transcript: Transcript, targets: HarnessId[], protectAlive: boolean): Promise<{ written: SyncMember[]; skippedAlive: SyncMember[] }> {
	const written: SyncMember[] = [];
	const skippedAlive: SyncMember[] = [];
	const existingChats = Object.values(group.members).filter((member): member is SyncMember => member !== undefined).map((member) => asChat(member, group.cwd));
	const alive = protectAlive ? await markAlive(existingChats) : existingChats;
	for (const target of targets) {
		if (target === source.harness) continue;
		const existing = group.members[target];
		if (existing !== undefined && (alive.some((chat) => chat.harness === target && chat.alive === true) || await harnessRunningInCwd(target, group.cwd))) {
			skippedAlive.push(existing);
			continue;
		}
		const result = await writeChat(target, transcript, existing === undefined
			? { name: transcript.title }
			: { path: existing.path, sessionId: existing.sessionId, overwrite: true, name: transcript.title });
		const member: SyncMember = { harness: target, path: result.path, sessionId: result.sessionId, fingerprint: await fingerprint(result) };
		group.members[target] = member;
		written.push(member);
	}
	return { written, skippedAlive };
}

export async function syncChat(source: ChatInfo, options: { stateRoot?: string; protectAlive?: boolean } = {}): Promise<SyncResult> {
	const stateRoot = options.stateRoot ?? defaultStateRoot();
	const transcript = await stableTranscript(source);
	const groups = await loadGroups(stateRoot);
	const group = findGroup(groups, source) ?? newGroup(source);
	const installed = await installedHarnesses();
	const sourceMember: SyncMember = { harness: source.harness, path: source.path, sessionId: source.sessionId, fingerprint: transcriptFingerprint(transcript) };
	group.members[source.harness] = sourceMember;
	let refreshed: { written: SyncMember[]; skippedAlive: SyncMember[] };
	try {
		refreshed = await refreshTargets(group, source, transcript, installed, options.protectAlive ?? true);
	} catch (error) {
		group.updatedAt = new Date().toISOString();
		await saveGroup(group, stateRoot);
		throw error;
	}
	group.updatedAt = new Date().toISOString();
	await saveGroup(group, stateRoot);
	return {
		group,
		source,
		...refreshed,
		unavailable: HARNESSES.filter((harness) => !installed.includes(harness)),
	};
}

export async function resolveSyncSource(cwd: string): Promise<ChatInfo | undefined> {
	return resolveCurrentChat(cwd, await findRepoChats(cwd));
}

export interface WatchdogEvent {
	type: "idle" | "synced" | "waiting";
	group: SyncGroup;
	source?: SyncMember;
	targets?: SyncMember[];
}

export async function watchdogIteration(group: SyncGroup, stateRoot = defaultStateRoot()): Promise<WatchdogEvent> {
	const changed: { member: SyncMember; transcript: Transcript; fingerprint: string }[] = [];
	for (const member of Object.values(group.members)) {
		if (member === undefined) continue;
		const transcript = await stableTranscript(asChat(member, group.cwd));
		const current = transcriptFingerprint(transcript);
		if (current !== member.fingerprint) changed.push({ member, transcript, fingerprint: current });
	}
	if (changed.length === 0) return { type: "idle", group };
	if (changed.length > 1) {
		const labels = changed.map((item) => HARNESS_LABELS[item.member.harness]).join(", ");
		throw new Error(`Sync conflict: ${labels} changed since the last sync. No files were overwritten.`);
	}
	const update = changed[0];
	if (update === undefined) return { type: "idle", group };
	const sourceChat = asChat(update.member, group.cwd);
	const targets = Object.values(group.members).filter((member): member is SyncMember => member !== undefined && member.harness !== update.member.harness);
	const aliveTargets = (await markAlive(targets.map((member) => asChat(member, group.cwd)))).filter((chat) => chat.alive === true);
	for (const target of targets) {
		if (!aliveTargets.some((chat) => chat.harness === target.harness) && await harnessRunningInCwd(target.harness, group.cwd)) aliveTargets.push(asChat(target, group.cwd));
	}
	if (aliveTargets.length > 0) {
		const waiting = aliveTargets.flatMap((chat) => {
			const member = group.members[chat.harness];
			return member === undefined ? [] : [member];
		});
		return { type: "waiting", group, source: update.member, targets: waiting };
	}
	update.member.fingerprint = update.fingerprint;
	group.members[update.member.harness] = update.member;
	let refreshed: { written: SyncMember[]; skippedAlive: SyncMember[] };
	try {
		refreshed = await refreshTargets(group, sourceChat, update.transcript, targets.map((target) => target.harness), false);
	} catch (error) {
		group.updatedAt = new Date().toISOString();
		await saveGroup(group, stateRoot);
		throw error;
	}
	group.updatedAt = new Date().toISOString();
	await saveGroup(group, stateRoot);
	return { type: "synced", group, source: update.member, targets: refreshed.written };
}

export async function runWatchdog(source: ChatInfo, options: { stateRoot?: string; intervalMs?: number; signal?: AbortSignal; onEvent?: (event: WatchdogEvent) => void } = {}): Promise<void> {
	const stateRoot = options.stateRoot ?? defaultStateRoot();
	const initial = await syncChat(source, { stateRoot, protectAlive: true });
	let group = initial.group;
	const interval = options.intervalMs ?? 1500;
	while (options.signal?.aborted !== true) {
		await delay(interval, undefined, options.signal === undefined ? {} : { signal: options.signal });
		const event = await watchdogIteration(group, stateRoot);
		group = event.group;
		options.onEvent?.(event);
	}
}
