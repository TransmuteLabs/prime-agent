import type { Model } from "@earendil-works/pi-ai";

export const PRIME_INFERENCE_BASE_URL = "https://api.pinference.ai/api/v1";
const PRIVATE_MODEL_REFRESH_TIMEOUT_MS = 10_000;

export function isPrivatePrimeInferenceModel(model: Pick<Model<string>, "provider" | "id">): boolean {
	return model.provider === "prime-inference" && model.id.startsWith("internal/");
}

export async function fetchAuthorizedPrivatePrimeInferenceModelIds(
	apiKey: string,
	teamHeaders: Record<string, string>,
	fetchFn: typeof fetch = fetch,
	timeoutMs: number = PRIVATE_MODEL_REFRESH_TIMEOUT_MS,
): Promise<Set<string>> {
	if (!teamHeaders["X-Prime-Team-ID"]) {
		return new Set();
	}

	const response = await fetchFn(`${PRIME_INFERENCE_BASE_URL}/models`, {
		headers: {
			Authorization: `Bearer ${apiKey}`,
			...teamHeaders,
		},
		signal: AbortSignal.timeout(timeoutMs),
	});
	if (response.status === 401 || response.status === 403) {
		return new Set();
	}
	if (!response.ok) {
		throw new Error(`Prime Inference model catalog request failed with status ${response.status}`);
	}

	const payload = (await response.json()) as unknown;
	if (!payload || typeof payload !== "object" || !("data" in payload) || !Array.isArray(payload.data)) {
		throw new Error("Prime Inference model catalog response is invalid");
	}

	return new Set(
		payload.data.flatMap((entry) => {
			if (!entry || typeof entry !== "object" || !("id" in entry) || typeof entry.id !== "string") {
				return [];
			}
			return isPrivatePrimeInferenceModel({ provider: "prime-inference", id: entry.id }) ? [entry.id] : [];
		}),
	);
}
