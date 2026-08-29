/**
 * CredentialStore implementation backed by auth.json.
 * Provider auth orchestration belongs to ModelRuntime and pi-ai Models.
 */

import type {
	ApiKeyCredential,
	AuthEvent,
	AuthOperationOptions,
	AuthPrompt,
	Credential,
	CredentialInfo,
	CredentialStore,
	OAuthCredential,
	Provider,
	ProviderAuthInteraction,
} from "@earendil-works/pi-ai";
import { findEnvKeys, getEnvApiKey } from "@earendil-works/pi-ai/compat";
import { getMcpOAuthProvider, getMcpOAuthProviders } from "@earendil-works/pi-ai/mcp";
import * as builtinProviderCatalog from "@earendil-works/pi-ai/providers/all";
import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import lockfile from "proper-lockfile";
import { setTimeout as sleep } from "timers/promises";
import { getAgentDir } from "../config.ts";
import { raceWithAbortSignal } from "../utils/abort.ts";
import { getFileRevision, normalizePath } from "../utils/paths.ts";
import { stripBom } from "../utils/text.ts";
import {
	clearPrimeCliCredentials,
	getPrimeCliConfigPath,
	loadPrimeCliConfig,
	PRIME_INFERENCE_PROVIDER_ID,
	type PrimeCliConfig,
	type PrimeTeam,
	savePrimeCliApiKey,
	savePrimeCliTeamSelection,
} from "./prime-inference-auth.ts";
import { isCommandConfigValue, resolveConfigValue, resolveConfigValueUncached } from "./resolve-config-value.ts";

type AuthStorageData = Record<string, Credential>;

export type AuthStorageOptions = {
	primeCliConfigPath?: string;
	usePrimeCliConfig?: boolean;
};

type LockResult<T> = {
	result: T;
	next?: string;
};

/** Fingerprint of a concrete auth source used for stale-credential tracking. */

export type AuthStatus = {
	configured: boolean;
	source?:
		| "stored"
		| "runtime"
		| "environment"
		| "prime_cli"
		| "fallback"
		| "models_json_key"
		| "models_json_command"
		| "stale";
	label?: string;
};

export type AuthSourceToken = {
	provider: string;
	source: "environment" | "fallback" | "models_json_command" | "models_json_key" | "prime_cli" | "runtime" | "stored";
	identityFingerprint: string;
	valueFingerprint: string;
};

/** Team selection stored alongside the Prime Inference API key. */
export type PrimeTeamCredential = {
	teamId: string;
	name: string;
	slug?: string;
	role?: string;
	createdAt?: string;
};

/** Stored api-key credential, optionally carrying a Prime team selection. */
export type PrimeApiKeyCredential = ApiKeyCredential & {
	primeTeam?: PrimeTeamCredential | null;
};

export type AuthCredential = PrimeApiKeyCredential | OAuthCredential;

/** OAuth provider descriptor for login selectors. */
export type OAuthProviderInfo = {
	id: string;
	name: string;
	usesCallbackServer?: boolean;
};

type ActiveAuthStatusSource = Exclude<NonNullable<AuthStatus["source"]>, "stale">;

type AuthSourceCandidate = {
	source: ActiveAuthStatusSource;
	configured: boolean;
	label?: string;
	identityFingerprint: string;
	valueFingerprint?: string;
	/** Deferred value fingerprint: resolving it may execute the user's key command. */
	resolveValueFingerprint?: () => string | undefined;
};

/** Legacy interactive OAuth callback surface (pre-ProviderAuthInteraction). */
export interface LegacyOAuthLoginCallbacks {
	onAuth(info: { url: string; instructions?: string }): void;
	onPrompt(prompt: { message: string; placeholder?: string }): Promise<string>;
	onProgress?(message: string): void;
	onManualCodeInput?(): Promise<string>;
	onSelect(prompt: { message: string; options: { id: string; label: string }[] }): Promise<string | undefined>;
	onDeviceCode?(info: {
		userCode: string;
		verificationUri: string;
		intervalSeconds?: number;
		expiresInSeconds?: number;
	}): void;
	signal?: AbortSignal;
}

/** OAuth providers whose flow runs a local callback server and accepts a pasted redirect URL. */
const CALLBACK_SERVER_OAUTH_PROVIDERS = new Set(["anthropic", "openai-codex"]);

function oauthProviders(): Provider[] {
	return builtinProviderCatalog
		.builtinProviders()
		.filter((provider) => provider.auth.oauth !== undefined && provider.id !== "radius");
}

export function getOAuthProviderInfos(): OAuthProviderInfo[] {
	const modelProviders = oauthProviders().map((provider) => ({
		id: provider.id,
		name: provider.auth.oauth?.name ?? provider.name,
		usesCallbackServer: CALLBACK_SERVER_OAUTH_PROVIDERS.has(provider.id),
	}));
	const mcpProviders = getMcpOAuthProviders().map((provider) => ({
		id: provider.id,
		name: provider.name,
		usesCallbackServer: provider.usesCallbackServer ?? true,
	}));
	return [...modelProviders, ...mcpProviders];
}

type ResolvedOAuthLogin = {
	login: (interaction: ProviderAuthInteraction) => Promise<OAuthCredential>;
};

function findOAuthLogin(providerId: string): ResolvedOAuthLogin | undefined {
	const mcp = getMcpOAuthProvider(providerId);
	if (mcp) {
		return { login: (interaction) => mcp.login(interaction) };
	}
	const provider = oauthProviders().find((candidate) => candidate.id === providerId);
	if (!provider?.auth.oauth) {
		return undefined;
	}
	return { login: (interaction) => provider.auth.oauth!.login(interaction) };
}

