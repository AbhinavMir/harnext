import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { defaultCodexRoot, findCodexSessions, readCodexSessionFile } from "../readers/codex.js";
import { shellQuote } from "../shell.js";
import { writeToCodex } from "../writers/codex.js";
import type { HarnessAdapter } from "./types.js";

export const codexAdapter: HarnessAdapter = {
	id: "codex",
	label: "Codex",
	command: "codex",
	storeRoots: () => [join(defaultCodexRoot(), "sessions"), join(defaultCodexRoot(), "archived_sessions")],
	findRepoChats: findCodexSessions,
	read: readCodexSessionFile,
	async write(transcript, options) {
		return writeToCodex(transcript, {
			path: options.path,
			sessionId: options.sessionId,
			overwrite: options.overwrite,
			title: options.name,
		});
	},
	resumeCommand: (sessionId, cwd) => `cd ${shellQuote(cwd)} && codex resume ${shellQuote(sessionId)}`,
	currentChat() {
		const sessionId = process.env.CODEX_THREAD_ID ?? process.env.CODEX_SESSION_ID;
		return sessionId === undefined || sessionId === "" ? undefined : { sessionId };
	},
	processMatches: (command) => /(^|[/ ])codex( |$)/.test(command) && !command.includes("app-server"),
	sessionProcessMatches(command, sessionId) {
		return this.processMatches(command) && (command.includes(`resume ${sessionId}`) || command.includes(`resume ${sessionId.slice(0, 8)}`));
	},
	async activeChats(processCommands) {
		const sessionIds: string[] = [];
		if (!processCommands.some((command) => /(^|[/ ])codex( |$)/.test(command) && command.includes("app-server"))) return { sessionIds };
		const directory = join(defaultCodexRoot(), "thread-writer-locks");
		let names: string[];
		try { names = await readdir(directory); } catch { return { sessionIds }; }
		for (const name of names) if (name.endsWith(".lock") && name !== ".coordination.lock") sessionIds.push(name.slice(0, -5));
		return { sessionIds };
	},
};
