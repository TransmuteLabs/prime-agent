import { createHash } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Api, Credential, CredentialStore, Model, Provider } from "@earendil-works/pi-ai";
import { PRIME_INFERENCE_PROVIDER_ID } from "./prime-inference-auth.ts";
import {
	fetchAuthorizedPrivatePrimeInferenceModelIds,
	isPrivatePrimeInferenceModel,
} from "./prime-inference-models.ts";

const AUTHORIZATION_CACHE_FILE = "prime-inference-private-models.json";
const AUTHORIZATION_CACHE_TTL_MS = 5 * 60_000;
const BACKGROUND_REFRESH_TIMEOUT_MS = 3_000;

interface AuthorizationCache {
	fingerprint: string;
	modelIds: Set<string>;
	refreshedAt: number;
}

/**
 * A credential store that also carries provider-scoped request headers. Prime
 * Inference team selection is stored beside the credential, not in models.json,
 * so it reaches requests through this contract rather than provider config.
 */
export interface ProviderHeaderSource {
	getProviderHeaders(providerId: string): Record<string, string> | undefined;
}

export function asProviderHeaderSource(store: CredentialStore): ProviderHeaderSource | undefined {
	const candidate = store as Partial<ProviderHeaderSource>;
	return typeof candidate.getProviderHeaders === "function" ? (candidate as ProviderHeaderSource) : undefined;
}

function credentialSecret(credential: Credential | undefined): string | undefined {
	if (!credential) return undefined;
	return credential.type === "api_key" ? credential.key : credential.access;
}

function authorizationFingerprint(secret: string, teamId: string): string {
	return createHash("sha256").update(secret).update("\0").update(teamId).digest("hex");
}

export interface PrivatePrimeInferenceAuthorizationOptions {
	credentials: CredentialStore;
	/** Team scoping for the catalog request; a private model is team-scoped, so no team means no private models. */
	teamHeaders: () => Record<string, string> | undefined;
	/** Private model ids declared in models.json; declaring one asserts access without a catalog check. */
	explicitModelIds: () => ReadonlySet<string>;
	/** Directory holding the persisted decision, or undefined when the runtime has no models.json. */
	cacheDir: () => string | undefined;
	networkEnabled: () => boolean;
}

/**
 * Authorization state for private Prime Inference models. The catalog request is
 * async while `Provider.filterModels` is synchronous, so the decision is refreshed
 * here and read from the memoized set during availability passes.
 */
export class PrivatePrimeInferenceAuthorization {
	private readonly options: PrivatePrimeInferenceAuthorizationOptions;
	private authorizedModelIds = new Set<string>();
	private authorizedTeamId: string | undefined;
	private backgroundRefresh: { fingerprint: string; promise: Promise<void> } | undefined;
	/** Freshness of the in-memory decision, so repeat callers do not re-ask the catalog. */
	private decision: { fingerprint: string; refreshedAt: number } | undefined;
	private inFlight: { fingerprint: string; promise: Promise<void> } | undefined;

	constructor(options: PrivatePrimeInferenceAuthorizationOptions) {
		this.options = options;
	}

	/** Whether a private model may be offered: declared by the user, or authorized by the team catalog. */
	isOffered(modelId: string): boolean {
		return this.options.explicitModelIds().has(modelId) || this.authorizedModelIds.has(modelId);
	}

	async refresh(): Promise<void> {
		const secret = credentialSecret(await this.options.credentials.read(PRIME_INFERENCE_PROVIDER_ID));
		const teamHeaders = this.options.teamHeaders();
		const teamId = teamHeaders?.["X-Prime-Team-ID"];
		if (!secret || !teamHeaders || !teamId) {
			this.clear();
			return;
		}

		const fingerprint = authorizationFingerprint(secret, teamId);
		// The decision is per credential+team and changes rarely, so within its TTL it is
		// answered from memory: without this every availability pass re-asks the catalog.
		if (
			this.decision?.fingerprint === fingerprint &&
			Date.now() - this.decision.refreshedAt < AUTHORIZATION_CACHE_TTL_MS
		) {
			return;
		}
		if (this.inFlight?.fingerprint === fingerprint) return this.inFlight.promise;
		const promise = this.runRefresh(secret, teamHeaders, teamId, fingerprint);
		this.inFlight = { fingerprint, promise };
		try {
			await promise;
		} finally {
			if (this.inFlight?.promise === promise) this.inFlight = undefined;
		}
	}