function toProviderAuthInteraction(callbacks: LegacyOAuthLoginCallbacks): ProviderAuthInteraction {
	const signal = callbacks.signal ?? new AbortController().signal;
	return {
		signal,
		notify: (event: AuthEvent) => {
			switch (event.type) {
				case "auth_url":
					callbacks.onAuth({ url: event.url, instructions: event.instructions });
					break;
				case "device_code":
					if (callbacks.onDeviceCode) {
						callbacks.onDeviceCode({
							userCode: event.userCode,
							verificationUri: event.verificationUri,
							...(event.intervalSeconds !== undefined ? { intervalSeconds: event.intervalSeconds } : {}),
							...(event.expiresInSeconds !== undefined ? { expiresInSeconds: event.expiresInSeconds } : {}),
						});
					} else {
						callbacks.onAuth({
							url: event.verificationUri,
							instructions: `Enter code: ${event.userCode}`,
						});
					}
					break;
				case "progress":
					callbacks.onProgress?.(event.message);
					break;
				case "info":
					callbacks.onProgress?.(event.message);
					break;
			}
		},
		prompt: async (prompt: AuthPrompt): Promise<string> => {
			switch (prompt.type) {
				case "select": {
					const selected = await callbacks.onSelect({
						message: prompt.message,
						options: prompt.options.map((option) => ({ id: option.id, label: option.label })),
					});
					if (selected === undefined) {
						throw new Error("Login cancelled");
					}
					return selected;
				}
				case "manual_code":
					if (callbacks.onManualCodeInput) {
						return callbacks.onManualCodeInput();
					}
					return callbacks.onPrompt({ message: prompt.message, placeholder: prompt.placeholder });
				default:
					return callbacks.onPrompt({ message: prompt.message, placeholder: prompt.placeholder });
			}
		},
	};
}

function toPrimeTeamCredential(team: PrimeTeam): PrimeTeamCredential {
	const credential: PrimeTeamCredential = {
		teamId: team.teamId,
		name: team.name,
	};
	if (team.slug) {
		credential.slug = team.slug;
	}
	if (team.role) {
		credential.role = team.role;
	}
	if (team.createdAt) {
		credential.createdAt = team.createdAt;
	}
	return credential;
}

// The mode applies only on creation so administrator-managed modes and ACLs remain intact.
const AUTH_FILE_WRITE_OPTIONS = { encoding: "utf-8", mode: 0o600 } as const;

type AuthFileReload = {
	controller: AbortController;
	promise: Promise<AuthStorageData>;
	readers: number;
};

type AuthFileReadState = {
	data: AuthStorageData;
	revision?: string;
	reload?: AuthFileReload;
};

let sharedAuthFileReadState: { authPath: string; readState: AuthFileReadState } | undefined;

export interface AuthStorageBackend {
	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T;
	withLockAsync<T>(
		fn: (current: string | undefined) => Promise<LockResult<T>>,
		options?: AuthOperationOptions,
	): Promise<T>;
}

export class FileAuthStorageBackend implements AuthStorageBackend {
	private authPath: string;

	constructor(authPath: string = join(getAgentDir(), "auth.json")) {
		this.authPath = normalizePath(authPath);
	}

	private ensureParentDir(): void {
		const dir = dirname(this.authPath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true, mode: 0o700 });
		}
	}

	private ensureFileExists(): void {
		if (!existsSync(this.authPath)) {
			writeFileSync(this.authPath, "{}", AUTH_FILE_WRITE_OPTIONS);
		}
	}

	private acquireLockSyncWithRetry(path: string): () => void {
		const maxAttempts = 10;
		const delayMs = 20;
		let lastError: unknown;

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			try {
				return lockfile.lockSync(path, { realpath: false });
			} catch (error) {
				const code =
					typeof error === "object" && error !== null && "code" in error
						? String((error as { code?: unknown }).code)
						: undefined;
				if (code !== "ELOCKED" || attempt === maxAttempts) {
					throw error;
				}
				lastError = error;
				const start = Date.now();
				while (Date.now() - start < delayMs) {
					// Sleep synchronously to avoid changing callers to async.
				}
			}
		}

		throw (lastError as Error) ?? new Error("Failed to acquire auth storage lock");
	}

	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
		this.ensureParentDir();
		this.ensureFileExists();

		let release: (() => void) | undefined;
		try {
			release = this.acquireLockSyncWithRetry(this.authPath);
			const current = existsSync(this.authPath) ? readFileSync(this.authPath, "utf-8") : undefined;
			const { result, next } = fn(current);
			if (next !== undefined) {
				writeFileSync(this.authPath, next, AUTH_FILE_WRITE_OPTIONS);
			}
			return result;
		} finally {
			if (release) {
				release();
			}
		}
	}

	private async acquireLockAsync(
		signal: AbortSignal | undefined,
		onCompromised: (error: Error) => void,
	): Promise<() => Promise<void>> {
		const staleMs = 30_000;
		const maxDelayMs = 2_000;
		const deadline = Date.now() + staleMs;
		let retry = 0;
		while (true) {
			signal?.throwIfAborted();
			let release: (() => Promise<void>) | undefined;
			try {
				release = await lockfile.lock(this.authPath, {
					realpath: false,
					retries: 0,
					stale: staleMs,
					onCompromised,
				});
			} catch (error) {
				signal?.throwIfAborted();
				const code =
					typeof error === "object" && error !== null && "code" in error
						? String((error as { code?: unknown }).code)
						: undefined;
				const remainingMs = deadline - Date.now();
				if (code !== "ELOCKED" || remainingMs <= 0) throw error;
				const baseDelayMs = Math.min(10 * 2 ** retry, maxDelayMs / 2);
				retry++;
				const delayMs = Math.min(Math.round(baseDelayMs * (1 + Math.random())), remainingMs);
				if (signal) await sleep(delayMs, undefined, { signal });
				else await sleep(delayMs);
				continue;
			}
			if (signal?.aborted) {
				await release();
				signal.throwIfAborted();
			}
			return release;
		}
	}

	async withLockAsync<T>(
		fn: (current: string | undefined) => Promise<LockResult<T>>,
		options?: AuthOperationOptions,
	): Promise<T> {
		options?.signal?.throwIfAborted();
		this.ensureParentDir();
		this.ensureFileExists();

		let release: (() => Promise<void>) | undefined;
		let lockCompromised = false;
		let lockCompromisedError: Error | undefined;
		const throwIfCompromised = () => {
			if (lockCompromised) {
				throw lockCompromisedError ?? new Error("Auth storage lock was compromised");
			}
		};

		try {
			release = await this.acquireLockAsync(options?.signal, (error) => {
				lockCompromised = true;
				lockCompromisedError = error;
			});

			throwIfCompromised();
			options?.signal?.throwIfAborted();
			const current = existsSync(this.authPath) ? readFileSync(this.authPath, "utf-8") : undefined;
			const { result, next } = await fn(current);
			throwIfCompromised();
			options?.signal?.throwIfAborted();
			if (next !== undefined) {
				writeFileSync(this.authPath, next, AUTH_FILE_WRITE_OPTIONS);
			}
			throwIfCompromised();
			return result;
		} finally {
			if (release) {
				try {
					await release();
				} catch {
					// Ignore unlock errors when lock is compromised.
				}
			}
		}
	}
}

