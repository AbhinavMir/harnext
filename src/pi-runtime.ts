/**
 * Locate the pi the user actually runs.
 *
 * pi's session file is written by the coding agent's own `SessionManager`, and
 * the format is versioned. Writing it by hand, or with a different release of
 * the library than the installed CLI, produces a file pi refuses to open
 * ("Session file is not a valid pi session"). So harnext borrows the session
 * code out of the installed pi and lets pi decide what its own files look like.
 */

import { execFile } from "node:child_process";
import { access, readFile, realpath } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

const PI_PACKAGE = join("node_modules", "@earendil-works", "pi-coding-agent");

/** The pi session header, the first line of a session file. */
export interface PiSessionHeader {
	type: "session";
	id: string;
	timestamp: string;
	[key: string]: unknown;
}

/** The part of pi's session API that harnext uses. */
export interface PiSessionManager {
	appendMessage(message: unknown): string;
	appendCustomEntry(customType: string, data?: unknown): string;
	appendModelChange(provider: string, modelId: string): string;
	appendSessionInfo(name: string): string;
	getSessionId(): string;
	getHeader(): PiSessionHeader | null;
	getEntries(): unknown[];
}

export interface PiSessionApi {
	/**
	 * Build a session in memory. harnext writes the file itself: pi defers the
	 * first write until a session has an assistant message, which a digest
	 * import never has.
	 */
	createSession(cwd: string): PiSessionManager;
	defaultSessionDir(cwd: string): string;
	/** Directory the pi package was loaded from. */
	origin: string;
	version: string;
}

interface PiModule {
	SessionManager?: {
		inMemory(cwd?: string, options?: unknown): PiSessionManager;
	};
	getDefaultSessionDir?: (cwd: string, agentDir?: string) => string;
}

/** One pi package harnext looked at, and why it could not be used. */
export interface PiLoadFailure {
	root: string;
	reason: string;
}

export const MINIMUM_PI_NODE = "22.19.0";

function runningNodeIsTooOld(): boolean {
	const [major = 0, minor = 0] = process.versions.node.split(".").map((part) => Number.parseInt(part, 10));
	return major < 22 || (major === 22 && minor < 19);
}

export class PiNotFoundError extends Error {
	readonly failures: PiLoadFailure[];

