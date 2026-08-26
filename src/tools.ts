/**
 * Tool translation from Claude Code to pi.
 *
 * A tool call that survives translation must name a tool pi actually has and
 * carry arguments pi's schema accepts. A call that names a tool the target
 * harness never registers is worse than no call at all: the provider rejects
 * the whole history on the first resumed turn. Anything without a counterpart
 * is therefore reported as unmapped, and the writer degrades it to text.
 */

export interface MappedTool {
	name: string;
	arguments: Record<string, unknown>;
	/** Argument-level information that pi has no field for. */
	lost: string[];
}

type Mapper = (input: Record<string, unknown>) => MappedTool;

function str(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function num(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function defined<T extends Record<string, unknown>>(entries: T): Record<string, unknown> {
	return Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined));
}

const read: Mapper = (input) => ({
	name: "read",
	arguments: defined({
		path: str(input.file_path) ?? str(input.path) ?? "",
		offset: num(input.offset),
		limit: num(input.limit),
	}),
	lost: str(input.pages) === undefined ? [] : ["Read.pages"],
});

const write: Mapper = (input) => ({
	name: "write",
	arguments: {
		path: str(input.file_path) ?? str(input.path) ?? "",
		content: str(input.content) ?? "",
	},
	lost: [],
});

const edit: Mapper = (input) => {
	const lost: string[] = [];
	if (input.replace_all === true) lost.push("Edit.replace_all");
	return {
		name: "edit",
		arguments: {
			path: str(input.file_path) ?? str(input.path) ?? "",
			edits: [{ oldText: str(input.old_string) ?? "", newText: str(input.new_string) ?? "" }],
		},
		lost,
	};
};

const multiEdit: Mapper = (input) => {
	const raw = Array.isArray(input.edits) ? input.edits : [];
	const edits = raw
		.filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
		.map((entry) => ({ oldText: str(entry.old_string) ?? "", newText: str(entry.new_string) ?? "" }));
	return {
		name: "edit",
		arguments: { path: str(input.file_path) ?? "", edits },
		lost: [],
	};
};

const bash: Mapper = (input) => {
	const timeoutMs = num(input.timeout);
	const lost: string[] = [];
	if (input.run_in_background === true) lost.push("Bash.run_in_background");
	return {
		name: "bash",
		arguments: defined({
			command: str(input.command) ?? "",
			// Claude counts the timeout in milliseconds, pi in seconds.
			timeout: timeoutMs === undefined ? undefined : Math.max(1, Math.round(timeoutMs / 1000)),
		}),
		lost,
	};
};

const glob: Mapper = (input) => ({
	name: "find",
	arguments: defined({ pattern: str(input.pattern) ?? "", path: str(input.path) }),
	lost: [],
});

const grep: Mapper = (input) => {
	const lost: string[] = [];
	const mode = str(input.output_mode);
	if (mode !== undefined && mode !== "content") lost.push(`Grep.output_mode=${mode}`);
	if (str(input.type) !== undefined) lost.push("Grep.type");
	const context = num(input["-C"]) ?? num(input["-A"]) ?? num(input["-B"]);
	return {
		name: "grep",
		arguments: defined({
			pattern: str(input.pattern) ?? "",
			path: str(input.path),
			glob: str(input.glob),
			ignoreCase: input["-i"] === true ? true : undefined,
			context,
			limit: num(input.head_limit),
		}),
		lost,
	};
};

const list: Mapper = (input) => ({
	name: "ls",
	arguments: defined({ path: str(input.path) ?? str(input.file_path) }),
	lost: [],
});

const MAPPERS: Record<string, Mapper> = {
	Read: read,
	Write: write,
	Edit: edit,
	MultiEdit: multiEdit,
	Bash: bash,
	Glob: glob,
	Grep: grep,
	LS: list,
};

/** Translate a Claude Code tool call, or return undefined when pi has no equivalent. */
export function mapTool(name: string, input: Record<string, unknown>): MappedTool | undefined {
	const mapper = MAPPERS[name];
	return mapper === undefined ? undefined : mapper(input);
}

export function mappedToolNames(): string[] {
	return Object.keys(MAPPERS);
}
