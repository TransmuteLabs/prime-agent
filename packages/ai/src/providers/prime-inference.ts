import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth, lazyOAuth } from "../auth/helpers.ts";
import { loadPrimeInferenceOAuth } from "../auth/oauth/load.ts";
import { createProvider, type Provider } from "../models.ts";
import { PRIME_INFERENCE_MODELS } from "./prime-inference.models.ts";

export function primeInferenceProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "prime-inference",
		name: "Prime Inference",
		baseUrl: "https://api.pinference.ai/api/v1",
		auth: {
			apiKey: envApiKeyAuth("Prime Inference API key", ["PRIME_API_KEY"]),
			oauth: lazyOAuth({
				name: "Prime Inference",
				loginLabel: "Sign in with Prime Intellect",
				load: loadPrimeInferenceOAuth,
			}),
		},
		models: Object.values(PRIME_INFERENCE_MODELS),
		api: openAICompletionsApi(),
	});
}
