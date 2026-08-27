/** OpenRouter-backed cleanup for smart prompt-history exports. */

export interface SmartOptions {
	/** OpenRouter model id, for example `anthropic/claude-sonnet-4.6`. */
	model?: string;
	/** Defaults to OPENROUTER_API_KEY. */
	apiKey?: string;
	fetcher?: typeof fetch;
	endpoint?: string;
}

const SYSTEM_PROMPT = `You clean user prompt history for publication.
For each input prompt, write one concise replacement that preserves its meaning, requests, constraints, file paths, commands, and technical facts. Remove repetition, filler, conversational fragments, harness control text, and accidental noise. Do not answer the prompt. Do not add facts. Do not merge prompts. Return exactly one string for every input item, in the same order.`;

const OUTPUT_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: ["prompts"],
	properties: {
		prompts: { type: "array", items: { type: "string" } },
	},
} as const;

interface OpenRouterResponse {
	choices?: Array<{ message?: { content?: string } }>;
	error?: { message?: string };
}

function parsePrompts(content: string, expected: number): string[] {
	let value: unknown;
	try {
		value = JSON.parse(content);
	} catch {
		const start = content.indexOf("{");
		const end = content.lastIndexOf("}");
		if (start < 0 || end <= start) throw new Error("OpenRouter returned no JSON object");
		value = JSON.parse(content.slice(start, end + 1));
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("OpenRouter returned invalid JSON");
	const prompts = (value as Record<string, unknown>).prompts;
	if (!Array.isArray(prompts) || prompts.some((item) => typeof item !== "string")) {
		throw new Error("OpenRouter did not return a string for every prompt");
	}
	if (prompts.length !== expected) throw new Error(`OpenRouter returned ${prompts.length} prompts; expected ${expected}`);
	return prompts as string[];
}

function batches(prompts: string[]): string[][] {
	const result: string[][] = [];
	let batch: string[] = [];
	let characters = 0;
	for (const prompt of prompts) {
		if (batch.length > 0 && (batch.length >= 50 || characters + prompt.length > 80_000)) {
			result.push(batch);
			batch = [];
			characters = 0;
		}
		batch.push(prompt);
		characters += prompt.length;
	}
	if (batch.length > 0) result.push(batch);
	return result;
}

async function cleanBatch(prompts: string[], options: Required<Pick<SmartOptions, "model" | "apiKey" | "fetcher" | "endpoint">>): Promise<string[]> {
	const response = await options.fetcher(options.endpoint, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${options.apiKey}`,
			"Content-Type": "application/json",
			"HTTP-Referer": "https://github.com/AbhinavMir/harnext",
			"X-Title": "harnext",
		},
		body: JSON.stringify({
			model: options.model,
			// Only route to endpoints that can enforce the schema. OpenRouter
			// support is endpoint-specific even when the model id is the same.
			provider: { require_parameters: true },
			messages: [
				{ role: "system", content: SYSTEM_PROMPT },
				{ role: "user", content: JSON.stringify({ prompts }) },
			],
			temperature: 0,
			response_format: {
				type: "json_schema",
				json_schema: { name: "cleaned_prompts", strict: true, schema: OUTPUT_SCHEMA },
			},
		}),
	});
	const payload = await response.json() as OpenRouterResponse;
	if (!response.ok) throw new Error(`OpenRouter ${response.status}: ${payload.error?.message ?? response.statusText}`);
	const content = payload.choices?.[0]?.message?.content;
	if (typeof content !== "string") throw new Error("OpenRouter returned no message content");
	return parsePrompts(content, prompts.length);
}

/** Replace prompts with model-cleaned equivalents. Original text is not returned. */
export async function cleanPrompts(prompts: string[], options: SmartOptions = {}): Promise<string[]> {
	if (prompts.length === 0) return [];
	const apiKey = options.apiKey ?? process.env.OPENROUTER_API_KEY;
	if (apiKey === undefined || apiKey === "") {
		throw new Error("Smart export requires OPENROUTER_API_KEY");
	}
	const model = options.model ?? process.env.OPENROUTER_MODEL;
	if (model === undefined || model === "") {
		throw new Error("Smart export requires --smart-model <openrouter-model> or OPENROUTER_MODEL");
	}
	const resolved = {
		apiKey,
		model,
		fetcher: options.fetcher ?? fetch,
		endpoint: options.endpoint ?? "https://openrouter.ai/api/v1/chat/completions",
	};
	const cleaned: string[] = [];
	for (const batch of batches(prompts)) cleaned.push(...await cleanBatch(batch, resolved));
	return cleaned;
}