	constructor(failures: PiLoadFailure[]) {
		const lines: string[] = [];
		if (failures.length === 0) {
			lines.push("No pi installation found.");
		} else {
			lines.push("Found pi, but could not load its session code:");
			for (const failure of failures) lines.push(`  ${failure.root}: ${failure.reason}`);
		}
		if (runningNodeIsTooOld()) {
			lines.push(
				`This is Node ${process.versions.node}. pi needs Node ${MINIMUM_PI_NODE} or later, ` +
					"so run harnext on that version too.",
			);
		} else {
			lines.push(
				"Install pi with `npm i -g @earendil-works/pi-coding-agent`, " +
					"or point harnext at one with --pi-package <dir> or HARNEXT_PI_PACKAGE.",
			);
		}
		super(lines.join("\n"));
		this.name = "PiNotFoundError";
		this.failures = failures;
	}
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function packageVersion(root: string): Promise<string> {
	try {
		const parsed: unknown = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
		if (typeof parsed === "object" && parsed !== null && "version" in parsed) {
			const value = (parsed as { version: unknown }).version;
			if (typeof value === "string") return value;
		}
	} catch {
		return "unknown";
	}
	return "unknown";
}

async function piExecutable(): Promise<string | undefined> {
	const locator = platform() === "win32" ? "where" : "which";
	try {
		const { stdout } = await run(locator, ["pi"]);
		const first = stdout.split("\n")[0]?.trim();
		if (first === undefined || first === "") return undefined;
		return await realpath(first);
	} catch {
		return undefined;
	}
}

async function walkUpForPackage(start: string): Promise<string | undefined> {
	let directory = start;
	for (let depth = 0; depth < 12; depth += 1) {
		const candidate = join(directory, PI_PACKAGE);
		if (await exists(join(candidate, "dist", "index.js"))) return candidate;
		const parent = dirname(directory);
		if (parent === directory) break;
		directory = parent;
	}
	return undefined;
}

async function candidateRoots(): Promise<string[]> {
	const roots: string[] = [];
	const executable = await piExecutable();
	if (executable !== undefined) {
		// A global install symlinks `pi` to <package>/dist/cli.js.
		roots.push(dirname(dirname(executable)));
		const nearby = await walkUpForPackage(dirname(executable));
		if (nearby !== undefined) roots.push(nearby);
	}
	for (const prefix of [join(homedir(), ".local", "lib"), "/usr/local/lib", "/opt/homebrew/lib"]) {
		roots.push(join(prefix, "node_modules", "@earendil-works", "pi-coding-agent"));
	}
	const own = await walkUpForPackage(dirname(new URL(import.meta.url).pathname));
	if (own !== undefined) roots.push(own);
	return roots;
}

async function loadFrom(root: string, failures: PiLoadFailure[]): Promise<PiSessionApi | undefined> {
	const entry = join(root, "dist", "index.js");
	if (!(await exists(entry))) return undefined;
	let module: PiModule;
	try {
		module = (await import(pathToFileURL(entry).href)) as PiModule;
	} catch (error) {
		// An unreadable pi is a different problem from a missing pi, and the
		// usual cause is a Node too old for pi's own code. Keep the reason.
		failures.push({ root, reason: error instanceof Error ? error.message : String(error) });
		return undefined;
	}
	const manager = module.SessionManager;
	if (manager === undefined || typeof manager.inMemory !== "function") {
		failures.push({ root, reason: "the package exports no usable SessionManager" });
		return undefined;
	}
	// `getDefaultSessionDir` is not part of every release's public surface, so
	// the fallback repeats pi's own rule for naming a session directory.
	const defaultDir = module.getDefaultSessionDir;
	return {
		createSession: (cwd) => manager.inMemory(cwd),
		defaultSessionDir: (cwd) =>
			typeof defaultDir === "function" ? defaultDir(cwd) : join(defaultAgentDir(), "sessions", piSessionDirName(cwd)),
		origin: root,
		version: await packageVersion(root),
	};
}

/**
 * Load pi's session code.
 *
 * `override` names a `@earendil-works/pi-coding-agent` package directory and
 * skips the search.
 */
export async function loadPiSessionApi(options: { override?: string } = {}): Promise<PiSessionApi> {
	const failures: PiLoadFailure[] = [];

	if (options.override !== undefined) {
		const loaded = await loadFrom(options.override, failures);
		if (loaded !== undefined) return loaded;
		throw new PiNotFoundError(failures);
	}

	const fromEnv = process.env.HARNEXT_PI_PACKAGE;
	if (fromEnv !== undefined && fromEnv !== "") {
		const loaded = await loadFrom(fromEnv, failures);
		if (loaded !== undefined) return loaded;
	}
	const seen = new Set<string>();
	for (const root of await candidateRoots()) {
		if (seen.has(root)) continue;
		seen.add(root);
		const loaded = await loadFrom(root, failures);
		if (loaded !== undefined) return loaded;
	}
	throw new PiNotFoundError(failures);
}

/** pi's own agent directory, honouring the environment variable pi reads. */
export function defaultAgentDir(): string {
	const fromEnv = process.env.PI_CODING_AGENT_DIR;
	if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
	return join(homedir(), ".pi", "agent");
}

/** pi's file name for a session, mirroring its own rule. */
export function piSessionFileName(header: PiSessionHeader): string {
	return `${header.timestamp.replace(/[:.]/g, "-")}_${header.id}.jsonl`;
}

/** pi's directory name for one working directory, mirroring its own rule. */
export function piSessionDirName(cwd: string): string {
	return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}
