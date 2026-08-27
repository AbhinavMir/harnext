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

/** Translate a pi tool call into a Claude Code built-in tool call. */
export function mapPiTool(name: string, input: Record<string, unknown>): MappedTool | undefined {
	switch (name) {
		case "read":
			return {
				name: "Read",
				arguments: defined({ file_path: str(input.path) ?? "", offset: num(input.offset), limit: num(input.limit) }),
				lost: [],
			};
		case "write":
			return {
				name: "Write",
				arguments: { file_path: str(input.path) ?? "", content: str(input.content) ?? "" },
				lost: [],
			};
		case "edit": {
			const edits = Array.isArray(input.edits) ? input.edits.map((value) =>
				typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined,
			).filter((value): value is Record<string, unknown> => value !== undefined) : [];
			if (edits.length !== 1) return undefined;
			const change = edits[0] as Record<string, unknown>;
			return {
				name: "Edit",
				arguments: {
					file_path: str(input.path) ?? "",
					old_string: str(change.oldText) ?? "",
					new_string: str(change.newText) ?? "",
				},
				lost: [],
			};
		}
		case "bash":
			return {
				name: "Bash",
				arguments: defined({
					command: str(input.command) ?? "",
					timeout: num(input.timeout) === undefined ? undefined : (num(input.timeout) as number) * 1000,
				}),
				lost: [],
			};
		case "find":
			return {
				name: "Glob",
				arguments: defined({ pattern: str(input.pattern) ?? "", path: str(input.path) }),
				lost: num(input.limit) === undefined ? [] : ["find.limit"],
			};
		case "grep":
			return {
				name: "Grep",
				arguments: defined({
					pattern: str(input.pattern) ?? "",
					path: str(input.path),
					glob: str(input.glob),
					"-i": input.ignoreCase === true ? true : undefined,
					"-C": num(input.context),
					head_limit: num(input.limit),
					output_mode: "content",
				}),
				lost: input.literal === true ? ["grep.literal"] : [],
			};
		case "ls":
			return {
				name: "Bash",
				arguments: { command: `ls -la ${JSON.stringify(str(input.path) ?? ".")}` },
				lost: num(input.limit) === undefined ? [] : ["ls.limit"],
			};
		default:
			return undefined;
	}
}
