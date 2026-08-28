/** Writer for resumable Oh My Pi v3 JSONL sessions. */

import { randomBytes, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { writeTextFile } from "../atomic.js";
import type { Transcript } from "../ir.js";
import { defaultOmpSessionsRoot, ompSessionDirName } from "../readers/omp.js";
import { toPiEntries, type PiWriteOptions, type WriteStats } from "./pi.js";

export interface OmpWriteOptions extends Omit<PiWriteOptions, "piPackage"> {
	sessionId?: string;
	path?: string;
	overwrite?: boolean;
}

export interface OmpWriteResult {
	path: string;
	sessionId: string;
	stats: WriteStats;
}

function id(): string {
	return randomBytes(8).toString("hex");
}

function iso(ts: number): string {
	return new Date(Number.isFinite(ts) ? ts : Date.now()).toISOString();
}

export function toOmpRecords(transcript: Transcript, options: OmpWriteOptions = {}): { records: Record<string, unknown>[]; sessionId: string; stats: WriteStats } {
	const sessionId = options.sessionId ?? randomUUID();
	const { entries, stats } = toPiEntries(transcript, options);
	const title = options.name ?? transcript.title;
	const records: Record<string, unknown>[] = [];
	if (title !== undefined && title !== "") records.push({ type: "title", v: 1, title, source: "harnext", updatedAt: iso(Date.now()) });
	records.push({
		type: "session",
		version: 3,
		id: sessionId,
		timestamp: iso(transcript.createdAt),
		cwd: transcript.cwd,
		...(title === undefined || title === "" ? {} : { title, titleSource: "harnext" }),
	});
	let parentId: string | null = null;
	if (transcript.model?.id !== undefined) {
		const recordId = id();
		records.push({
			type: "model_change",
			id: recordId,
			parentId,
			timestamp: iso(transcript.createdAt),
			model: transcript.model.id,
			...(transcript.model.provider === undefined ? {} : { provider: transcript.model.provider }),
		});
		parentId = recordId;
	}
	for (const entry of entries) {
		const recordId = id();
		if (entry.kind === "message") {
			records.push({ type: "message", id: recordId, parentId, timestamp: iso(entry.message.timestamp), message: entry.message });
		} else {
			records.push({ type: "custom", id: recordId, parentId, timestamp: iso(Date.now()), customType: entry.customType, data: entry.data });
		}
		parentId = recordId;
	}
	return { records, sessionId, stats };
}

export async function writeToOmp(transcript: Transcript, options: OmpWriteOptions = {}): Promise<OmpWriteResult> {
	const built = toOmpRecords(transcript, options);
	const timestamp = new Date(transcript.createdAt).toISOString().replace(/[:.]/g, "-");
	const path = options.path ?? join(options.sessionsRoot ?? defaultOmpSessionsRoot(), ompSessionDirName(transcript.cwd), `${timestamp}_${built.sessionId}.jsonl`);
	await mkdir(dirname(path), { recursive: true });
	await writeTextFile(path, `${built.records.map((record) => JSON.stringify(record)).join("\n")}\n`, options.overwrite === true);
	return { path, sessionId: built.sessionId, stats: built.stats };
}
