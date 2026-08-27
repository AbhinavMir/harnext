import { describe, expect, it, vi } from "vitest";
import { postToHypertext } from "../src/hypertext.js";

function response(body: unknown, ok = true): Response {
	return { ok, status: ok ? 200 : 400, statusText: ok ? "OK" : "Bad Request", json: async () => body } as Response;
}

describe("postToHypertext", () => {
	it("posts HTML with expiry and limits", async () => {
		const fetcher = vi.fn(async () => response({ slug: "abc", url: "https://abc.hypertext.one/", ownerToken: "owner" }));

		const result = await postToHypertext("<h1>hello</h1>", {
			title: "history",
			expires: "7d",
			maxViews: 20,
			fetcher: fetcher as typeof fetch,
		});

		expect(result.url).toBe("https://abc.hypertext.one/");
		const [url, request] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe("https://hypertext.one/api/pastes");
		expect(JSON.parse(request.body as string)).toMatchObject({ html: "<h1>hello</h1>", title: "history", expires: "7d", maxViews: 20 });
	});

	it("rejects HTML over hypertext.one's 100KB limit before posting", async () => {
		const fetcher = vi.fn();
		await expect(postToHypertext("x".repeat(100_001), { fetcher: fetcher as typeof fetch })).rejects.toThrow("100KB");
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("surfaces service errors", async () => {
		const fetcher = async () => response({ error: "rate limited" }, false);
		await expect(postToHypertext("ok", { fetcher: fetcher as typeof fetch })).rejects.toThrow("rate limited");
	});
});
