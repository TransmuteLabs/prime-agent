/**
 * OpenAI Codex catalog discovery: the request shape the Codex backend needs in
 * order to answer with a complete model list.
 */

/**
 * The Codex backend gates its model catalog on the reported client version: it answers HTTP 200 with a
 * catalog that grows as the version rises, so a low version yields a silently empty or partial list rather
 * than an error. Prime Agent's own package version is far below the Codex CLI's version line, so it must
 * report a supported Codex client version here instead.
 *
 * Shipping a new Codex model takes two edits, and both are required:
 * 1. Add the model to `codexModels` in `packages/ai/scripts/generate-models.ts` and regenerate. That list is
 *    explicit, not fetched, so an unlisted model does not exist for Prime Agent at all.
 * 2. Raise this constant to a Codex CLI release whose catalog includes that model. `getExecutableModels()`
 *    intersects the registry with the discovered catalog, so a listed model the catalog omits is dropped.
 *
 * Skipping step 2 fails silently and asymmetrically: `rlm` subagent delegation and `find_models()` resolve
 * through `getExecutableModels()` and lose the model, while `/model` reads the unfiltered available list
 * and keeps offering it.
 *
 * Catalog behaviour measured 2026-08-13; see #702.
 */
export const OPENAI_CODEX_CLIENT_VERSION = "0.147.0";

/** The chatgpt account id the Codex catalog request must be attributed to, read from the access token. */
export function readOpenAICodexAccountId(token: string): string | undefined {
	try {
		const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as {
			"https://api.openai.com/auth"?: { chatgpt_account_id?: unknown };
		};
		const accountId = payload["https://api.openai.com/auth"]?.chatgpt_account_id;
		return typeof accountId === "string" && accountId.length > 0 ? accountId : undefined;
	} catch {
		return undefined;
	}
}

export function openAICodexModelsUrl(baseUrl: string): string {
	const normalized = baseUrl.replace(/\/+$/, "");
	let path: string;
	if (normalized.endsWith("/codex/responses")) {
		path = `${normalized.slice(0, -"/responses".length)}/models`;
	} else if (normalized.endsWith("/codex")) {
		path = `${normalized}/models`;
	} else {
		path = `${normalized}/codex/models`;
	}
	const url = new URL(path);
	url.searchParams.set("client_version", OPENAI_CODEX_CLIENT_VERSION);
	return url.toString();
}

export function readOpenAICodexModelIds(value: unknown): Set<string> {
	if (!value || typeof value !== "object" || !("models" in value) || !Array.isArray(value.models)) {
		throw new Error("Invalid OpenAI Codex model catalog");
	}
	return new Set(
		value.models.flatMap((model) => {
			if (!model || typeof model !== "object" || !("slug" in model) || typeof model.slug !== "string") {
				return [];
			}
			return [model.slug];
		}),
	);
}
