/** Optional HTML publishing to https://hypertext.one. */

export type HypertextExpiry = "1h" | "1d" | "7d" | "30d" | "60d" | "90d";

export interface HypertextOptions {
	title?: string;
	expires?: HypertextExpiry;
	maxViews?: number;
	password?: string;
	fetcher?: typeof fetch;
	endpoint?: string;
}

export interface HypertextResult {
	slug: string;
	url: string;
	ownerToken: string;
}

interface ResponseValue {
	slug?: unknown;
	url?: unknown;
	ownerToken?: unknown;
	deleteToken?: unknown;
	error?: unknown;
}

export async function postToHypertext(html: string, options: HypertextOptions = {}): Promise<HypertextResult> {
	if (Buffer.byteLength(html, "utf8") > 100_000) {
		throw new Error("hypertext.one accepts at most 100KB of HTML; use a smaller session or smart export");
	}
	const response = await (options.fetcher ?? fetch)(options.endpoint ?? "https://hypertext.one/api/pastes", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			html,
			...(options.title === undefined ? {} : { title: options.title }),
			expires: options.expires ?? "30d",
			...(options.maxViews === undefined ? {} : { maxViews: options.maxViews }),
			...(options.password === undefined ? {} : { password: options.password }),
		}),
	});
	const value = await response.json() as ResponseValue;
	if (!response.ok) throw new Error(`hypertext.one ${response.status}: ${typeof value.error === "string" ? value.error : response.statusText}`);
	const token = typeof value.ownerToken === "string" ? value.ownerToken : value.deleteToken;
	if (typeof value.slug !== "string" || typeof value.url !== "string" || typeof token !== "string") {
		throw new Error("hypertext.one returned an invalid response");
	}
	return { slug: value.slug, url: value.url, ownerToken: token };
}
