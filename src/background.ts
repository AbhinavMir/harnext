/** Detached command launcher for headless and remote harnext sessions. */

import { spawn } from "node:child_process";
import { mkdir, open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface BackgroundLaunch {
	pid: number;
	command: string;
	logPath: string;
}

export async function launchCommandInBackground(command: string, label: string, stateRoot = process.env.HARNEXT_STATE_DIR ?? join(homedir(), ".harnext")): Promise<BackgroundLaunch> {
	const directory = join(stateRoot, "logs");
	await mkdir(directory, { recursive: true });
	const safeLabel = label.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "process";
	const logPath = join(directory, `${safeLabel}.log`);
	const log = await open(logPath, "a");
	try {
		const child = spawn("sh", ["-lc", `exec ${command}`], {
			detached: true,
			stdio: ["ignore", log.fd, log.fd],
		});
		await new Promise<void>((resolve, reject) => {
			child.once("error", reject);
			child.once("spawn", resolve);
		});
		if (child.pid === undefined) throw new Error("Background process started without a process ID");
		child.unref();
		return { pid: child.pid, command, logPath };
	} finally {
		await log.close();
	}
}