export class ReadOnlyAuthStorage implements CredentialStore {
	private readonly authPath: string;
	private data: AuthStorageData | undefined;

	constructor(authPath: string = join(getAgentDir(), "auth.json")) {
		this.authPath = normalizePath(authPath);
	}

	private load(): AuthStorageData {
		if (this.data) return this.data;

		let parsed: unknown;
		try {
			parsed = JSON.parse(stripBom(readFileSync(this.authPath, "utf-8")));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				this.data = {};
				return this.data;
			}
			throw new Error(`Failed to read auth.json: ${error instanceof Error ? error.message : String(error)}`);
		}

		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			throw new Error("Invalid auth.json: expected an object");
		}
		for (const [providerId, credential] of Object.entries(parsed)) {
			if (typeof credential !== "object" || credential === null || Array.isArray(credential)) {
				throw new Error(`Invalid auth.json credential for provider "${providerId}"`);
			}
			const value = credential as Record<string, unknown>;
			if (value.type === "api_key") {
				const validKey = value.key === undefined || typeof value.key === "string";
				const validEnv =
					value.env === undefined ||
					(typeof value.env === "object" &&
						value.env !== null &&
						!Array.isArray(value.env) &&
						Object.values(value.env).every((entry) => typeof entry === "string"));
				if (validKey && validEnv) continue;
			} else if (
				value.type === "oauth" &&
				typeof value.access === "string" &&
				typeof value.refresh === "string" &&
				typeof value.expires === "number" &&
				Number.isFinite(value.expires)
			) {
				continue;
			}
			throw new Error(`Invalid auth.json credential for provider "${providerId}"`);
		}

		this.data = parsed as AuthStorageData;
		return this.data;
	}

	async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
		options?.signal?.throwIfAborted();
		const credential = this.load()[providerId];
		options?.signal?.throwIfAborted();
		if (!credential) return undefined;
		if (credential.type !== "api_key" || !credential.key || isCommandConfigValue(credential.key)) {
			return structuredClone(credential);
		}
		return { ...credential, key: resolveConfigValue(credential.key, credential.env) };
	}

	async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		options?.signal?.throwIfAborted();
		const credentials = Object.entries(this.load()).map(([providerId, credential]) => ({
			providerId,
			type: credential.type,
		}));
		options?.signal?.throwIfAborted();
		return credentials;
	}

	async modify(
		_providerId: string,
		_fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		_options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		throw new Error("Read-only credential storage cannot modify auth.json");
	}

	async delete(_providerId: string, _options?: AuthOperationOptions): Promise<void> {
		throw new Error("Read-only credential storage cannot modify auth.json");
	}
}

export class InMemoryAuthStorageBackend implements AuthStorageBackend {
	private value: string | undefined;
	private asyncChain: Promise<unknown> = Promise.resolve();

	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
		const { result, next } = fn(this.value);
		if (next !== undefined) {
			this.value = next;
		}
		return result;
	}

	withLockAsync<T>(
		fn: (current: string | undefined) => Promise<LockResult<T>>,
		options?: AuthOperationOptions,
	): Promise<T> {
		const previous = this.asyncChain;
		const operation = (async () => {
			await previous.catch(() => {});
			options?.signal?.throwIfAborted();
			const { result, next } = await fn(this.value);
			options?.signal?.throwIfAborted();
			if (next !== undefined) {
				this.value = next;
			}
			return result;
		})();
		this.asyncChain = operation.catch(() => {});
		return raceWithAbortSignal(operation, options?.signal);
	}
}

/**
 * Credential storage backed by a JSON file.
 */
export class AuthStorage implements CredentialStore {
	private storage: AuthStorageBackend;
	private authPath: string | undefined;
	private options: AuthStorageOptions;
	private readState: AuthFileReadState;

	private constructor(storage: AuthStorageBackend, authPath?: string, options: AuthStorageOptions = {}) {
		this.storage = storage;
		this.authPath = authPath;
		this.options = options;
		this.readState =
			authPath && sharedAuthFileReadState?.authPath === authPath ? sharedAuthFileReadState.readState : { data: {} };
		if (authPath && !sharedAuthFileReadState) {
			sharedAuthFileReadState = { authPath, readState: this.readState };
		}
		if (authPath) {
			const revision = getFileRevision(authPath);
			if (revision !== undefined && revision === this.readState.revision) return;
		}
		this.reload();
	}

