import type {
	Api,
	AssistantMessage,
	AuthResult,
	Context,
	Model,
	ModelsApiStreamOptions,
	ModelsRefreshOptions,
	ModelsRefreshResult,
	Provider,
	ProviderHeaders,
} from "@earendil-works/pi-ai";
import type { AuthSourceToken, AuthStatus, AuthStorage } from "./auth-storage.ts";
import type { ModelRuntime } from "./model-runtime.ts";
import type { ProviderConfigInput } from "./provider-composer.ts";

export type { ProviderConfigInput } from "./provider-composer.ts";
export type ResolvedRequestAuth =
	| {
			ok: true;
			apiKey?: string;
			headers?: ProviderHeaders;
			baseUrl?: string;
			env?: Record<string, string>;
	  }
	| { ok: false; error: string };
export { clearApiKeyCache } from "./provider-composer.ts";

/**
 * Synchronous compatibility facade exposed to extensions.
 * Coding-agent internals use ModelRuntime directly.
 */
export class ModelRegistry {
	private readonly runtime: ModelRuntime;

	constructor(runtime: ModelRuntime) {
		this.runtime = runtime;
	}

	/** Reload models.json asynchronously. Await before making synchronous registry reads. */
	refresh(options?: ModelsRefreshOptions): Promise<ModelsRefreshResult> {
		return this.runtime.refresh(options);
	}

	/** Reload models and return the available model list (daemon/connection consumers). */
	async refreshAvailableModels(options?: ModelsRefreshOptions): Promise<Model<Api>[]> {
		await this.refresh(options);
		return this.getAvailable();
	}

	/** Reload models and return catalog shape used by agent-connection. */
	async refreshModelCatalog(options?: ModelsRefreshOptions): Promise<{
		models: Model<Api>[];
		configuredProviders: string[];
	}> {
		await this.refresh(options);
		const models = this.getAll();
		const configuredProviders = [
			...new Set(models.filter((model) => this.hasConfiguredAuth(model)).map((model) => model.provider)),
		];
		return { models, configuredProviders };
	}

	async canUseModel(model: Model<Api>): Promise<boolean> {
		return this.hasConfiguredAuth(model);
	}

	getError(): string | undefined {
		return this.runtime.getError();
	}

	getAll(): Model<Api>[] {
		return [...this.runtime.getModels()];
	}

	getAvailable(): Model<Api>[] {
		return [...this.runtime.getAvailableSnapshot()];
	}

	find(provider: string, modelId: string): Model<Api> | undefined {
		return this.runtime.getModel(provider, modelId);
	}

	hasConfiguredAuth(model: Model<Api>): boolean {
		return this.runtime.hasConfiguredAuth(model.provider);
	}

	async getApiKeyAndHeaders(model: Model<Api>): Promise<ResolvedRequestAuth> {
		try {
			const resolution = await this.runtime.getAuth(model);
			if (!resolution) {
				const compatibility = this.runtime.getCompatibilityRequestConfig(model);
				if (compatibility.authHeader) {
					return { ok: false, error: `No API key found for "${model.provider}"` };
				}
				return { ok: true, headers: compatibility.headers };
			}
			return {
				ok: true,
				apiKey: resolution.auth.apiKey,
				headers: resolution.auth.headers,
				...(resolution.auth.baseUrl ? { baseUrl: resolution.auth.baseUrl } : {}),
				env: resolution.env,
			};
		} catch (error) {
			const cause = error instanceof Error ? error.cause : undefined;
			const message =
				cause instanceof Error ? cause.message : error instanceof Error ? error.message : String(error);
			return {
				ok: false,
				error:
					message === "authHeader requires a resolved API key"
						? `No API key found for "${model.provider}"`
						: message,
			};
		}
	}

	getProviderAuthStatus(provider: string): AuthStatus {
		// The auth store knows Prime CLI credentials and stale-source tracking; the
		// runtime additionally covers models.json/provider-config auth.
		const stored = this.authStorage.getAuthStatus(provider);
		if (stored.source && stored.source !== "stale") {
			return stored;
		}
		const runtimeStatus = this.runtime.getProviderAuthStatus(provider);
		if (stored.source === "stale" && !runtimeStatus.configured) {
			return stored;
		}
		return runtimeStatus;
	}

	/** The persistent auth.json store backing this registry's runtime. */
	get authStorage(): AuthStorage {
		return this.runtime.authStorage;
	}

	/** Mark the provider's current auth source as stale (e.g. after an auth failure). */
	markProviderAuthStale(provider: string): boolean {
		return this.authStorage.markAuthStale(provider);
	}

	markProviderAuthSourceStale(token: AuthSourceToken): boolean {
		return this.authStorage.markAuthSourceStale(token);
	}

	getProvider(provider: string): Provider | undefined {
		return this.runtime.getProvider(provider);
	}

	complete<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ModelsApiStreamOptions<TApi>,
	): Promise<AssistantMessage> {
		return this.runtime.complete(model, context, options);
	}

	getProviderDisplayName(provider: string): string {
		return this.runtime.getProvider(provider)?.name ?? provider;
	}

	getProviderAuth(provider: string): Promise<AuthResult | undefined> {
		return this.runtime.getAuth(provider);
	}

	async getApiKeyForProvider(provider: string): Promise<string | undefined> {
		try {
			return (await this.runtime.getAuth(provider))?.auth.apiKey;
		} catch {
			return undefined;
		}
	}

	isUsingOAuth(model: Model<Api>): boolean {
		return this.runtime.isUsingOAuth(model.provider);
	}

	registerProvider(provider: Provider): void;
	registerProvider(providerName: string, config: ProviderConfigInput): void;
	registerProvider(providerOrName: Provider | string, config?: ProviderConfigInput): void {
		if (typeof providerOrName === "string") {
			if (!config) throw new Error("Provider config is required when registering by name");
			this.runtime.registerProvider(providerOrName, config);
			return;
		}
		this.runtime.registerNativeProvider(providerOrName);
	}

	unregisterProvider(providerName: string): void {
		this.runtime.unregisterProvider(providerName);
	}

	getRegisteredProviderConfig(providerName: string): ProviderConfigInput | undefined {
		return this.runtime.getRegisteredProviderConfig(providerName);
	}

	getRegisteredNativeProvider(providerName: string): Provider | undefined {
		return this.runtime.getRegisteredNativeProvider(providerName);
	}

	getRegisteredProviderIds(): readonly string[] {
		return this.runtime.getRegisteredProviderIds();
	}
}
