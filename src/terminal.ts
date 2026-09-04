/** Launch a harness resume command in a separate terminal window. */

import { execFile, spawn } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface TerminalLaunch {
	terminal: string;
	command: string;
}

interface LaunchDependencies {
	platform?: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
	commandExists?: (command: string) => Promise<boolean>;
	launch?: (command: string, args: string[]) => Promise<void>;
}

function appleScriptString(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "").replace(/\n/g, "\\n");
}

async function defaultCommandExists(command: string): Promise<boolean> {
	try { await exec(process.platform === "win32" ? "where" : "which", [command]); return true; } catch { return false; }
}

async function defaultLaunch(command: string, args: string[]): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const child = spawn(command, args, { detached: true, stdio: "ignore" });
		child.once("error", reject);
		child.once("spawn", () => { child.unref(); resolve(); });
	});
}

function linuxArgs(terminal: string, command: string): string[] {
	switch (basename(terminal)) {
		case "gnome-terminal": return ["--", "sh", "-lc", command];
		case "wezterm": return ["start", "--", "sh", "-lc", command];
		case "kitty": return ["sh", "-lc", command];
		default: return ["-e", "sh", "-lc", command];
	}
}

export async function openCommandInNewTerminal(command: string, dependencies: LaunchDependencies = {}): Promise<TerminalLaunch> {
	const platform = dependencies.platform ?? process.platform;
	const env = dependencies.env ?? process.env;
	const commandExists = dependencies.commandExists ?? defaultCommandExists;
	const launch = dependencies.launch ?? defaultLaunch;

	if (platform === "darwin") {
		const terminal = "osascript";
		await launch(terminal, [
			"-e", "tell application \"Terminal\"",
			"-e", "activate",
			"-e", `do script \"${appleScriptString(command)}\"`,
			"-e", "end tell",
		]);
		return { terminal: "Terminal", command };
	}
	if (platform === "win32") {
		await launch("cmd.exe", ["/d", "/s", "/c", "start", "", "cmd.exe", "/k", command]);
		return { terminal: "cmd.exe", command };
	}

	const configured = env.TERMINAL?.trim();
	const candidates = [...(configured === undefined || configured === "" ? [] : [configured]), "x-terminal-emulator", "gnome-terminal", "konsole", "wezterm", "kitty", "alacritty"];
	for (const terminal of [...new Set(candidates)]) {
		if (await commandExists(terminal)) {
			await launch(terminal, linuxArgs(terminal, command));
			return { terminal, command };
		}
	}
	throw new Error("No supported terminal launcher found; set TERMINAL to a terminal executable");
}
