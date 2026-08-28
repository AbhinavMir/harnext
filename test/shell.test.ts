import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { resumeCommandFor } from "../src/harnesses.js";
import { shellQuote } from "../src/shell.js";

describe("printed shell commands", () => {
	it("quotes spaces, metacharacters, apostrophes, and empty arguments", () => {
		for (const value of ["/tmp/project with spaces", "/tmp/a;echo unsafe", "/tmp/it's here", ""]) {
			const output = execFileSync("sh", ["-c", `printf %s ${shellQuote(value)}`], { encoding: "utf8" });
			expect(output).toBe(value);
		}
	});

	it("quotes the cwd in every harness resume command", () => {
		const cwd = "/tmp/project with 'quotes' & spaces";
		for (const harness of ["claude", "pi", "omp", "codex"] as const) {
			const command = resumeCommandFor(harness, "01234567-89ab-cdef-0123-456789abcdef", cwd);
			expect(command).toContain(`cd ${shellQuote(cwd)} &&`);
		}
	});
});