	static create(authPath?: string, options?: AuthStorageOptions): AuthStorage {
		// Only the real agent auth file falls back to the user's Prime CLI credentials;
		// an injected path is an isolated store and must not read them.
		const authOptions = options ?? { usePrimeCliConfig: authPath === undefined };
		const normalizedAuthPath = normalizePath(authPath ?? join(getAgentDir(), "auth.json"));
		return new AuthStorage(new FileAuthStorageBackend(normalizedAuthPath), normalizedAuthPath, authOptions);
	}

	static fromStorage(storage: AuthStorageBackend, options?: AuthStorageOptions): AuthStorage {
		return new AuthStorage(storage, undefined, options);
	}

	static inMemory(data: AuthStorageData = {}, options?: AuthStorageOptions): AuthStorage {
		const storage = new InMemoryAuthStorageBackend();
		storage.withLock(() => ({ result: undefined, next: JSON.stringify(data, null, 2) }));
		return AuthStorage.fromStorage(storage, options);
	}

	private parseStorageData(content: string | undefined): AuthStorageData {
		if (!content) {
			return {};
		}
		return JSON.parse(stripBom(content)) as AuthStorageData;
	}

	private updateReadState(data: AuthStorageData, revision?: string): void {
		this.readState.data = data;
		this.readState.revision = revision;
	}

	/**
	 * Reload credentials from storage.
	 */
	reload(): void {
		let content: string | undefined;
		let revision: string | undefined;
		try {
			this.storage.withLock((current) => {
				content = current;
				revision = this.authPath ? getFileRevision(this.authPath) : undefined;
				return { result: undefined };
			});
			this.updateReadState(this.parseStorageData(content), revision);
		} catch {
			// Preserve the last valid in-memory snapshot.
		}
	}

	private async reloadFromStorageAsync(options?: AuthOperationOptions): Promise<AuthStorageData> {
		return this.storage.withLockAsync(async (content) => {
			const currentData = this.parseStorageData(content);
			const revision = this.authPath ? getFileRevision(this.authPath) : undefined;
			this.updateReadState(currentData, revision);
			return { result: currentData };
		}, options);
	}

	private async readLatestData(options?: AuthOperationOptions): Promise<AuthStorageData> {
		options?.signal?.throwIfAborted();
		if (!this.authPath) {
			const reload = this.reloadFromStorageAsync(options);
			return options?.signal ? reload : reload.catch(() => this.readState.data);
		}
		const revision = getFileRevision(this.authPath);
		if (revision !== undefined && revision === this.readState.revision) return this.readState.data;
		if (!this.readState.reload) {
			const controller = new AbortController();
			const reload: AuthFileReload = {
				controller,
				promise: this.reloadFromStorageAsync({ signal: controller.signal }),
				readers: 0,
			};
			this.readState.reload = reload;
			void reload.promise.then(
				() => {
					if (this.readState.reload === reload) this.readState.reload = undefined;
				},
				() => {
					if (this.readState.reload === reload) this.readState.reload = undefined;
				},
			);
		}

		const reload = this.readState.reload;
		reload.readers++;
		try {
			const result = raceWithAbortSignal(reload.promise, options?.signal);
			return options?.signal ? await result : await result.catch(() => this.readState.data);
		} finally {
			reload.readers--;
			if (reload.readers === 0 && this.readState.reload === reload) {
				this.readState.reload = undefined;
				reload.controller.abort();
			}
		}
	}

	async read(provider: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
		// A runtime override has to reach the model runtime through this contract:
		// resolving it only in the synchronous facade would let getApiKey report a
		// key while every request built from the runtime still fails without one.
		const runtimeCredential = this.getRuntimeOverrideCredential(provider);
		if (runtimeCredential) {
			options?.signal?.throwIfAborted();
			return runtimeCredential;
		}
		const credential = (await this.readLatestData(options))[provider];
		options?.signal?.throwIfAborted();
		if (credential?.type !== "api_key") return credential;
		if (credential.key === undefined) return credential;
		return { ...credential, key: resolveConfigValue(credential.key, credential.env) };
	}

	async modify(
		provider: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		let latestData = this.readState.data;
		let revision: string | undefined;
		const result = await this.storage.withLockAsync(async (content) => {
			const currentData = this.parseStorageData(content);
			const next = await fn(currentData[provider]);
			if (next === undefined) {
				latestData = currentData;
				revision = this.authPath ? getFileRevision(this.authPath) : undefined;
				return { result: currentData[provider] };
			}

			const merged: AuthStorageData = { ...currentData, [provider]: next };
			latestData = merged;
			return { result: next, next: JSON.stringify(merged, null, 2) };
		}, options);
		this.updateReadState(latestData, revision);
		return result;
	}

	async delete(provider: string, options?: AuthOperationOptions): Promise<void> {
		// Deletion is the store-contract logout; leaving the non-persistent override
		// behind would keep answering read() with the credential just removed.
		this.removeRuntimeApiKey(provider);
		let latestData = this.readState.data;
		await this.storage.withLockAsync(async (content) => {
			const currentData = this.parseStorageData(content);
			delete currentData[provider];
			latestData = currentData;
			return { result: undefined, next: JSON.stringify(currentData, null, 2) };
		}, options);
		this.updateReadState(latestData);
	}

