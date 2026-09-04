import { describe, expect, it, vi } from "vitest";
import { openCommandInNewTerminal } from "../src/terminal.js";

describe("new terminal launcher", () => {
	it("opens Terminal on macOS with an AppleScript-safe command", async () => {
		const launch = vi.fn(async () => undefined);
		const result = await openCommandInNewTerminal('cd "/tmp/a\\b" && pi --session 1234', { platform: "darwin", launch });
		expect(result.terminal).toBe("Terminal");
		expect(launch).toHaveBeenCalledWith("osascript", expect.arrayContaining([
			"-e",
			'do script "cd \\"/tmp/a\\\\b\\" && pi --session 1234"',
		]));
	});

	it("uses the configured Linux terminal", async () => {
		const launch = vi.fn(async () => undefined);
		const commandExists = vi.fn(async (command: string) => command === "kitty");
		const result = await openCommandInNewTerminal("cd /tmp && codex resume abc", {
			platform: "linux",
			env: { TERMINAL: "kitty" },
			commandExists,
			launch,
		});
		expect(result.terminal).toBe("kitty");
		expect(launch).toHaveBeenCalledWith("kitty", ["sh", "-lc", "cd /tmp && codex resume abc"]);
	});

	it("reports when Linux has no usable terminal", async () => {
		await expect(openCommandInNewTerminal("pi", {
			platform: "linux",
			env: {},
			commandExists: async () => false,
			launch: async () => undefined,
		})).rejects.toThrow("No supported terminal launcher found");
	});
});