	private async runRefresh(
		secret: string,
		teamHeaders: Record<string, string>,
		teamId: string,
		fingerprint: string,
	): Promise<void> {
		const previousModelIds = new Set(this.authorizedModelIds);
		const previousTeamId = this.authorizedTeamId;
		const cached = this.readCache();
		if (cached?.fingerprint === fingerprint) {
			// Serve the persisted decision so startup and model lists don't block on
			// the network. A stale cache refreshes in the background and the updated
			// ids apply to subsequent lookups in this process.
			this.adopt(cached.modelIds, teamId, fingerprint, cached.refreshedAt);
			if (Date.now() - cached.refreshedAt < AUTHORIZATION_CACHE_TTL_MS || !this.options.networkEnabled()) return;
			this.startBackgroundRefresh(secret, teamHeaders, teamId, fingerprint);
			return;
		}
		if (!this.options.networkEnabled()) {
			this.clear();
			return;
		}

		let authorizedIds: Set<string> | undefined;
		try {
			authorizedIds = await fetchAuthorizedPrivatePrimeInferenceModelIds(secret, teamHeaders);
		} catch {
			// Fall back to the previous authorization below.
		}
		// Leave newer state untouched if the credentials changed while fetching.
		if ((await this.currentFingerprint()) !== fingerprint) return;
		if (authorizedIds) {
			const refreshedAt = Date.now();
			this.adopt(authorizedIds, teamId, fingerprint, refreshedAt);
			this.writeCache({ fingerprint, modelIds: authorizedIds, refreshedAt });
		} else if (teamId === previousTeamId) {
			// A transient failure keeps the team's last decision rather than revoking it.
			this.authorizedModelIds = previousModelIds;
			this.authorizedTeamId = teamId;
		} else {
			this.clear();
		}
	}

	private adopt(modelIds: ReadonlySet<string>, teamId: string, fingerprint: string, refreshedAt: number): void {
		this.authorizedModelIds = new Set(modelIds);
		this.authorizedTeamId = teamId;
		this.decision = { fingerprint, refreshedAt };
	}

	private clear(): void {
		this.authorizedModelIds.clear();
		this.authorizedTeamId = undefined;
		this.decision = undefined;
	}

	/**
	 * Stale cache hits refresh in the background; failures keep the cached ids.
	 * Refreshes for the same credentials are deduped, a changed-credentials refresh
	 * is queued after the in-flight one, and a result is only applied while the
	 * credentials it was fetched with are still current.
	 */
	private startBackgroundRefresh(
		secret: string,
		teamHeaders: Record<string, string>,
		teamId: string,
		fingerprint: string,
	): void {
		if (this.backgroundRefresh?.fingerprint === fingerprint) return;
		const run = async () => {
			try {
				const authorizedIds = await fetchAuthorizedPrivatePrimeInferenceModelIds(
					secret,
					teamHeaders,
					undefined,
					BACKGROUND_REFRESH_TIMEOUT_MS,
				);
				if ((await this.currentFingerprint()) !== fingerprint) return;
				const refreshedAt = Date.now();
				this.adopt(authorizedIds, teamId, fingerprint, refreshedAt);
				this.writeCache({ fingerprint, modelIds: authorizedIds, refreshedAt });
			} catch {
				// Keep the cached authorization.
			}
		};
		const pending = this.backgroundRefresh?.promise;
		const promise = (pending ?? Promise.resolve()).then(run);
		this.backgroundRefresh = { fingerprint, promise };
		void promise.finally(() => {
			if (this.backgroundRefresh?.promise === promise) this.backgroundRefresh = undefined;
		});
	}

	private async currentFingerprint(): Promise<string | undefined> {
		const secret = credentialSecret(await this.options.credentials.read(PRIME_INFERENCE_PROVIDER_ID));
		const teamId = this.options.teamHeaders()?.["X-Prime-Team-ID"];
		return secret && teamId ? authorizationFingerprint(secret, teamId) : undefined;
	}

	private cachePath(): string | undefined {
		const dir = this.options.cacheDir();
		return dir ? join(dir, AUTHORIZATION_CACHE_FILE) : undefined;
	}

	private readCache(): AuthorizationCache | undefined {
		const cachePath = this.cachePath();
		if (!cachePath) return undefined;
		try {
			const parsed = JSON.parse(readFileSync(cachePath, "utf8")) as Partial<
				Omit<AuthorizationCache, "modelIds"> & { modelIds: string[] }
			>;
			if (
				typeof parsed.fingerprint !== "string" ||
				!Array.isArray(parsed.modelIds) ||
				typeof parsed.refreshedAt !== "number"
			) {
				return undefined;
			}
			return {
				fingerprint: parsed.fingerprint,
				modelIds: new Set(parsed.modelIds),
				refreshedAt: parsed.refreshedAt,
			};
		} catch {
			return undefined;
		}
	}

	private writeCache(cache: AuthorizationCache): void {
		const cachePath = this.cachePath();
		if (!cachePath) return;
		try {
			const tmpPath = `${cachePath}.${process.pid}.tmp`;
			writeFileSync(tmpPath, JSON.stringify({ ...cache, modelIds: [...cache.modelIds] }), { mode: 0o600 });
			renameSync(tmpPath, cachePath);
		} catch {
			// A failed cache write only requires a later refetch.
		}
	}
}

/** Apply the private-model authorization decision through the provider's own availability filter. */
export function withPrivatePrimeInferenceAuthorization(
	provider: Provider,
	authorization: PrivatePrimeInferenceAuthorization,
): Provider {
	return {
		...provider,
		getModels: () => provider.getModels(),
		filterModels: (models: readonly Model<Api>[], credential: Credential | undefined) => {
			const filtered = provider.filterModels ? provider.filterModels(models, credential) : models;
			return filtered.filter((model) => !isPrivatePrimeInferenceModel(model) || authorization.isOffered(model.id));
		},
	};
}
