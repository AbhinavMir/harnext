/** Prompt-only history exports. Assistant messages, tool traffic, and images are excluded. */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Transcript } from "./ir.js";
import { redactText } from "./redaction.js";
import { cleanPrompts, type SmartOptions } from "./smart.js";

export type ExportMode = "raw" | "smart";
export type ExportFormat = "html" | "markdown" | "text";

export interface PromptEntry {
	index: number;
	timestamp: number;
	text: string;
}

export interface PromptExport {
	source: string;
	sourceSessionId: string;
	cwd: string;
	createdAt: number;
	mode: ExportMode;
	redacted: boolean;
	redactionMatches: number;
	prompts: PromptEntry[];
}

export interface BuildPromptExportOptions {
	mode?: ExportMode;
	redact?: boolean;
	smart?: SmartOptions;
}

function promptText(message: Extract<Transcript["messages"][number], { role: "user" }>): string {
	return message.blocks
		.filter((block) => block.kind === "text")
		.map((block) => block.kind === "text" ? block.text : "")
		.join("\n");
}

export async function buildPromptExport(transcript: Transcript, options: BuildPromptExportOptions = {}): Promise<PromptExport> {
	const mode = options.mode ?? "raw";
	const redact = options.redact ?? true;
	const source = transcript.messages
		.filter((message): message is Extract<typeof message, { role: "user" }> => message.role === "user")
		.map((message) => ({ timestamp: message.ts, text: promptText(message) }))
		.filter((entry) => entry.text !== "");
	let redactionMatches = 0;
	const locallySafe = source.map((entry) => {
		const result = redact ? redactText(entry.text) : { text: entry.text, matches: 0 };
		redactionMatches += result.matches;
		return result.text;
	});
	// Redact before a smart request so matched text is neither exported nor sent
	// to OpenRouter. Redact the response again in case the model introduces it.
	const texts = mode === "smart" ? await cleanPrompts(locallySafe, options.smart) : locallySafe;
	const prompts = texts.map((text, offset) => {
		const result = redact ? redactText(text) : { text, matches: 0 };
		redactionMatches += result.matches;
		return { index: offset + 1, timestamp: source[offset]?.timestamp ?? transcript.createdAt, text: result.text };
	});
	return {
		source: transcript.source,
		sourceSessionId: transcript.sessionId,
		cwd: transcript.cwd,
		createdAt: transcript.createdAt,
		mode,
		redacted: redact,
		redactionMatches,
		prompts,
	};
}

function escapeHtml(text: string): string {
	return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function fenceFor(text: string): string {
	const matches = text.match(/`+/g) ?? [];
	const longest = matches.reduce((length, match) => Math.max(length, match.length), 2);
	return "`".repeat(longest + 1);
}

function header(record: PromptExport): string {
	return `Prompt history · ${record.source} · ${record.sourceSessionId}`;
}

export function renderPromptExport(record: PromptExport, format: ExportFormat): string {
	if (format === "text") {
		const lines = [
		header(record),
		`Project: ${record.cwd}`,
		`Mode: ${record.mode}`,
		`Redaction: ${record.redacted ? "on" : "off"}`,
		"",
		];
		for (const prompt of record.prompts) {
			lines.push(`--- Prompt ${prompt.index} · ${new Date(prompt.timestamp).toISOString()} ---`, prompt.text, "");
		}
		return lines.join("\n");
	}
	if (format === "markdown") {
		const lines = [
			`# ${header(record)}`,
			"",
			`- Project: \`${record.cwd.replaceAll("`", "\\`")}\``,
			`- Mode: ${record.mode}`,
			`- Redaction: ${record.redacted ? "on" : "off"}`,
		];
		for (const prompt of record.prompts) {
			const fence = fenceFor(prompt.text);
			lines.push("", `## Prompt ${prompt.index}`, "", new Date(prompt.timestamp).toISOString(), "", `${fence}text`, prompt.text, fence);
		}
		return `${lines.join("\n")}\n`;
	}

	const articles = record.prompts.map((prompt) => `
<article>
  <header><h2>Prompt ${prompt.index}</h2><time datetime="${new Date(prompt.timestamp).toISOString()}">${new Date(prompt.timestamp).toISOString()}</time></header>
  <pre>${escapeHtml(prompt.text)}</pre>
</article>`).join("\n");
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(header(record))}</title>
<style>
:root{color-scheme:light dark;font:16px/1.5 system-ui,sans-serif}body{max-width:900px;margin:3rem auto;padding:0 1.25rem}h1{line-height:1.15}dl{display:grid;grid-template-columns:max-content 1fr;gap:.25rem 1rem}article{border-top:1px solid color-mix(in srgb,currentColor 25%,transparent);padding:1.5rem 0}article header{display:flex;align-items:baseline;justify-content:space-between;gap:1rem}time{opacity:.7;font-size:.875rem}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:color-mix(in srgb,currentColor 7%,transparent);padding:1rem;border-radius:.5rem}
</style>
</head>
<body>
<h1>Prompt history</h1>
<dl><dt>Harness</dt><dd>${escapeHtml(record.source)}</dd><dt>Session</dt><dd>${escapeHtml(record.sourceSessionId)}</dd><dt>Project</dt><dd>${escapeHtml(record.cwd)}</dd><dt>Mode</dt><dd>${record.mode}</dd><dt>Redaction</dt><dd>${record.redacted ? "on" : "off"}</dd></dl>
${articles}
</body>
</html>
`;
}

/** Split an export into HTML pages that fit a service byte limit, preserving prompt order. */
export function splitPromptExportForHtml(record: PromptExport, maxBytes = 100_000): PromptExport[] {
	if (record.prompts.length === 0) return [record];
	const pages: PromptExport[] = [];
	let prompts: PromptEntry[] = [];
	for (const prompt of record.prompts) {
		const candidate = { ...record, prompts: [...prompts, prompt] };
		if (Buffer.byteLength(renderPromptExport(candidate, "html"), "utf8") <= maxBytes) {
			prompts.push(prompt);
			continue;
		}
		if (prompts.length === 0) throw new Error(`Prompt ${prompt.index} alone exceeds the HTML publishing limit`);
		pages.push({ ...record, prompts });
		prompts = [prompt];
		if (Buffer.byteLength(renderPromptExport({ ...record, prompts }, "html"), "utf8") > maxBytes) {
			throw new Error(`Prompt ${prompt.index} alone exceeds the HTML publishing limit`);
		}
	}
	if (prompts.length > 0) pages.push({ ...record, prompts });
	return pages;
}

export async function writePromptExport(path: string, content: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, content, "utf8");
}
