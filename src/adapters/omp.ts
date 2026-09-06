import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { defaultOmpSessionsRoot, findOmpSessions, readOmpSessionFile } from "../readers/omp.js";
import { shellQuote } from "../shell.js";
import { writeToOmp } from "../writers/omp.js";
import type { HarnessAdapter } from "./types.js";

const exec = promisify(execFile);

export const ompAdapter: HarnessAdapter = {
	id: "omp",
	label: "Oh My Pi",
	command: "omp",
	storeRoots: () => [defaultOmpSessionsRoot()],
	findRepoChats: findOmpSessions,
	read: readOmpSessionFile,
	async write(transcript, options) {
		return writeToOmp(transcript, {
			path: options.path,
			sessionId: options.sessionId,
			overwrite: options.overwrite,
			name: options.name,
		});
	},
	resumeCommand: (sessionId, cwd) => `cd ${shellQuote(cwd)} && omp --resume ${shellQuote(sessionId.slice(0, 8))}`,
	currentChat() {
		const explicitPath = process.env.OMP_SESSION_FILE;
		const piPath = process.env.PI_SESSION_FILE;
		const path = explicitPath !== undefined && explicitPath !== "" ? explicitPath
			: piPath !== undefined && piPath.includes(`${join(homedir(), ".omp")}/`) ? piPath
			: undefined;
		if (path === undefined) return undefined;
		const sessionId = process.env.OMP_SESSION_ID ?? process.env.PI_SESSION_ID;
		return { path, ...(sessionId === undefined || sessionId === "" ? {} : { sessionId }) };
	},
	processMatches: (command) => /(^|[/ ])omp( |$)/.test(command),
	sessionProcessMatches(command, sessionId) {
		const short = sessionId.slice(0, 8);
		return this.processMatches(command) && [
			`--resume=${sessionId}`,
			`--resume=${short}`,
			`--resume ${sessionId}`,
			`--resume ${short}`,
		].some((argument) => command.includes(argument));
	},
	async activeChats() {
		const paths: string[] = [];
		const directory = join(homedir(), ".omp", "agent", "terminal-sessions");
		let names: string[];
		try { names = await readdir(directory); } catch { return { paths }; }
		for (const name of names) {
			let lines: string[];
			try { lines = (await readFile(join(directory, name), "utf8")).split("\n"); } catch { continue; }
			const path = lines[1]?.trim();
			if (path === undefined || path === "") continue;
			try {
				const output = await exec("ps", ["-t", name, "-o", "command="]);
				if (output.stdout.split("\n").some((command) => this.processMatches(command))) paths.push(resolve(path));
			} catch { continue; }
		}
		return { paths };
	},
	headless(prompt, options) {
		const base = options.sessionId === undefined
			? ["-p", prompt, "--no-session"]
			: ["-p", prompt, "--resume", options.sessionId];
		return { command: "omp", args: base };
	},
};