	/** List credential metadata without resolving configured key values. */
	async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		const entries = new Map<string, CredentialInfo>(
			Object.entries(await this.readLatestData(options)).map(([providerId, credential]) => [
				providerId,
				{ providerId, type: credential.type },
			]),
		);
		options?.signal?.throwIfAborted();
		for (const providerId of this.runtimeOverrides.keys()) {
			if (this.getRuntimeOverrideCredential(providerId)) entries.set(providerId, { providerId, type: "api_key" });
		}
		return [...entries.values()];
	}

	// =========================================================================
	// Synchronous interactive-TUI API (prime-agent compatibility)
	// =========================================================================

	private runtimeOverrides: Map<string, string> = new Map();
	private staleAuthSources: Map<string, AuthSourceToken[]> = new Map();

	/** Set a runtime API key override (not persisted to disk). Used for CLI --api-key. */
	setRuntimeApiKey(provider: string, apiKey: string): void {
		this.clearStaleAuthSource(provider, "runtime");
		this.runtimeOverrides.set(provider, apiKey);
	}

	/** Remove a runtime API key override. */
	removeRuntimeApiKey(provider: string): void {
		this.clearStaleAuthSource(provider, "runtime");
		this.runtimeOverrides.delete(provider);
	}

	/** Get the stored credential for a provider (unresolved, synchronous snapshot). */
	get(provider: string): AuthCredential | undefined {
		return this.readState.data[provider];
	}

	/** Set the credential for a provider, persisting synchronously. */
	set(provider: string, credential: AuthCredential): void {
		this.clearStaleAuthSource(provider, "stored");
		this.persistProviderChange(provider, credential);
	}

	/** Remove the credential for a provider, persisting synchronously. */
	remove(provider: string): void {
		this.clearStaleAuthSource(provider, "stored");
		this.persistProviderChange(provider, undefined);
	}

	/**
	 * Remove a provider's credential with the disk write verified: throws on any
	 * load or write failure instead of recording it, so callers can refuse to
	 * proceed while the credential may still exist on disk. Disk-authoritative
	 * and idempotent.
	 */
	removeVerified(provider: string): void {
		const merged = this.storage.withLock((current) => {
			const currentData = this.parseStorageData(current);
			if (!(provider in currentData)) return { result: currentData };
			const next: AuthStorageData = { ...currentData };
			delete next[provider];
			return { result: next, next: JSON.stringify(next, null, 2) };
		});
		this.updateReadState(merged, this.authPath ? getFileRevision(this.authPath) : undefined);
		// Post-success only: a failed removal must not make a stale-marked credential selectable again.
		this.clearStaleAuthSource(provider, "stored");
	}

	/** List all providers with stored credentials (synchronous snapshot). */
	listProviderIds(): string[] {
		return Object.keys(this.readState.data);
	}

	/** Check if a stored credential exists for a provider. */
	has(provider: string): boolean {
		return provider in this.readState.data;
	}

	private persistProviderChange(provider: string, credential: AuthCredential | undefined): void {
		const merged = this.storage.withLock((current) => {
			const currentData = this.parseStorageData(current);
			const next: AuthStorageData = { ...currentData };
			if (credential) {
				next[provider] = credential;
			} else {
				delete next[provider];
			}
			return { result: next, next: JSON.stringify(next, null, 2) };
		});
		this.updateReadState(merged, this.authPath ? getFileRevision(this.authPath) : undefined);
	}

	private fingerprintAuthSource(source: ActiveAuthStatusSource, material: string): string {
		const digest = createHash("sha256").update(source).update("\0").update(material).digest("hex");
		return `${source}:${digest}`;
	}

	private createAuthSourceCandidate(options: {
		source: ActiveAuthStatusSource;
		configured: boolean;
		identityMaterial: string;
		valueMaterial?: string;
		label?: string;
		resolveValueMaterial?: () => string | undefined;
	}): AuthSourceCandidate {
		return {
			configured: options.configured,
			source: options.source,
			...(options.label ? { label: options.label } : {}),
			identityFingerprint: this.fingerprintAuthSource(options.source, `identity:${options.identityMaterial}`),
			...(options.valueMaterial !== undefined
				? {
						valueFingerprint: this.fingerprintAuthSource(
							options.source,
							`value:${options.identityMaterial}\0${options.valueMaterial}`,
						),
					}
				: {}),
			...(options.resolveValueMaterial
				? {
						resolveValueFingerprint: () => {
							const valueMaterial = options.resolveValueMaterial?.();
							return valueMaterial === undefined
								? undefined
								: this.fingerprintAuthSource(
										options.source,
										`value:${options.identityMaterial}\0${valueMaterial}`,
									);
						},
					}
				: {}),
		};
	}

	private getStoredCredentialValueMaterial(credential: AuthCredential): string | undefined {
		if (credential.type === "api_key") {
			if (credential.key === undefined) return undefined;
			if (isCommandConfigValue(credential.key)) {
				const resolvedKey = resolveConfigValueUncached(credential.key);
				return resolvedKey === undefined ? undefined : `api_key:command:${credential.key}\0${resolvedKey}`;
			}
			return `api_key:${credential.key}\0${resolveConfigValue(credential.key) ?? ""}`;
		}
		return `oauth:${credential.access}\0${credential.refresh}\0${credential.expires}`;
	}

	/** The effective non-persistent override for a provider, or undefined when unset or stale. */
	private getRuntimeOverrideCredential(provider: string): Credential | undefined {
		const apiKey = this.runtimeOverrides.get(provider);
		if (!apiKey) return undefined;
		const candidate = this.getRuntimeAuthCandidate(provider);
		if (!candidate || this.isAuthSourceStale(provider, candidate)) return undefined;
		return { type: "api_key", key: apiKey };
	}

	private getRuntimeAuthCandidate(provider: string): AuthSourceCandidate | undefined {
		const apiKey = this.runtimeOverrides.get(provider);
		if (!apiKey) {
			return undefined;
		}
		return {
			label: "--api-key",
			...this.createAuthSourceCandidate({
				configured: false,
				source: "runtime",
				identityMaterial: provider,
				valueMaterial: apiKey,
			}),
		};
	}

	private getPrimeCliAuthCandidate(provider: string): AuthSourceCandidate | undefined {
		const apiKey = this.getPrimeCliApiKey(provider);
		if (!apiKey) {
			return undefined;
		}
		return {
			label: "Prime CLI",
			...this.createAuthSourceCandidate({
				configured: false,
				source: "prime_cli",
				identityMaterial: provider,
				valueMaterial: apiKey,
			}),
		};
	}

	private getStoredAuthCandidate(
		provider: string,
		options?: { resolveCommandValue?: boolean; resolvedCommandValue?: string },
	): AuthSourceCandidate | undefined {
		const credential = this.readState.data[provider];
		if (!credential) {
			return undefined;
		}
		const isCommandApiKey =
			credential.type === "api_key" && credential.key !== undefined && isCommandConfigValue(credential.key);
		// A command credential is fingerprinted from the command's output, so the value
		// material stays deferred: status queries must not run the command.
		const commandValueMaterial =
			isCommandApiKey && options?.resolvedCommandValue !== undefined
				? `api_key:command:${credential.key}\0${options.resolvedCommandValue}`
				: undefined;
		return this.createAuthSourceCandidate({
			configured: true,
			source: "stored",
			identityMaterial: isCommandApiKey ? `api_key:command:${credential.key}` : `${provider}:${credential.type}`,
			valueMaterial:
				commandValueMaterial ??
				(isCommandApiKey && !options?.resolveCommandValue
					? undefined
					: this.getStoredCredentialValueMaterial(credential)),
			resolveValueMaterial: isCommandApiKey ? () => this.getStoredCredentialValueMaterial(credential) : undefined,
		});
	}

	private getEnvironmentAuthCandidate(provider: string): AuthSourceCandidate | undefined {
		const envKeys = findEnvKeys(provider);
		const envKey = envKeys?.[0];
		const apiKey = getEnvApiKey(provider);
		if (!apiKey) {
			return undefined;
		}
		const label = envKey ?? "ambient credentials";
		const identityMaterial = envKey ?? this.getAmbientEnvironmentIdentityMaterial(provider);
		return this.createAuthSourceCandidate({
			configured: false,
			source: "environment",
			label,
			identityMaterial,
			valueMaterial: `${identityMaterial}\0${apiKey}`,
		});
	}

	/**
	 * Ambient credentials resolve to a sentinel key, so identity must come from the
	 * environment that selects them; otherwise a stale marker would outlive the switch.
	 */
	private getAmbientEnvironmentIdentityMaterial(provider: string): string {
		if (provider === "amazon-bedrock") {
			if (process.env.AWS_PROFILE) return `amazon-bedrock:profile:${process.env.AWS_PROFILE}`;
			if (process.env.AWS_ACCESS_KEY_ID) {
				return `amazon-bedrock:access-key:${process.env.AWS_ACCESS_KEY_ID}:${process.env.AWS_SECRET_ACCESS_KEY ?? ""}:${process.env.AWS_SESSION_TOKEN ?? ""}`;
			}
			if (process.env.AWS_BEARER_TOKEN_BEDROCK) {
				return `amazon-bedrock:bearer:${process.env.AWS_BEARER_TOKEN_BEDROCK}`;
			}
			if (process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI) {
				return `amazon-bedrock:ecs-relative:${process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI}`;
			}
			if (process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI) {
				return `amazon-bedrock:ecs-full:${process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI}`;
			}
			if (process.env.AWS_WEB_IDENTITY_TOKEN_FILE) {
				return `amazon-bedrock:web-identity:${process.env.AWS_WEB_IDENTITY_TOKEN_FILE}`;
			}
		}
		if (provider === "google-vertex") {
			const project = process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GCLOUD_PROJECT ?? "";
			const location = process.env.GOOGLE_CLOUD_LOCATION ?? "";
			const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS ?? "application-default";
			return `google-vertex:${project}:${location}:${credentialsPath}`;
		}
		return provider;
	}

	private getAuthSourceCandidates(provider: string): AuthSourceCandidate[] {
		const candidates =
			provider === PRIME_INFERENCE_PROVIDER_ID
				? [
						this.getRuntimeAuthCandidate(provider),
						this.getEnvironmentAuthCandidate(provider),
						this.getPrimeCliAuthCandidate(provider),
						this.getStoredAuthCandidate(provider),
					]
				: [
						this.getRuntimeAuthCandidate(provider),
						this.getStoredAuthCandidate(provider),
						this.getEnvironmentAuthCandidate(provider),
					];
		return candidates.filter((candidate): candidate is AuthSourceCandidate => candidate !== undefined);
	}

	private getMatchingStaleAuthSources(provider: string, candidate: AuthSourceCandidate): AuthSourceToken[] {
		const stale = this.staleAuthSources.get(provider);
		if (!stale) {
			return [];
		}
		return stale.filter(
			(token) => token.source === candidate.source && token.identityFingerprint === candidate.identityFingerprint,
		);
	}

	private isAuthSourceStale(provider: string, candidate: AuthSourceCandidate): boolean {
		const matchingStale = this.getMatchingStaleAuthSources(provider, candidate);
		if (matchingStale.length === 0) {
			return false;
		}
		const valueFingerprint = candidate.valueFingerprint ?? candidate.resolveValueFingerprint?.();
		return Boolean(valueFingerprint && matchingStale.some((token) => token.valueFingerprint === valueFingerprint));
	}

	private getAvailableAuthCandidate(provider: string): {
		candidate?: AuthSourceCandidate;
		hasStaleCandidate: boolean;
	} {
		let hasStaleCandidate = false;
		for (const candidate of this.getAuthSourceCandidates(provider)) {
			if (this.isAuthSourceStale(provider, candidate)) {
				hasStaleCandidate = true;
				continue;
			}
			return { candidate, hasStaleCandidate };
		}
		return { hasStaleCandidate };
	}

	/** Check if any form of auth is configured for a provider. */
	hasAuth(provider: string): boolean {
		return this.getAvailableAuthCandidate(provider).candidate !== undefined;
	}

	/** Return auth status without exposing credential values or refreshing tokens. */
	getAuthStatus(provider: string): AuthStatus {
		const { candidate, hasStaleCandidate } = this.getAvailableAuthCandidate(provider);
		if (candidate) {
			return {
				configured: candidate.configured,
				source: candidate.source,
				...(candidate.label ? { label: candidate.label } : {}),
			};
		}
		if (hasStaleCandidate) {
			return { configured: false, source: "stale", label: "expired" };
		}
		return { configured: false };
	}

	/** Mark the provider's current auth source as stale (e.g. after a 401). */
	markAuthStale(provider: string): boolean {
		const token = this.getCurrentAuthSourceToken(provider);
		return token ? this.markAuthSourceStale(token) : false;
	}

	private getAuthSourceTokenForCandidate(
		provider: string,
		candidate: AuthSourceCandidate,
	): AuthSourceToken | undefined {
		const valueFingerprint = candidate.valueFingerprint ?? candidate.resolveValueFingerprint?.();
		if (!valueFingerprint) {
			return undefined;
		}
		return {
			provider,
			source: candidate.source,
			identityFingerprint: candidate.identityFingerprint,
			valueFingerprint,
		};
	}

	getCurrentAuthSourceToken(provider: string): AuthSourceToken | undefined {
		const { candidate } = this.getAvailableAuthCandidate(provider);
		if (!candidate) {
			return undefined;
		}
		return this.getAuthSourceTokenForCandidate(provider, candidate);
	}

	markAuthSourceStale(token: AuthSourceToken): boolean {
		if (token.provider.length === 0) {
			return false;
		}
		const stale = this.staleAuthSources.get(token.provider) ?? [];
		if (
			!stale.some(
				(existing) =>
					existing.source === token.source &&
					existing.identityFingerprint === token.identityFingerprint &&
					existing.valueFingerprint === token.valueFingerprint,
			)
		) {
			stale.push(token);
		}
		this.staleAuthSources.set(token.provider, stale);
		return true;
	}

	private clearStaleAuthSource(provider: string, source: ActiveAuthStatusSource): void {
		const stale = this.staleAuthSources.get(provider);
		if (!stale) {
			return;
		}
		const next = stale.filter((token) => token.source !== source);
		if (next.length === 0) {
			this.staleAuthSources.delete(provider);
		} else {
			this.staleAuthSources.set(provider, next);
		}
	}

	/**
	 * Resolve the effective API key for a provider across runtime overrides,
	 * environment variables, Prime CLI config (Prime Inference only), and stored
	 * credentials, skipping sources marked stale.
	 *
	 * OAuth tokens are returned only while unexpired; refresh is owned by the
	 * model runtime layer. models.json fallback resolvers also live in the
	 * runtime, so `includeFallback` is accepted for prime-agent parity but has
	 * no store-level effect.
	 */
	getApiKey(providerId: string, _options?: { includeFallback?: boolean }): string | undefined {
		const runtimeCandidate = this.getRuntimeAuthCandidate(providerId);
		const runtimeKey = this.runtimeOverrides.get(providerId);
		if (runtimeKey && runtimeCandidate && !this.isAuthSourceStale(providerId, runtimeCandidate)) {
			return runtimeKey;
		}

		const envCandidate = this.getEnvironmentAuthCandidate(providerId);
		const envKey = getEnvApiKey(providerId);
		if (
			providerId === PRIME_INFERENCE_PROVIDER_ID &&
			envKey &&
			envCandidate &&
			!this.isAuthSourceStale(providerId, envCandidate)
		) {
			return envKey;
		}

		if (providerId === PRIME_INFERENCE_PROVIDER_ID) {
			const primeCliCandidate = this.getPrimeCliAuthCandidate(providerId);
			const primeCliKey = this.getPrimeCliApiKey(providerId);
			if (primeCliKey && primeCliCandidate && !this.isAuthSourceStale(providerId, primeCliCandidate)) {
				return primeCliKey;
			}
		}

		const credential = this.readState.data[providerId];
		if (credential) {
			const storedCandidate = this.getStoredAuthCandidate(providerId);
			if (storedCandidate && !this.isAuthSourceStale(providerId, storedCandidate)) {
				if (credential.type === "api_key" && credential.key !== undefined) {
					const hasStaleRecord = this.getMatchingStaleAuthSources(providerId, storedCandidate).length > 0;
					const resolved =
						isCommandConfigValue(credential.key) && hasStaleRecord
							? resolveConfigValueUncached(credential.key)
							: resolveConfigValue(credential.key, credential.env);
					if (resolved) {
						return resolved;
					}
				}
				if (credential.type === "oauth" && Date.now() < credential.expires) {
					return credential.access;
				}
			}
		}
		// Stored auth wins over environment variables for non-Prime-Inference providers.
		if (
			providerId !== PRIME_INFERENCE_PROVIDER_ID &&
			envKey &&
			envCandidate &&
			!this.isAuthSourceStale(providerId, envCandidate)
		) {
			return envKey;
		}

		return undefined;
	}

	/** Get all registered OAuth providers (login selector entries). */
	getOAuthProviders(): OAuthProviderInfo[] {
		return getOAuthProviderInfos();
	}

	/** Login to an OAuth provider, storing the resulting credential. */
	async login(providerId: string, callbacks: LegacyOAuthLoginCallbacks): Promise<void> {
		const provider = findOAuthLogin(providerId);
		if (!provider) {
			throw new Error(`Unknown OAuth provider: ${providerId}`);
		}
		const credential = await provider.login(toProviderAuthInteraction(callbacks));
		this.set(providerId, credential);
	}

	/** Logout from a provider (also clears Prime CLI credentials for Prime Inference). */
	logout(provider: string): void {
		if (provider === PRIME_INFERENCE_PROVIDER_ID && this.isPrimeCliConfigEnabled()) {
			clearPrimeCliCredentials(this.getEnabledPrimeCliConfigPath());
			this.clearStaleAuthSource(provider, "prime_cli");
		}
		this.remove(provider);
	}

	/** Prime CLI config path used for Prime Inference credentials, when that fallback is enabled. */
	getPrimeCliConfigPath(): string | undefined {
		if (!this.isPrimeCliConfigEnabled()) {
			return undefined;
		}
		return getPrimeCliConfigPath(this.options.primeCliConfigPath);
	}

	private getEnabledPrimeCliConfigPath(): string {
		const configPath = this.getPrimeCliConfigPath();
		if (!configPath) {
			throw new Error("Prime CLI config is not enabled");
		}
		return configPath;
	}

	private isPrimeCliConfigEnabled(): boolean {
		return Boolean(this.options.usePrimeCliConfig || this.options.primeCliConfigPath);
	}

	private getPrimeCliConfig(providerId: string): PrimeCliConfig | undefined {
		if (providerId !== PRIME_INFERENCE_PROVIDER_ID || !this.isPrimeCliConfigEnabled()) {
			return undefined;
		}
		return loadPrimeCliConfig(this.options.primeCliConfigPath);
	}

	private getPrimeCliApiKey(providerId: string): string | undefined {
		return this.getPrimeCliConfig(providerId)?.apiKey;
	}

	setPrimeInferenceTeamSelection(team: PrimeTeam | null): void {
		if (this.isPrimeCliConfigEnabled()) {
			savePrimeCliTeamSelection(team, this.getEnabledPrimeCliConfigPath());
			return;
		}

		const credential = this.get(PRIME_INFERENCE_PROVIDER_ID);
		if (credential?.type !== "api_key") {
			return;
		}
		this.set(PRIME_INFERENCE_PROVIDER_ID, {
			...credential,
			primeTeam: team ? toPrimeTeamCredential(team) : null,
		});
	}

	setPrimeInferenceApiKey(apiKey: string): void {
		if (!this.isPrimeCliConfigEnabled()) {
			this.set(PRIME_INFERENCE_PROVIDER_ID, {
				...(this.get(PRIME_INFERENCE_PROVIDER_ID) ?? {}),
				type: "api_key",
				key: apiKey,
			});
			return;
		}
		const configPath = this.getEnabledPrimeCliConfigPath();
		const config = loadPrimeCliConfig(configPath);
		const existingCredential = this.get(PRIME_INFERENCE_PROVIDER_ID);
		const legacyPrimeTeam = existingCredential?.type === "api_key" ? existingCredential.primeTeam : undefined;
		if (config.apiKey !== apiKey) {
			savePrimeCliApiKey(apiKey, configPath);
		} else if (!config.teamIdFromEnv && (legacyPrimeTeam === null || (!config.teamId && legacyPrimeTeam))) {
			savePrimeCliTeamSelection(legacyPrimeTeam, configPath);
		}
		this.clearStaleAuthSource(PRIME_INFERENCE_PROVIDER_ID, "prime_cli");
		if (this.has(PRIME_INFERENCE_PROVIDER_ID)) {
			this.remove(PRIME_INFERENCE_PROVIDER_ID);
		}
	}

	getPrimeInferenceTeamSelection(): PrimeTeamCredential | null | undefined {
		const config = this.getPrimeCliConfig(PRIME_INFERENCE_PROVIDER_ID);
		if (config?.teamIdFromEnv) {
			return undefined;
		}

		const credential = this.get(PRIME_INFERENCE_PROVIDER_ID);
		const authSource = this.getAuthStatus(PRIME_INFERENCE_PROVIDER_ID).source;
		if (authSource === "runtime" || authSource === "environment") {
			return undefined;
		}
		if (authSource === "prime_cli") {
			if (credential?.type === "api_key" && credential.primeTeam === null) {
				return null;
			}
			if (config?.teamId) {
				return toPrimeTeamCredential({
					teamId: config.teamId,
					name: config.teamName ?? "Prime CLI team",
					...(config.teamRole ? { role: config.teamRole } : {}),
				});
			}
			if (credential?.type === "api_key" && credential.primeTeam) {
				return credential.primeTeam;
			}
			return null;
		}
		if (credential?.type === "api_key" && credential.primeTeam !== undefined) {
			return credential.primeTeam;
		}
		if (!config?.apiKey && config?.teamId) {
			return toPrimeTeamCredential({
				teamId: config.teamId,
				name: config.teamName ?? "Prime CLI team",
				...(config.teamRole ? { role: config.teamRole } : {}),
			});
		}
		return undefined;
	}

	/** Extra provider headers derived from auth state (Prime team selection). */
	getProviderHeaders(providerId: string): Record<string, string> | undefined {
		if (providerId !== PRIME_INFERENCE_PROVIDER_ID) {
			return undefined;
		}

		const primeCliConfig = this.getPrimeCliConfig(providerId);
		if (primeCliConfig?.teamIdFromEnv) {
			return primeCliConfig.teamId ? { "X-Prime-Team-ID": primeCliConfig.teamId } : undefined;
		}

		const teamId = this.getPrimeInferenceTeamSelection()?.teamId;
		return teamId ? { "X-Prime-Team-ID": teamId } : undefined;
	}
}

/**
 * One-off synchronous read of a stored credential from an auth.json file,
 * without instantiating a store or resolving configured key values.
 */
export function readStoredCredential(
	providerId: string,
	authPath: string = join(getAgentDir(), "auth.json"),
): Credential | undefined {
	try {
		const data = JSON.parse(stripBom(readFileSync(normalizePath(authPath), "utf-8"))) as AuthStorageData;
		return data[providerId];
	} catch {
		return undefined;
	}
}
