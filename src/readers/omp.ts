/** Reader and discovery for Oh My Pi sessions. */

import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Transcript } from "../ir.js";
import { parsePiSession, type PiSessionInfo } from "./pi.js";

export const SOURCE_NAME = "oh-my-pi";

export function defaultOmpSessionsRoot(): string {
	return join(process.env.OMP_CODING_AGENT_DIR ?? join(homedir(), ".omp", "agent"), "sessions");
}

/** OMP uses a shorter project slug than pi. */
export function ompSessionDirName(cwd: string): string {
	const home = homedir();
	const absolute = resolve(cwd);
	const relative = absolute === home ? "" : absolute.startsWith(`${home}/`) ? absolute.slice(home.length + 1) : absolute.replace(/^\//, "");
	return `-${relative.replace(/[^a-zA-Z0-9]/g, "-")}`;
}

function withSource(transcript: Transcript): Transcript {
	return { ...transcript, source: SOURCE_NAME };
}

export function parseOmpSession(text: string, sourcePath?: string): Transcript {
	const transcript = withSource(parsePiSession(text, sourcePath));
	for (const line of text.split("\n").slice(0, 3)) {
		try {
			const value: unknown = JSON.parse(line);
			if (typeof value === "object" && value !== null && "title" in value && typeof (value as { title?: unknown }).title === "string") {
				return { ...transcript, title: (value as { title: string }).title };
			}
		} catch { continue; }
	}
	return transcript;
}

async function info(path: string): Promise<PiSessionInfo | undefined> {
	try {
		const transcript = parseOmpSession(await readFile(path, "utf8"), path);
		const first = transcript.messages.find((message) => message.role === "user");
		const firstPrompt = first?.role === "user"
			? first.blocks.filter((block) => block.kind === "text").map((block) => block.kind === "text" ? block.text : "").join(" ").replace(/\s+/g, " ").slice(0, 120)
			: undefined;
		return {
			path,
			sessionId: transcript.sessionId,
			cwd: transcript.cwd,
			modifiedAt: (await stat(path)).mtimeMs,
			...(transcript.title === undefined ? {} : { title: transcript.title }),
			...(firstPrompt === undefined || firstPrompt === "" ? {} : { firstPrompt }),
		};
	} catch {
		return undefined;
	}
}

export async function readOmpSessionFile(path: string): Promise<Transcript> {
	return parseOmpSession(await readFile(path, "utf8"), path);
}

export async function findOmpSessions(cwd: string, sessionsRoot = defaultOmpSessionsRoot()): Promise<PiSessionInfo[]> {
	const directory = join(sessionsRoot, ompSessionDirName(cwd));
	let names: string[];
	try { names = await readdir(directory); } catch { return []; }
	const sessions = await Promise.all(names.filter((name) => name.endsWith(".jsonl")).map((name) => info(join(directory, name))));
	return sessions.filter((item): item is PiSessionInfo => item !== undefined).sort((a, b) => b.modifiedAt - a.modifiedAt);
}

export async function resolveOmpSession(cwd: string, session?: string, sessionsRoot = defaultOmpSessionsRoot()): Promise<PiSessionInfo> {
	if (session !== undefined && (session.includes("/") || session.endsWith(".jsonl"))) {
		const found = await info(resolve(session));
		if (found === undefined) throw new Error(`Not a readable Oh My Pi session file: ${session}`);
		return found;
	}
	const sessions = await findOmpSessions(cwd, sessionsRoot);
	if (session !== undefined) {
		const matches = sessions.filter((candidate) => candidate.sessionId.startsWith(session));
		if (matches.length === 0) throw new Error(`No Oh My Pi session in ${cwd} with id starting ${session}`);
		if (matches.length > 1) throw new Error(`Session id ${session} is ambiguous: ${matches.length} matches`);
		return matches[0] as PiSessionInfo;
	}
	if (sessions.length === 0) throw new Error(`No Oh My Pi sessions recorded for ${cwd}`);
	return sessions[0] as PiSessionInfo;
}
