import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { writeTextFile } from "./atomic.js";
import { HARNESS_LABELS, type HarnessId } from "./harnesses.js";
import type { Transcript } from "./ir.js";

export type TellAgentMode = "ask" | "always" | "never";

export interface HarnextConfig {
	version: 1;
	tellAgent: TellAgentMode;
}

const DEFAULT_CONFIG: HarnextConfig = { version: 1, tellAgent: "ask" };
const NOTICE_MARKER = "[harnext switch notice]";

export function defaultConfigPath(): string {
	return process.env.HARNEXT_CONFIG ?? join(process.env.HARNEXT_STATE_DIR ?? join(homedir(), ".harnext"), "config.json");
}

export async function readConfig(path = defaultConfigPath()): Promise<HarnextConfig> {
	try {
		const value: unknown = JSON.parse(await readFile(path, "utf8"));
		if (typeof value === "object" && value !== null && "tellAgent" in value) {
			const tellAgent = (value as { tellAgent?: unknown }).tellAgent;
			if (tellAgent === "ask" || tellAgent === "always" || tellAgent === "never") return { version: 1, tellAgent };
		}
		throw new Error(`Invalid harnext config: ${path}`);
	} catch (error) {
		if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_CONFIG;
		throw error;
	}
}

export async function writeConfig(config: HarnextConfig, path = defaultConfigPath()): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeTextFile(path, `${JSON.stringify(config, null, 2)}\n`, true);
}

function color(code: number, text: string): string {
	return process.stdout.isTTY ? `\u001b[${code}m${text}\u001b[0m` : text;
}

async function oneKey(valid: readonly string[]): Promise<string> {
	if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") throw new Error("The switch notice prompt needs an interactive terminal");
	return new Promise<string>((resolve, reject) => {
		const previous = process.stdin.isRaw;
		const cleanup = (): void => {
			process.stdin.off("data", onData);
			process.stdin.setRawMode(previous);
			process.stdin.pause();
		};
		const onData = (chunk: Buffer): void => {
			const key = chunk.toString("utf8").toLowerCase();
			if (key === "\u0003") { cleanup(); reject(new Error("Aborted with Ctrl+C")); return; }
			if (key === "\u001b") { cleanup(); resolve("n"); return; }
			if (!valid.includes(key)) return;
			cleanup();
			process.stdout.write(`${key.toUpperCase()}\n`);
			resolve(key);
		};
		process.stdin.setRawMode(true);
		process.stdin.resume();
		process.stdin.on("data", onData);
	});
}

export async function promptTellAgent(): Promise<"yes" | "always" | "no"> {
	process.stdout.write([
		color(36, "╭─ harnext · switch context ─────────────────────────────────────────╮"),
		"│ Tell the receiving agent about switching harnesses?                 │",
		"│ Recommended: lets it re-check MCPs, tools, skills, and runtime state.│",
		"│ Change this later with `harnext config`.                            │",
		`│ ${color(32, "[Y] Yes once")}    ${color(35, "[A] Always")}    ${color(90, "[N] No")}                              │`,
		color(36, "╰───────────────────────────────────────────────────────────────────╯"),
		"Choice: ",
	].join("\n"));
	const key = await oneKey(["y", "a", "n"]);
	return key === "y" ? "yes" : key === "a" ? "always" : "no";
}

export async function shouldTellAgent(options: { configPath?: string; interactive?: boolean } = {}): Promise<boolean> {
	const path = options.configPath ?? defaultConfigPath();
	const config = await readConfig(path);
	if (config.tellAgent === "always") return true;
	if (config.tellAgent === "never") return false;
	if (options.interactive === false || !process.stdin.isTTY) return false;
	const choice = await promptTellAgent();
	if (choice === "always") {
		await writeConfig({ version: 1, tellAgent: "always" }, path);
		return true;
	}
	return choice === "yes";
}

export async function configureTellAgent(mode?: TellAgentMode, path = defaultConfigPath()): Promise<HarnextConfig> {
	let selected = mode;
	if (selected === undefined) {
		if (!process.stdin.isTTY) return readConfig(path);
		process.stdout.write([
			color(36, "╭─ harnext config · switch notice ──────────────────────────────────╮"),
			`│ ${color(35, "[A] Always")}    ${color(32, "[Q] Ask each transfer")}    ${color(90, "[N] Never")}                 │`,
			color(36, "╰───────────────────────────────────────────────────────────────────╯"),
			"Choice: ",
		].join("\n"));
		const key = await oneKey(["a", "q", "n"]);
		selected = key === "a" ? "always" : key === "q" ? "ask" : "never";
	}
	const config: HarnextConfig = { version: 1, tellAgent: selected };
	await writeConfig(config, path);
	return config;
}

export function withSwitchNotice(transcript: Transcript, source: HarnessId): Transcript {
	const alreadyPresent = transcript.messages.some((message) => message.role === "user" && message.blocks.some((block) => block.kind === "text" && block.text.includes(NOTICE_MARKER)));
	if (alreadyPresent) return transcript;
	const latest = transcript.messages.reduce((maximum, message) => Math.max(maximum, message.ts), transcript.createdAt);
	const text = `${NOTICE_MARKER}\nThis chat was copied from ${HARNESS_LABELS[source]}. Before continuing, inspect this harness's available MCP servers, tools, skills, extensions, and runtime state because they may differ from the source harness. Preserve the existing task state and do not repeat completed work.`;
	return { ...transcript, messages: [...transcript.messages, { role: "user", ts: latest + 1, blocks: [{ kind: "text", text }] }] };
}
