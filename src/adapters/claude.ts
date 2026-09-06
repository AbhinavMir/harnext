import { claudeProjectsRoot, findClaudeSessions, readClaudeSessionFile } from "../readers/claude-code.js";
import { shellQuote } from "../shell.js";
import { writeToClaudeCode } from "../writers/claude-code.js";
import type { HarnessAdapter } from "./types.js";

export const claudeAdapter: HarnessAdapter = {
	id: "claude",
	label: "Claude Code",
	command: "claude",
	storeRoots: () => [claudeProjectsRoot()],
	findRepoChats: findClaudeSessions,
	read: readClaudeSessionFile,
	async write(transcript, options) {
		return writeToClaudeCode(transcript, {
			path: options.path,
			sessionId: options.sessionId,
			overwrite: options.overwrite,
			title: options.name,
		});
	},
	resumeCommand: (sessionId, cwd) => `cd ${shellQuote(cwd)} && claude --resume ${shellQuote(sessionId)}`,
	currentChat() {
		const sessionId = process.env.CLAUDE_SESSION_ID;
		return sessionId === undefined || sessionId === "" ? undefined : { sessionId };
	},
	processMatches: (command) => /(^|[/ ])claude( |$)/.test(command) && !command.includes(" daemon ") && !command.includes("bg-pty"),
	sessionProcessMatches(command, sessionId) {
		return this.processMatches(command) && (command.includes(`--session-id ${sessionId}`) || command.includes(`--resume ${sessionId}`));
	},
	headless(prompt, options) {
		const base = options.sessionId === undefined
			? ["-p", prompt, "--output-format", "text"]
			: ["--resume", options.sessionId, "-p", prompt, "--output-format", "text"];
		return { command: "claude", args: options.yolo === true ? [...base, "--dangerously-skip-permissions"] : base };
	},
};
