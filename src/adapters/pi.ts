import { homedir } from "node:os";
import { join } from "node:path";
import { defaultPiSessionsRoot, findPiSessions, readPiSessionFile } from "../readers/pi.js";
import { shellQuote } from "../shell.js";
import { writeToPi } from "../writers/pi.js";
import type { HarnessAdapter } from "./types.js";

export const piAdapter: HarnessAdapter = {
	id: "pi",
	label: "pi",
	command: "pi",
	storeRoots: () => [defaultPiSessionsRoot()],
	findRepoChats: findPiSessions,
	read: readPiSessionFile,
	async write(transcript, options) {
		return writeToPi(transcript, {
			path: options.path,
			sessionId: options.sessionId,
			overwrite: options.overwrite,
			name: options.name,
		});
	},
	resumeCommand: (sessionId, cwd) => `cd ${shellQuote(cwd)} && pi --session ${shellQuote(sessionId.slice(0, 8))}`,
	currentChat() {
		const path = process.env.PI_SESSION_FILE;
		if (path === undefined || path === "" || path.includes(`${join(homedir(), ".omp")}/`)) return undefined;
		const sessionId = process.env.PI_SESSION_ID;
		return { path, ...(sessionId === undefined || sessionId === "" ? {} : { sessionId }) };
	},
	processMatches: (command) => /(^|[/ ])pi( |$)/.test(command),
	sessionProcessMatches(command, sessionId) {
		return this.processMatches(command) && (command.includes(`--session ${sessionId}`) || command.includes(`--session ${sessionId.slice(0, 8)}`));
	},
	headless(prompt, options) {
		const base = options.sessionId === undefined
			? ["-p", prompt, "--no-session", "--thinking", "off"]
			: ["-p", prompt, "--session", options.sessionId];
		return { command: "pi", args: base };
	},
};
