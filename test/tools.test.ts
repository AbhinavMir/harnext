import { describe, expect, it } from "vitest";
import { mapTool } from "../src/tools.js";

describe("mapTool", () => {
	it("renames Read arguments to pi's names", () => {
		expect(mapTool("Read", { file_path: "/tmp/x", offset: 10, limit: 20 })).toEqual({
			name: "read",
			arguments: { path: "/tmp/x", offset: 10, limit: 20 },
			lost: [],
		});
	});

	it("leaves optional arguments out when Claude did not send them", () => {
		expect(mapTool("Read", { file_path: "/tmp/x" })?.arguments).toEqual({ path: "/tmp/x" });
	});

	it("turns one Edit into pi's edits array", () => {
		expect(mapTool("Edit", { file_path: "/tmp/x", old_string: "a", new_string: "b" })).toEqual({
			name: "edit",
			arguments: { path: "/tmp/x", edits: [{ oldText: "a", newText: "b" }] },
			lost: [],
		});
	});

	it("reports replace_all as lost, because pi's edit has no such flag", () => {
		expect(mapTool("Edit", { file_path: "/tmp/x", old_string: "a", new_string: "b", replace_all: true })?.lost).toEqual([
			"Edit.replace_all",
		]);
	});

	it("turns MultiEdit into a single pi edit call", () => {
		expect(
			mapTool("MultiEdit", {
				file_path: "/tmp/x",
				edits: [
					{ old_string: "a", new_string: "b" },
					{ old_string: "c", new_string: "d" },
				],
			})?.arguments,
		).toEqual({
			path: "/tmp/x",
			edits: [
				{ oldText: "a", newText: "b" },
				{ oldText: "c", newText: "d" },
			],
		});
	});

	it("converts the Bash timeout from milliseconds to seconds", () => {
		expect(mapTool("Bash", { command: "ls", timeout: 120000 })?.arguments).toEqual({ command: "ls", timeout: 120 });
	});

	it("maps Glob onto pi's find", () => {
		expect(mapTool("Glob", { pattern: "**/*.ts", path: "src" })).toEqual({
			name: "find",
			arguments: { pattern: "**/*.ts", path: "src" },
			lost: [],
		});
	});

	it("maps Grep flags onto pi's grep options", () => {
		expect(mapTool("Grep", { pattern: "todo", "-i": true, "-C": 3, head_limit: 20, glob: "*.ts" })?.arguments).toEqual({
			pattern: "todo",
			glob: "*.ts",
			ignoreCase: true,
			context: 3,
			limit: 20,
		});
	});

	it("reports a Grep output mode pi cannot express", () => {
		expect(mapTool("Grep", { pattern: "todo", output_mode: "files_with_matches" })?.lost).toEqual([
			"Grep.output_mode=files_with_matches",
		]);
	});

	it("returns undefined for a tool pi does not have", () => {
		expect(mapTool("TodoWrite", { todos: [] })).toBeUndefined();
		expect(mapTool("mcp__github__create_issue", {})).toBeUndefined();
	});
});
