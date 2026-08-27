import { describe, expect, it, vi } from "vitest";
import { cleanPrompts } from "../src/smart.js";

function response(body: unknown, ok = true): Response {
	return { ok, status: ok ? 200 : 400, statusText: ok ? "OK" : "Bad Request", json: async () => body } as Response;
}

describe("cleanPrompts", () => {
	it("requires an OpenRouter API key", async () => {
		await expect(cleanPrompts(["hello"], { model: "provider/model", apiKey: "" })).rejects.toThrow("OPENROUTER_API_KEY");
	});

	it("requires an OpenRouter model", async () => {
		await expect(cleanPrompts(["hello"], { apiKey: "key", model: "" })).rejects.toThrow("--smart-model");
	});

	it("replaces prompts with OpenRouter structured output", async () => {
		const fetcher = vi.fn(async () => response({
			choices: [{ message: { content: JSON.stringify({ prompts: ["clean one", "clean two"] }) } }],
		}));

		const cleaned = await cleanPrompts(["raw one", "raw two"], {
			apiKey: "key",
			model: "anthropic/model",
			fetcher: fetcher as typeof fetch,
		});

		expect(cleaned).toEqual(["clean one", "clean two"]);
		const [url, request] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
		expect((request.headers as Record<string, string>).Authorization).toBe("Bearer key");
		const body = JSON.parse(request.body as string) as Record<string, unknown>;
		expect(body.model).toBe("anthropic/model");
		expect(body.provider).toEqual({ require_parameters: true });
		expect(body.response_format).toMatchObject({ type: "json_schema" });
	});

	it("rejects output that changes the prompt count", async () => {
		const fetcher = async () => response({ choices: [{ message: { content: '{"prompts":[]}' } }] });
		await expect(cleanPrompts(["one"], { apiKey: "key", model: "model", fetcher: fetcher as typeof fetch })).rejects.toThrow("expected 1");
	});

	it("surfaces OpenRouter errors", async () => {
		const fetcher = async () => response({ error: { message: "model unavailable" } }, false);
		await expect(cleanPrompts(["one"], { apiKey: "key", model: "model", fetcher: fetcher as typeof fetch })).rejects.toThrow("model unavailable");
	});
});
