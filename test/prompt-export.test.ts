import { describe, expect, it } from "vitest";
import type { Transcript } from "../src/ir.js";
import { buildPromptExport, renderPromptExport, splitPromptExportForHtml } from "../src/prompt-export.js";

const transcript: Transcript = {
	source: "pi",
	sessionId: "session-1",
	cwd: "/tmp/project",
	createdAt: 1_700_000_000_000,
	messages: [
		{ role: "user", ts: 1, blocks: [{ kind: "text", text: "first exact prompt" }, { kind: "image", data: "abc", mimeType: "image/png" }] },
		{ role: "assistant", ts: 2, blocks: [{ kind: "text", text: "assistant response" }] },
		{ role: "user", ts: 3, blocks: [{ kind: "text", text: "second prompt with `code`" }] },
	],
	notes: [],
};

describe("buildPromptExport", () => {
	it("exports exact user prompts and ignores assistants and images", async () => {
		const result = await buildPromptExport(transcript, { mode: "raw", redact: false });

		expect(result.prompts.map((prompt) => prompt.text)).toEqual(["first exact prompt", "second prompt with `code`"]);
		expect(JSON.stringify(result)).not.toContain("assistant response");
		expect(JSON.stringify(result)).not.toContain("abc");
	});

	it("does not trim or normalize raw prompt whitespace", async () => {
		const result = await buildPromptExport({
			...transcript,
			messages: [{ role: "user", ts: 1, blocks: [{ kind: "text", text: "  exact\n\ntext  " }] }],
		}, { mode: "raw", redact: false });
		expect(result.prompts[0]?.text).toBe("  exact\n\ntext  ");
	});

	it("smart mode replaces rather than retaining original prompts", async () => {
		const fetcher = async () => ({
			ok: true,
			status: 200,
			statusText: "OK",
			json: async () => ({ choices: [{ message: { content: '{"prompts":["clean replacement","second replacement"]}' } }] }),
		}) as Response;
		const result = await buildPromptExport(transcript, {
			mode: "smart",
			redact: false,
			smart: { apiKey: "key", model: "provider/model", fetcher: fetcher as typeof fetch },
		});
		expect(result.prompts.map((prompt) => prompt.text)).toEqual(["clean replacement", "second replacement"]);
		expect(JSON.stringify(result)).not.toContain("first exact prompt");
	});

	it("redacts locally when enabled", async () => {
		const offensive = `what the ${"f" + "uck"}`;
		const result = await buildPromptExport({
			...transcript,
			messages: [{ role: "user", ts: 1, blocks: [{ kind: "text", text: offensive }] }],
		}, { redact: true });

		expect(result.prompts[0]?.text).toContain("[redacted]");
		expect(result.prompts[0]?.text).not.toBe(offensive);
		expect(result.redactionMatches).toBe(1);
	});
});

describe("renderPromptExport", () => {
	it("renders plain text", async () => {
		const record = await buildPromptExport(transcript, { redact: false });
		expect(renderPromptExport(record, "text")).toContain("--- Prompt 1");
	});

	it("renders Markdown with fences longer than prompt backticks", async () => {
		const record = await buildPromptExport(transcript, { redact: false });
		const markdown = renderPromptExport(record, "markdown");
		expect(markdown).toContain("```text");
		expect(markdown).toContain("second prompt with `code`");
	});

	it("escapes prompt HTML", async () => {
		const record = await buildPromptExport({
			...transcript,
			messages: [{ role: "user", ts: 1, blocks: [{ kind: "text", text: "<script>bad()</script>" }] }],
		}, { redact: false });
		const html = renderPromptExport(record, "html");
		expect(html).toContain("&lt;script&gt;bad()&lt;/script&gt;");
		expect(html).not.toContain("<script>bad()</script>");
	});

	it("splits large HTML exports without changing prompt order", async () => {
		const record = await buildPromptExport({
			...transcript,
			messages: [
				{ role: "user", ts: 1, blocks: [{ kind: "text", text: "a".repeat(700) }] },
				{ role: "user", ts: 2, blocks: [{ kind: "text", text: "b".repeat(700) }] },
			],
		}, { redact: false });
		const pages = splitPromptExportForHtml(record, 1_900);
		expect(pages).toHaveLength(2);
		expect(pages.flatMap((page) => page.prompts.map((prompt) => prompt.index))).toEqual([1, 2]);
	});
});
