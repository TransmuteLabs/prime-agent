import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CredentialStore, createModels, type Provider } from "@earendil-works/pi-ai";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AuthStorage, FileAuthStorageBackend } from "../src/core/auth-storage.ts";
import { clearConfigValueCache } from "../src/core/resolve-config-value.ts";

describe("AuthStorage", () => {
	const tempDir = join(tmpdir(), `pi-test-auth-storage-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	const authJsonPath = join(tempDir, "auth.json");
	let authStorage: AuthStorage;

	beforeEach(() => {
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
		clearConfigValueCache();
		vi.restoreAllMocks();
	});

	function writeAuthJson(data: Record<string, unknown>): void {
		writeFileSync(authJsonPath, JSON.stringify(data));
	}

	function toShPath(value: string): string {
		return value.replace(/\\/g, "/").replace(/"/g, '\\"');
	}

	test("reads and resolves stored API-key credentials", async () => {
		const original = process.env.TEST_AUTH_STORAGE_KEY;
		process.env.TEST_AUTH_STORAGE_KEY = "environment-key";
		try {
			writeAuthJson({ anthropic: { type: "api_key", key: "$TEST_AUTH_STORAGE_KEY" } });
			const storage = AuthStorage.create(authJsonPath);
			expect(await storage.read("anthropic")).toEqual({ type: "api_key", key: "environment-key" });
		} finally {
			if (original === undefined) delete process.env.TEST_AUTH_STORAGE_KEY;
			else process.env.TEST_AUTH_STORAGE_KEY = original;
		}
	});

	test("resolves command-backed API-key credentials", async () => {
		writeAuthJson({ anthropic: { type: "api_key", key: "!printf 'command-key'" } });
		const storage = AuthStorage.create(authJsonPath);
		expect(await storage.read("anthropic")).toEqual({ type: "api_key", key: "command-key" });
	});

	test("returns OAuth credentials unchanged", async () => {
		const credential = {
			type: "oauth" as const,
			access: "access-token",
			refresh: "refresh-token",
			expires: Date.now() + 60_000,
		};
		const storage = AuthStorage.inMemory({ anthropic: credential });
		expect(await storage.read("anthropic")).toEqual(credential);
	});

	test("credential-scoped env takes precedence and remains inspectable", async () => {
		writeAuthJson({
			anthropic: {
				type: "api_key",
				key: "$SCOPED_KEY",
				env: { SCOPED_KEY: "scoped-value", REGION: "test-region" },
			},
		});
		const storage = AuthStorage.create(authJsonPath);
		expect(await storage.read("anthropic")).toMatchObject({
			key: "scoped-value",
			env: { SCOPED_KEY: "scoped-value", REGION: "test-region" },
		});
	});

	test("coalesces file reloads across concurrent readers and storage instances", async () => {
		writeAuthJson({ anthropic: { type: "api_key", key: "old" } });
		const first = AuthStorage.create(authJsonPath);
		const second = AuthStorage.create(authJsonPath);
		const lockSpy = vi.spyOn(lockfile, "lock");

		writeAuthJson({
			anthropic: { type: "api_key", key: "new" },
			openai: { type: "api_key", key: "openai-key" },
		});

		const [anthropic, openai, credentials] = await Promise.all([
			first.read("anthropic", { signal: new AbortController().signal }),
			second.read("openai", { signal: new AbortController().signal }),
			first.list({ signal: new AbortController().signal }),
		]);
		expect(anthropic).toEqual({ type: "api_key", key: "new" });
		expect(openai).toEqual({ type: "api_key", key: "openai-key" });
		expect(credentials).toEqual([
			{ providerId: "anthropic", type: "api_key" },
			{ providerId: "openai", type: "api_key" },
		]);
		expect(lockSpy).toHaveBeenCalledTimes(1);

		await expect(second.read("anthropic")).resolves.toEqual({ type: "api_key", key: "new" });
		expect(lockSpy).toHaveBeenCalledTimes(1);

		const otherPath = join(tempDir, "other-auth.json");
		writeFileSync(otherPath, JSON.stringify({ other: { type: "api_key", key: "other-key" } }));
		const otherFirst = AuthStorage.create(otherPath);
		const otherSecond = AuthStorage.create(otherPath);
		await otherFirst.read("other");
		await otherSecond.read("other");
		await otherFirst.list();
		expect(lockSpy).toHaveBeenCalledTimes(1);

		const third = AuthStorage.create(authJsonPath);
		writeAuthJson({ anthropic: { type: "api_key", key: "newest" } });
		const [firstReload, thirdReload] = await Promise.all([first.read("anthropic"), third.read("anthropic")]);
		expect(firstReload).toEqual({ type: "api_key", key: "newest" });
		expect(thirdReload).toEqual({ type: "api_key", key: "newest" });
		expect(lockSpy).toHaveBeenCalledTimes(2);
	});

	test("keeps a coalesced reload alive while another credential reader is waiting", async () => {
		writeAuthJson({ anthropic: { type: "api_key", key: "old" } });
		const storage = AuthStorage.create(authJsonPath);
		writeAuthJson({ anthropic: { type: "api_key", key: "new" } });
		let grantLock: (() => void) | undefined;
		const lockGranted = new Promise<void>((resolve) => {
			grantLock = resolve;
		});
		const release = vi.fn(async () => {});
		const lockSpy = vi.spyOn(lockfile, "lock").mockImplementation(async () => {
			await lockGranted;
			return release;
		});
		const firstController = new AbortController();
		const secondController = new AbortController();
		const first = storage.read("anthropic", { signal: firstController.signal });
		const second = storage.read("anthropic", { signal: secondController.signal });

		firstController.abort();
		await expect(first).rejects.toMatchObject({ name: "AbortError" });
		grantLock?.();
		await expect(second).resolves.toEqual({ type: "api_key", key: "new" });
		expect(lockSpy).toHaveBeenCalledTimes(1);
		expect(release).toHaveBeenCalledTimes(1);
	});

	test.skipIf(process.platform === "win32")("creates new auth files with owner-only permissions", () => {
		AuthStorage.create(authJsonPath);

		expect(statSync(authJsonPath).mode & 0o777).toBe(0o600);
	});

	test.skipIf(process.platform === "win32")("preserves the mode of an existing auth file", async () => {
		writeAuthJson({ anthropic: { type: "api_key", key: "old" } });
		chmodSync(authJsonPath, 0o660);
		const storage = AuthStorage.create(authJsonPath);

		await storage.modify("anthropic", async () => ({ type: "api_key", key: "new" }));

		expect(statSync(authJsonPath).mode & 0o777).toBe(0o660);
	});

	test("modify persists a credential while preserving unrelated external edits", async () => {
		writeAuthJson({ anthropic: { type: "api_key", key: "old" } });
		const storage = AuthStorage.create(authJsonPath);
		writeAuthJson({
			anthropic: { type: "api_key", key: "old" },
			openai: { type: "api_key", key: "external" },
		});

		await storage.modify("anthropic", async () => ({ type: "api_key", key: "new" }));

		expect(JSON.parse(readFileSync(authJsonPath, "utf8"))).toEqual({
			anthropic: { type: "api_key", key: "new" },
			openai: { type: "api_key", key: "external" },
		});
	});

	test("modify with undefined leaves the current credential unchanged", async () => {
		writeAuthJson({ anthropic: { type: "api_key", key: "stored" } });
		const storage = AuthStorage.create(authJsonPath);
		expect(await storage.modify("anthropic", async () => undefined)).toEqual({ type: "api_key", key: "stored" });
		expect(await storage.read("anthropic")).toEqual({ type: "api_key", key: "stored" });
	});

	test("serializes concurrent modifications", async () => {
		writeAuthJson({});
		const first = AuthStorage.create(authJsonPath);
		const second = AuthStorage.create(authJsonPath);
		await Promise.all([
			first.modify("anthropic", async () => ({ type: "api_key", key: "anthropic-key" })),
			second.modify("openai", async () => ({ type: "api_key", key: "openai-key" })),
		]);
		expect(JSON.parse(readFileSync(authJsonPath, "utf8"))).toEqual({
			anthropic: { type: "api_key", key: "anthropic-key" },
			openai: { type: "api_key", key: "openai-key" },
		});
	});

	test("delete removes one credential while preserving others", async () => {
		writeAuthJson({
			anthropic: { type: "api_key", key: "anthropic-key" },
			openai: { type: "api_key", key: "openai-key" },
		});
		const storage = AuthStorage.create(authJsonPath);
		writeAuthJson({
			anthropic: { type: "api_key", key: "anthropic-key" },
			openai: { type: "api_key", key: "openai-key" },
			google: { type: "api_key", key: "external-key" },
		});
		await storage.delete("anthropic");
		await expect(storage.list()).resolves.toEqual([
			{ providerId: "openai", type: "api_key" },
			{ providerId: "google", type: "api_key" },
		]);
		expect(await storage.read("anthropic")).toBeUndefined();
		expect(await storage.read("openai")).toEqual({ type: "api_key", key: "openai-key" });
		expect(await storage.read("google")).toEqual({ type: "api_key", key: "external-key" });
	});

	test("in-memory storage implements the same credential-store behavior", async () => {
		const storage = AuthStorage.inMemory({ anthropic: { type: "api_key", key: "initial" } });
		expect(await storage.read("anthropic")).toEqual({ type: "api_key", key: "initial" });
		await storage.modify("anthropic", async () => ({ type: "api_key", key: "updated" }));
		expect(await storage.read("anthropic")).toEqual({ type: "api_key", key: "updated" });
		await storage.delete("anthropic");
		await expect(storage.list()).resolves.toEqual([]);
	});

	test("does not write after lock acquisition failure and recovers on retry", async () => {
		writeAuthJson({ anthropic: { type: "api_key", key: "stored" } });
		const storage = AuthStorage.create(authJsonPath);
		const lockSpy = vi.spyOn(lockfile, "lock").mockRejectedValueOnce(new Error("lock unavailable"));

		await expect(storage.modify("openai", async () => ({ type: "api_key", key: "new" }))).rejects.toThrow(
			"lock unavailable",
		);
		expect(JSON.parse(readFileSync(authJsonPath, "utf8"))).toEqual({
			anthropic: { type: "api_key", key: "stored" },
		});

		lockSpy.mockRestore();
		await storage.modify("openai", async () => ({ type: "api_key", key: "new" }));
		expect(JSON.parse(readFileSync(authJsonPath, "utf8"))).toEqual({
			anthropic: { type: "api_key", key: "stored" },
			openai: { type: "api_key", key: "new" },
		});
	});

	test("retries a briefly contended file lock", async () => {
		writeAuthJson({ anthropic: { type: "api_key", key: "stored" } });
		const backend = new FileAuthStorageBackend(authJsonPath);
		const release = vi.fn(async () => {});
		const lockSpy = vi
			.spyOn(lockfile, "lock")
			.mockRejectedValueOnce(Object.assign(new Error("locked"), { code: "ELOCKED" }))
			.mockResolvedValueOnce(release);
		vi.spyOn(Math, "random").mockReturnValue(0);
		const update = vi.fn(async () => ({ result: undefined }));

		await backend.withLockAsync(update);

		expect(lockSpy).toHaveBeenCalledTimes(2);
		expect(update).toHaveBeenCalledTimes(1);
		expect(release).toHaveBeenCalledTimes(1);
	});

	test("surfaces a compromised file storage lock", async () => {
		writeAuthJson({ anthropic: { type: "api_key", key: "stored" } });
		const backend = new FileAuthStorageBackend(authJsonPath);
		const update = vi.fn(async () => ({ result: undefined, next: JSON.stringify({}) }));
		const compromised = new Error("lock compromised");
		vi.spyOn(lockfile, "lock").mockImplementation(async (_file, options) => {
			options?.onCompromised?.(compromised);
			return async () => {};
		});

		await expect(backend.withLockAsync(update)).rejects.toThrow(compromised);
		expect(update).not.toHaveBeenCalled();
		expect(JSON.parse(readFileSync(authJsonPath, "utf8"))).toEqual({
			anthropic: { type: "api_key", key: "stored" },
		});
	});

	test("pre-aborted file operations do not create the backing file or run the mutation", async () => {
		const backend = new FileAuthStorageBackend(authJsonPath);
		const controller = new AbortController();
		controller.abort();
		const update = vi.fn(async () => ({ result: undefined, next: JSON.stringify({}) }));

		await expect(backend.withLockAsync(update, { signal: controller.signal })).rejects.toMatchObject({
			name: "AbortError",
		});
		expect(update).not.toHaveBeenCalled();
		expect(existsSync(authJsonPath)).toBe(false);
	});

	test("aborts while waiting for a held file lock without running the mutation later", async () => {
		writeAuthJson({ anthropic: { type: "api_key", key: "stored" } });
		const release = await lockfile.lock(authJsonPath, { realpath: false });
		const backend = new FileAuthStorageBackend(authJsonPath);
		const controller = new AbortController();
		const update = vi.fn(async () => ({ result: undefined, next: JSON.stringify({}) }));
		const pending = backend.withLockAsync(update, { signal: controller.signal });

		await new Promise((resolve) => setTimeout(resolve, 10));
		controller.abort();
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		expect(update).not.toHaveBeenCalled();

		await release();
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(update).not.toHaveBeenCalled();
		expect(JSON.parse(readFileSync(authJsonPath, "utf8"))).toEqual({
			anthropic: { type: "api_key", key: "stored" },
		});
	});

	test("releases a file lock acquired concurrently with cancellation before mutation", async () => {
		writeAuthJson({ anthropic: { type: "api_key", key: "stored" } });
		const backend = new FileAuthStorageBackend(authJsonPath);
		const controller = new AbortController();
		const release = vi.fn(async () => {});
		vi.spyOn(lockfile, "lock").mockImplementation(async () => {
			controller.abort();
			return release;
		});
		const update = vi.fn(async () => ({ result: undefined, next: JSON.stringify({}) }));

		await expect(backend.withLockAsync(update, { signal: controller.signal })).rejects.toMatchObject({
			name: "AbortError",
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(update).not.toHaveBeenCalled();
		expect(release).toHaveBeenCalledTimes(1);
	});

	test("holds the file lock until a cancelled active callback settles without committing it", async () => {
		writeAuthJson({ anthropic: { type: "api_key", key: "stored" } });
		const backend = new FileAuthStorageBackend(authJsonPath);
		const controller = new AbortController();
		let markStarted: (() => void) | undefined;
		let finish: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const blocked = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const pending = backend.withLockAsync(
			async () => {
				markStarted?.();
				await blocked;
				return { result: undefined, next: JSON.stringify({ openai: { type: "api_key", key: "cancelled" } }) };
			},
			{ signal: controller.signal },
		);

		await started;
		controller.abort();
		const competingMutation = vi.fn(async () => ({
			result: undefined,
			next: JSON.stringify({ google: { type: "api_key", key: "committed" } }),
		}));
		const competing = backend.withLockAsync(competingMutation);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(competingMutation).not.toHaveBeenCalled();

		finish?.();
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		await competing;
		expect(competingMutation).toHaveBeenCalledTimes(1);
		expect(JSON.parse(readFileSync(authJsonPath, "utf8"))).toEqual({
			google: { type: "api_key", key: "committed" },
		});
	});

	test("cancels a signalled credential read waiting for a held file lock", async () => {
		writeAuthJson({ anthropic: { type: "api_key", key: "old" } });
		const storage = AuthStorage.create(authJsonPath);
		writeAuthJson({ anthropic: { type: "api_key", key: "new-value" } });
		const release = await lockfile.lock(authJsonPath, { realpath: false });
		const lockSpy = vi.spyOn(lockfile, "lock");
		const controller = new AbortController();
		const pending = storage.read("anthropic", { signal: controller.signal });

		await new Promise((resolve) => setTimeout(resolve, 10));
		controller.abort();
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		await release();
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(lockSpy).toHaveBeenCalledTimes(1);
		await expect(storage.read("anthropic")).resolves.toEqual({ type: "api_key", key: "new-value" });
	});

	test("serializes in-memory mutations across providers", async () => {
		const storage = AuthStorage.inMemory();
		let markStarted: (() => void) | undefined;
		let finish: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const blocked = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const first = storage.modify("anthropic", async () => {
			markStarted?.();
			await blocked;
			return { type: "api_key", key: "anthropic-key" };
		});
		await started;
		const secondMutation = vi.fn(async () => ({ type: "api_key" as const, key: "openai-key" }));
		const second = storage.modify("openai", secondMutation);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(secondMutation).not.toHaveBeenCalled();

		finish?.();
		await Promise.all([first, second]);
		expect(await storage.read("anthropic")).toEqual({ type: "api_key", key: "anthropic-key" });
		expect(await storage.read("openai")).toEqual({ type: "api_key", key: "openai-key" });
	});

	test("cancels a queued in-memory mutation without running it later", async () => {
		const storage = AuthStorage.inMemory();
		let markStarted: (() => void) | undefined;
		let finish: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const blocked = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const first = storage.modify("anthropic", async () => {
			markStarted?.();
			await blocked;
			return { type: "api_key", key: "anthropic-key" };
		});
		await started;
		const controller = new AbortController();
		const secondMutation = vi.fn(async () => ({ type: "api_key" as const, key: "openai-key" }));
		const second = storage.modify("openai", secondMutation, { signal: controller.signal });

		controller.abort();
		await expect(second).rejects.toMatchObject({ name: "AbortError" });
		expect(secondMutation).not.toHaveBeenCalled();
		finish?.();
		await first;
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(secondMutation).not.toHaveBeenCalled();
		expect(await storage.read("openai")).toBeUndefined();
	});

	test("preserves the stored credential after cancelling an active refresh mutation", async () => {
		const previous = {
			type: "oauth" as const,
			access: "expired",
			refresh: "refresh-token",
			expires: 0,
		};
		const storage = AuthStorage.inMemory({ oauth: previous });
		const controller = new AbortController();
		let markStarted: (() => void) | undefined;
		let finish: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const blocked = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const pending = storage.modify(
			"oauth",
			async () => {
				markStarted?.();
				await blocked;
				return { ...previous, access: "refreshed", expires: Date.now() + 60_000 };
			},
			{ signal: controller.signal },
		);

		await started;
		controller.abort();
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		const competingMutation = vi.fn(async () => ({ type: "api_key" as const, key: "other" }));
		const competing = storage.modify("other", competingMutation);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(competingMutation).not.toHaveBeenCalled();

		finish?.();
		await competing;
		expect(competingMutation).toHaveBeenCalledTimes(1);
		expect(await storage.read("oauth")).toEqual(previous);
	});

	test("translates a credential-store refresh failure and allows a later retry", async () => {
		const providerId = "oauth-provider";
		const base = AuthStorage.inMemory({
			[providerId]: {
				type: "oauth",
				access: "expired-access",
				refresh: "refresh-token",
				expires: 0,
			},
		});
		let failNextModify = true;
		const credentials: CredentialStore = {
			read: (id) => base.read(id),
			list: () => base.list(),
			modify: (id, fn) => {
				if (failNextModify) {
					failNextModify = false;
					return Promise.reject(new Error("credential store unavailable"));
				}
				return base.modify(id, fn);
			},
			delete: (id) => base.delete(id),
		};
		const provider: Provider = {
			id: providerId,
			name: "OAuth Provider",
			auth: {
				oauth: {
					name: "OAuth",
					login: async () => {
						throw new Error("not used");
					},
					refresh: async (credential) => ({
						...credential,
						access: "refreshed-access",
						expires: Date.now() + 60_000,
					}),
					toAuth: async (credential) => ({ apiKey: credential.access }),
				},
			},
			getModels: () => [],
			stream: () => {
				throw new Error("not used");
			},
			streamSimple: () => {
				throw new Error("not used");
			},
		};
		const models = createModels({ credentials });
		models.setProvider(provider);

		await expect(models.getAuth(providerId)).rejects.toMatchObject({ code: "auth" });
		await expect(models.getAuth(providerId)).resolves.toMatchObject({ auth: { apiKey: "refreshed-access" } });
	});

	test("does not overwrite malformed auth files", async () => {
		writeAuthJson({ anthropic: { type: "api_key", key: "stored" } });
		const storage = AuthStorage.create(authJsonPath);
		writeFileSync(authJsonPath, "{invalid-json", "utf8");
		await expect(storage.modify("openai", async () => ({ type: "api_key", key: "new" }))).rejects.toThrow();
		expect(readFileSync(authJsonPath, "utf8")).toBe("{invalid-json");
	});

	describe("API key resolution", () => {
		test("literal API key is returned directly", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "sk-ant-literal-key" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBe("sk-ant-literal-key");
		});

		test("apiKey with ! prefix executes command and uses stdout", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "!echo test-api-key-from-command" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBe("test-api-key-from-command");
		});

		test("apiKey with ! prefix trims whitespace from command output", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "!echo '  spaced-key  '" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBe("spaced-key");
		});

		test("apiKey with ! prefix handles multiline output (uses trimmed result)", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "!printf 'line1\\nline2'" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBe("line1\nline2");
		});

		test("apiKey with ! prefix returns undefined on command failure", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "!exit 1" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBeUndefined();
		});

		test("apiKey with ! prefix returns undefined on nonexistent command", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "!nonexistent-command-12345" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBeUndefined();
		});

		test("apiKey with ! prefix returns undefined on empty output", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "!printf ''" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBeUndefined();
		});

		test("apiKey as an environment variable reference resolves to env value", async () => {
			const originalEnv = process.env.TEST_AUTH_API_KEY_12345;
			process.env.TEST_AUTH_API_KEY_12345 = "env-api-key-value";

			try {
				writeAuthJson({
					anthropic: { type: "api_key", key: "$TEST_AUTH_API_KEY_12345" },
				});

				authStorage = AuthStorage.create(authJsonPath);
				const apiKey = await authStorage.getApiKey("anthropic");

				expect(apiKey).toBe("env-api-key-value");
			} finally {
				if (originalEnv === undefined) {
					delete process.env.TEST_AUTH_API_KEY_12345;
				} else {
					process.env.TEST_AUTH_API_KEY_12345 = originalEnv;
				}
			}
		});

		test("ambient environment credentials count as available auth", async () => {
			const originalAwsProfile = process.env.AWS_PROFILE;
			process.env.AWS_PROFILE = "pi-test-profile";

			try {
				authStorage = AuthStorage.inMemory();

				expect(authStorage.hasAuth("amazon-bedrock")).toBe(true);
				expect(authStorage.getApiKey("amazon-bedrock")).toBe("<authenticated>");
				expect(authStorage.getAuthStatus("amazon-bedrock")).toEqual({
					configured: false,
					source: "environment",
					label: "ambient credentials",
				});
			} finally {
				if (originalAwsProfile === undefined) {
					delete process.env.AWS_PROFILE;
				} else {
					process.env.AWS_PROFILE = originalAwsProfile;
				}
			}
		});

		test("changed ambient environment credential no longer matches stale auth marker", async () => {
			const originalAwsProfile = process.env.AWS_PROFILE;
			process.env.AWS_PROFILE = "stale-profile";

			try {
				authStorage = AuthStorage.inMemory();
				expect(authStorage.markAuthStale("amazon-bedrock")).toBe(true);
				expect(authStorage.hasAuth("amazon-bedrock")).toBe(false);
				expect(authStorage.getApiKey("amazon-bedrock")).toBeUndefined();

				process.env.AWS_PROFILE = "fresh-profile";

				expect(authStorage.hasAuth("amazon-bedrock")).toBe(true);
				expect(authStorage.getApiKey("amazon-bedrock")).toBe("<authenticated>");
			} finally {
				if (originalAwsProfile === undefined) {
					delete process.env.AWS_PROFILE;
				} else {
					process.env.AWS_PROFILE = originalAwsProfile;
				}
			}
		});

		test("apiKey as literal value is used directly when not an env var", async () => {
			delete process.env.literal_api_key_value;

			writeAuthJson({
				anthropic: { type: "api_key", key: "literal_api_key_value" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBe("literal_api_key_value");
		});

		test("prime inference falls back to Prime CLI config when enabled", async () => {
			const primeConfigPath = join(tempDir, "prime-config.json");
			writeFileSync(primeConfigPath, JSON.stringify({ api_key: "prime-cli-key" }));
			writeAuthJson({});

			authStorage = AuthStorage.create(authJsonPath, {
				primeCliConfigPath: primeConfigPath,
				usePrimeCliConfig: true,
			});

			expect(authStorage.getApiKey("prime-inference")).toBe("prime-cli-key");
			expect(authStorage.hasAuth("prime-inference")).toBe(true);
			expect(authStorage.getAuthStatus("prime-inference")).toEqual({
				configured: false,
				source: "prime_cli",
				label: "Prime CLI",
			});
		});

		test("prime cli config changes are picked up without reload", async () => {
			const primeConfigPath = join(tempDir, "prime-config.json");
			writeFileSync(primeConfigPath, JSON.stringify({ api_key: "prime-cli-key" }));
			writeAuthJson({});

			authStorage = AuthStorage.create(authJsonPath, {
				primeCliConfigPath: primeConfigPath,
				usePrimeCliConfig: true,
			});

			expect(authStorage.getApiKey("prime-inference")).toBe("prime-cli-key");
			writeFileSync(primeConfigPath, JSON.stringify({ api_key: "changed-prime-key" }));
			expect(authStorage.getApiKey("prime-inference")).toBe("changed-prime-key");
		});

		test("prime inference marks current Prime CLI auth stale", async () => {
			const primeConfigPath = join(tempDir, "prime-config.json");
			writeFileSync(primeConfigPath, JSON.stringify({ api_key: "prime-cli-key" }));
			writeAuthJson({});

			authStorage = AuthStorage.create(authJsonPath, {
				primeCliConfigPath: primeConfigPath,
				usePrimeCliConfig: true,
			});

			expect(authStorage.markAuthStale("prime-inference")).toBe(true);

			expect(authStorage.hasAuth("prime-inference")).toBe(false);
			expect(authStorage.getApiKey("prime-inference")).toBeUndefined();
			expect(authStorage.getAuthStatus("prime-inference")).toEqual({
				configured: false,
				source: "stale",
				label: "expired",
			});
		});

		test("changed Prime CLI key no longer matches stale auth marker", async () => {
			const primeConfigPath = join(tempDir, "prime-config.json");
			writeFileSync(primeConfigPath, JSON.stringify({ api_key: "prime-cli-key" }));
			writeAuthJson({});

			authStorage = AuthStorage.create(authJsonPath, {
				primeCliConfigPath: primeConfigPath,
				usePrimeCliConfig: true,
			});
			authStorage.markAuthStale("prime-inference");

			writeFileSync(primeConfigPath, JSON.stringify({ api_key: "changed-prime-key" }));

			expect(authStorage.hasAuth("prime-inference")).toBe(true);
			expect(authStorage.getApiKey("prime-inference")).toBe("changed-prime-key");
			expect(authStorage.getAuthStatus("prime-inference")).toEqual({
				configured: false,
				source: "prime_cli",
				label: "Prime CLI",
			});
		});

		test("setPrimeInferenceApiKey clears stale Prime CLI auth marker", async () => {
			const primeConfigPath = join(tempDir, "prime-config.json");
			writeFileSync(primeConfigPath, JSON.stringify({ api_key: "prime-cli-key" }));
			writeAuthJson({});

			authStorage = AuthStorage.create(authJsonPath, {
				primeCliConfigPath: primeConfigPath,
				usePrimeCliConfig: true,
			});
			authStorage.markAuthStale("prime-inference");

			authStorage.setPrimeInferenceApiKey("new-prime-key");

			expect(authStorage.hasAuth("prime-inference")).toBe(true);
			expect(authStorage.getApiKey("prime-inference")).toBe("new-prime-key");
			expect(authStorage.getAuthStatus("prime-inference")).toEqual({
				configured: false,
				source: "prime_cli",
				label: "Prime CLI",
			});
		});

		test("stored credential updates do not revive stale runtime auth", async () => {
			authStorage = AuthStorage.inMemory();
			authStorage.setRuntimeApiKey("anthropic", "runtime-key");
			expect(authStorage.markAuthStale("anthropic")).toBe(true);

			authStorage.set("anthropic", { type: "api_key", key: "stored-key" });

			expect(authStorage.getAuthStatus("anthropic")).toEqual({ configured: true, source: "stored" });
			expect(authStorage.getApiKey("anthropic")).toBe("stored-key");

			authStorage.remove("anthropic");

			expect(authStorage.getAuthStatus("anthropic")).toEqual({
				configured: false,
				source: "stale",
				label: "expired",
			});
			expect(authStorage.getApiKey("anthropic")).toBeUndefined();
		});

		test("changed command-backed stored key no longer matches stale auth marker", async () => {
			const tokenFile = join(tempDir, "command-token");
			writeFileSync(tokenFile, "stale-key");
			const tokenPath = toShPath(tokenFile);
			writeAuthJson({
				anthropic: { type: "api_key", key: `!sh -c 'cat "${tokenPath}"'` },
			});

			authStorage = AuthStorage.create(authJsonPath);
			expect(authStorage.getApiKey("anthropic")).toBe("stale-key");
			expect(authStorage.markAuthStale("anthropic")).toBe(true);
			expect(authStorage.hasAuth("anthropic")).toBe(false);
			expect(authStorage.getApiKey("anthropic")).toBeUndefined();

			writeFileSync(tokenFile, "fresh-key");

			expect(authStorage.hasAuth("anthropic")).toBe(true);
			expect(authStorage.getApiKey("anthropic")).toBe("fresh-key");
			expect(authStorage.getAuthStatus("anthropic")).toEqual({ configured: true, source: "stored" });
		});

		test("prime inference uses Prime CLI auth over stored auth", async () => {
			const primeConfigPath = join(tempDir, "prime-config.json");
			writeFileSync(primeConfigPath, JSON.stringify({ api_key: "prime-cli-key" }));
			writeAuthJson({
				"prime-inference": {
					type: "api_key",
					key: "agent-key",
				},
			});

			authStorage = AuthStorage.create(authJsonPath, {
				primeCliConfigPath: primeConfigPath,
				usePrimeCliConfig: true,
			});

			expect(authStorage.getApiKey("prime-inference")).toBe("prime-cli-key");
			expect(authStorage.getAuthStatus("prime-inference")).toEqual({
				configured: false,
				source: "prime_cli",
				label: "Prime CLI",
			});
		});

		test("prime inference uses environment auth over Prime CLI and stored auth", async () => {
			const originalPrimeApiKey = process.env.PRIME_API_KEY;
			const originalPrimeTeamId = process.env.PRIME_TEAM_ID;
			process.env.PRIME_API_KEY = "env-prime-key";
			delete process.env.PRIME_TEAM_ID;
			try {
				const primeConfigPath = join(tempDir, "prime-config.json");
				writeFileSync(
					primeConfigPath,
					JSON.stringify({ api_key: "prime-cli-key", team_id: "cli-team", team_name: "CLI Research" }),
				);
				writeAuthJson({
					"prime-inference": {
						type: "api_key",
						key: "agent-key",
						primeTeam: { teamId: "stored-team", name: "Stored Research" },
					},
				});

				authStorage = AuthStorage.create(authJsonPath, {
					primeCliConfigPath: primeConfigPath,
					usePrimeCliConfig: true,
				});

				expect(authStorage.getApiKey("prime-inference")).toBe("env-prime-key");
				expect(authStorage.getAuthStatus("prime-inference")).toEqual({
					configured: false,
					source: "environment",
					label: "PRIME_API_KEY",
				});
				expect(authStorage.getProviderHeaders("prime-inference")).toBeUndefined();
				expect(authStorage.getPrimeInferenceTeamSelection()).toBeUndefined();
			} finally {
				if (originalPrimeApiKey === undefined) {
					delete process.env.PRIME_API_KEY;
				} else {
					process.env.PRIME_API_KEY = originalPrimeApiKey;
				}
				if (originalPrimeTeamId === undefined) {
					delete process.env.PRIME_TEAM_ID;
				} else {
					process.env.PRIME_TEAM_ID = originalPrimeTeamId;
				}
			}
		});

		test("prime inference provider headers use selected Prime CLI team", () => {
			const primeConfigPath = join(tempDir, "prime-config.json");
			writeFileSync(
				primeConfigPath,
				JSON.stringify({
					api_key: "prime-cli-key",
					team_id: "cli-team",
					team_name: "CLI Research",
					team_role: "admin",
				}),
			);
			writeAuthJson({
				"prime-inference": {
					type: "api_key",
					key: "agent-key",
					primeTeam: { teamId: "team-1", name: "Research", slug: "research", role: "admin" },
				},
			});

			authStorage = AuthStorage.create(authJsonPath, {
				primeCliConfigPath: primeConfigPath,
				usePrimeCliConfig: true,
			});

			expect(authStorage.getProviderHeaders("prime-inference")).toEqual({ "X-Prime-Team-ID": "cli-team" });
			expect(authStorage.getPrimeInferenceTeamSelection()).toEqual({
				teamId: "cli-team",
				name: "CLI Research",
				role: "admin",
			});
		});

		test("prime inference legacy personal selection suppresses Prime CLI team fallback without Prime CLI key", () => {
			const primeConfigPath = join(tempDir, "prime-config.json");
			writeFileSync(primeConfigPath, JSON.stringify({ team_id: "cli-team" }));
			writeAuthJson({
				"prime-inference": {
					type: "api_key",
					key: "agent-key",
					primeTeam: null,
				},
			});

			authStorage = AuthStorage.create(authJsonPath, {
				primeCliConfigPath: primeConfigPath,
				usePrimeCliConfig: true,
			});

			expect(authStorage.getProviderHeaders("prime-inference")).toBeUndefined();
			expect(authStorage.getPrimeInferenceTeamSelection()).toBeNull();
		});

		test("prime inference legacy personal selection suppresses Prime CLI team with Prime CLI key", () => {
			const primeConfigPath = join(tempDir, "prime-config.json");
			writeFileSync(primeConfigPath, JSON.stringify({ api_key: "prime-cli-key", team_id: "cli-team" }));
			writeAuthJson({
				"prime-inference": {
					type: "api_key",
					key: "agent-key",
					primeTeam: null,
				},
			});

			authStorage = AuthStorage.create(authJsonPath, {
				primeCliConfigPath: primeConfigPath,
				usePrimeCliConfig: true,
			});

			expect(authStorage.getProviderHeaders("prime-inference")).toBeUndefined();
			expect(authStorage.getPrimeInferenceTeamSelection()).toBeNull();
		});

		test("prime inference environment team overrides legacy personal selection", () => {
			const originalPrimeTeamId = process.env.PRIME_TEAM_ID;
			process.env.PRIME_TEAM_ID = "env-team";
			try {
				const primeConfigPath = join(tempDir, "prime-config.json");
				writeFileSync(primeConfigPath, JSON.stringify({ team_id: "cli-team" }));
				writeAuthJson({
					"prime-inference": {
						type: "api_key",
						key: "agent-key",
						primeTeam: null,
					},
				});

				authStorage = AuthStorage.create(authJsonPath, {
					primeCliConfigPath: primeConfigPath,
					usePrimeCliConfig: true,
				});

				expect(authStorage.getProviderHeaders("prime-inference")).toEqual({ "X-Prime-Team-ID": "env-team" });
				expect(authStorage.getPrimeInferenceTeamSelection()).toBeUndefined();
			} finally {
				if (originalPrimeTeamId === undefined) {
					delete process.env.PRIME_TEAM_ID;
				} else {
					process.env.PRIME_TEAM_ID = originalPrimeTeamId;
				}
			}
		});

		test("prime inference missing Agent team selection falls back to Prime CLI team", () => {
			const primeConfigPath = join(tempDir, "prime-config.json");
			writeFileSync(primeConfigPath, JSON.stringify({ api_key: "prime-cli-key", team_id: "cli-team" }));
			writeAuthJson({
				"prime-inference": {
					type: "api_key",
					key: "agent-key",
				},
			});

			authStorage = AuthStorage.create(authJsonPath, {
				primeCliConfigPath: primeConfigPath,
				usePrimeCliConfig: true,
			});

			expect(authStorage.getProviderHeaders("prime-inference")).toEqual({ "X-Prime-Team-ID": "cli-team" });
		});

		test("prime inference provider header changes are picked up without reload", () => {
			const primeConfigPath = join(tempDir, "prime-config.json");
			writeFileSync(primeConfigPath, JSON.stringify({ api_key: "prime-cli-key", team_id: "team-1" }));
			writeAuthJson({});

			authStorage = AuthStorage.create(authJsonPath, {
				primeCliConfigPath: primeConfigPath,
				usePrimeCliConfig: true,
			});

			expect(authStorage.getProviderHeaders("prime-inference")).toEqual({ "X-Prime-Team-ID": "team-1" });
			writeFileSync(primeConfigPath, JSON.stringify({ api_key: "prime-cli-key", team_id: "team-2" }));
			expect(authStorage.getProviderHeaders("prime-inference")).toEqual({ "X-Prime-Team-ID": "team-2" });
		});

		test("setPrimeInferenceApiKey creates Prime CLI config", async () => {
			const primeConfigPath = join(tempDir, "prime", "config.json");
			writeAuthJson({});

			authStorage = AuthStorage.create(authJsonPath, {
				primeCliConfigPath: primeConfigPath,
				usePrimeCliConfig: true,
			});

			authStorage.setPrimeInferenceApiKey("new-prime-key");

			const config = JSON.parse(readFileSync(primeConfigPath, "utf-8")) as Record<string, unknown>;
			expect(config.api_key).toBe("new-prime-key");
			expect(statSync(primeConfigPath).mode & 0o777).toBe(0o600);
			expect(authStorage.has("prime-inference")).toBe(false);
			expect(authStorage.getApiKey("prime-inference")).toBe("new-prime-key");
		});

		test("setPrimeInferenceApiKey clears stale Prime CLI team selection", () => {
			const primeConfigPath = join(tempDir, "prime-config.json");
			writeFileSync(
				primeConfigPath,
				JSON.stringify({
					api_key: "old-prime-key",
					team_id: "old-team",
					team_name: "Old Team",
					team_role: "admin",
				}),
			);
			writeAuthJson({});

			authStorage = AuthStorage.create(authJsonPath, {
				primeCliConfigPath: primeConfigPath,
				usePrimeCliConfig: true,
			});

			authStorage.setPrimeInferenceApiKey("new-prime-key");

			const config = JSON.parse(readFileSync(primeConfigPath, "utf-8")) as Record<string, unknown>;
			expect(config.api_key).toBe("new-prime-key");
			expect(config.team_id).toBeUndefined();
			expect(config.team_name).toBeUndefined();
			expect(config.team_role).toBeUndefined();
		});

		test("setPrimeInferenceApiKey preserves Prime CLI team selection for the same key", () => {
			const primeConfigPath = join(tempDir, "prime-config.json");
			writeFileSync(
				primeConfigPath,
				JSON.stringify({
					api_key: "prime-cli-key",
					team_id: "team-1",
					team_name: "Research",
					team_role: "admin",
				}),
			);
			writeAuthJson({
				"prime-inference": {
					type: "api_key",
					key: "agent-key",
				},
			});

			authStorage = AuthStorage.create(authJsonPath, {
				primeCliConfigPath: primeConfigPath,
				usePrimeCliConfig: true,
			});

			authStorage.setPrimeInferenceApiKey("prime-cli-key");

			const config = JSON.parse(readFileSync(primeConfigPath, "utf-8")) as Record<string, unknown>;
			expect(config.api_key).toBe("prime-cli-key");
			expect(config.team_id).toBe("team-1");
			expect(config.team_name).toBe("Research");
			expect(config.team_role).toBe("admin");
			expect(authStorage.has("prime-inference")).toBe(false);
		});

		test("setPrimeInferenceApiKey migrates legacy team selection for the same Prime CLI key", () => {
			const primeConfigPath = join(tempDir, "prime-config.json");
			writeFileSync(primeConfigPath, JSON.stringify({ api_key: "prime-cli-key" }));
			writeAuthJson({
				"prime-inference": {
					type: "api_key",
					key: "agent-key",
					primeTeam: { teamId: "team-1", name: "Research", slug: "research", role: "admin" },
				},
			});

			authStorage = AuthStorage.create(authJsonPath, {
				primeCliConfigPath: primeConfigPath,
				usePrimeCliConfig: true,
			});

			authStorage.setPrimeInferenceApiKey("prime-cli-key");

			const config = JSON.parse(readFileSync(primeConfigPath, "utf-8")) as Record<string, unknown>;
			expect(config.api_key).toBe("prime-cli-key");
			expect(config.team_id).toBe("team-1");
			expect(config.team_name).toBe("Research");
			expect(config.team_role).toBe("admin");
			expect(authStorage.has("prime-inference")).toBe(false);
			expect(authStorage.getProviderHeaders("prime-inference")).toEqual({ "X-Prime-Team-ID": "team-1" });
		});

		test("setPrimeInferenceApiKey migrates legacy personal selection for the same Prime CLI key", () => {
			const primeConfigPath = join(tempDir, "prime-config.json");
			writeFileSync(
				primeConfigPath,
				JSON.stringify({
					api_key: "prime-cli-key",
					team_id: "team-1",
					team_name: "Research",
				}),
			);
			writeAuthJson({
				"prime-inference": {
					type: "api_key",
					key: "agent-key",
					primeTeam: null,
				},
			});

			authStorage = AuthStorage.create(authJsonPath, {
				primeCliConfigPath: primeConfigPath,
				usePrimeCliConfig: true,
			});

			authStorage.setPrimeInferenceApiKey("prime-cli-key");

			const config = JSON.parse(readFileSync(primeConfigPath, "utf-8")) as Record<string, unknown>;
			expect(config.api_key).toBe("prime-cli-key");
			expect(config.team_id).toBeUndefined();
			expect(config.team_name).toBeUndefined();
			expect(authStorage.has("prime-inference")).toBe(false);
			expect(authStorage.getProviderHeaders("prime-inference")).toBeUndefined();
		});

		test("setPrimeInferenceApiKey removes legacy Prime Agent credential after Prime CLI save", () => {
			const primeConfigPath = join(tempDir, "prime-config.json");
			writeAuthJson({
				"prime-inference": {
					type: "api_key",
					key: "agent-key",
					primeTeam: { teamId: "team-1", name: "Research" },
				},
			});

			authStorage = AuthStorage.create(authJsonPath, {
				primeCliConfigPath: primeConfigPath,
				usePrimeCliConfig: true,
			});

			authStorage.setPrimeInferenceApiKey("new-prime-key");

			const agentAuth = JSON.parse(readFileSync(authJsonPath, "utf-8")) as Record<string, unknown>;
			expect(agentAuth["prime-inference"]).toBeUndefined();
			expect(authStorage.has("prime-inference")).toBe(false);
		});

		test("setPrimeInferenceApiKey throws when Prime CLI config cannot be written", () => {
			const primeConfigPath = join(tempDir, "prime-config-dir");
			mkdirSync(primeConfigPath);
			writeAuthJson({});

			authStorage = AuthStorage.create(authJsonPath, {
				primeCliConfigPath: primeConfigPath,
				usePrimeCliConfig: true,
			});

			expect(() => authStorage.setPrimeInferenceApiKey("new-prime-key")).toThrow();
		});

		test("setPrimeInferenceApiKey preserves team selection when Prime CLI config is disabled", () => {
			writeAuthJson({
				"prime-inference": {
					type: "api_key",
					key: "agent-key",
					primeTeam: { teamId: "team-1", name: "Research" },
				},
			});

			authStorage = AuthStorage.create(authJsonPath, { usePrimeCliConfig: false });

			authStorage.setPrimeInferenceApiKey("new-prime-key");

			expect(authStorage.get("prime-inference")).toEqual({
				type: "api_key",
				key: "new-prime-key",
				primeTeam: { teamId: "team-1", name: "Research" },
			});
		});

		test("logout clears Prime CLI credentials when enabled", async () => {
			const primeConfigPath = join(tempDir, "prime-config.json");
			writeFileSync(
				primeConfigPath,
				JSON.stringify({
					api_key: "prime-cli-key",
					team_id: "team-1",
					team_name: "Research",
				}),
			);
			writeAuthJson({
				"prime-inference": {
					type: "api_key",
					key: "agent-key",
					primeTeam: { teamId: "team-1", name: "Research" },
				},
			});

			authStorage = AuthStorage.create(authJsonPath, {
				primeCliConfigPath: primeConfigPath,
				usePrimeCliConfig: true,
			});

			authStorage.logout("prime-inference");

			const config = JSON.parse(readFileSync(primeConfigPath, "utf-8")) as Record<string, unknown>;
			expect(config.api_key).toBeUndefined();
			expect(config.team_id).toBeUndefined();
			expect(config.team_name).toBeUndefined();
			expect(authStorage.has("prime-inference")).toBe(false);
			expect(authStorage.getApiKey("prime-inference")).toBeUndefined();
		});

		test("setPrimeInferenceTeamSelection writes Prime CLI config", () => {
			const primeConfigPath = join(tempDir, "prime-config.json");
			writeFileSync(primeConfigPath, JSON.stringify({ api_key: "prime-cli-key" }));
			writeAuthJson({});

			authStorage = AuthStorage.create(authJsonPath, {
				primeCliConfigPath: primeConfigPath,
				usePrimeCliConfig: true,
			});

			authStorage.setPrimeInferenceTeamSelection({ teamId: "team-1", name: "Research", role: "admin" });

			const config = JSON.parse(readFileSync(primeConfigPath, "utf-8")) as Record<string, unknown>;
			expect(config.team_id).toBe("team-1");
			expect(config.team_name).toBe("Research");
			expect(config.team_role).toBe("admin");
			expect(authStorage.getProviderHeaders("prime-inference")).toEqual({ "X-Prime-Team-ID": "team-1" });
		});

		test("apiKey command can use shell features like pipes", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "!echo 'hello world' | tr ' ' '-'" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBe("hello-world");
		});

		describe("caching", () => {
			test("command is only executed once per process", async () => {
				const counterFile = join(tempDir, "counter");
				writeFileSync(counterFile, "0");

				const counterPath = toShPath(counterFile);
				const command = `!sh -c 'count=$(cat "${counterPath}"); echo $((count + 1)) > "${counterPath}"; echo "key-value"'`;
				writeAuthJson({
					anthropic: { type: "api_key", key: command },
				});

				authStorage = AuthStorage.create(authJsonPath);

				await authStorage.getApiKey("anthropic");
				await authStorage.getApiKey("anthropic");
				await authStorage.getApiKey("anthropic");

				const count = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
				expect(count).toBe(1);
			});

			test("cache persists across AuthStorage instances", async () => {
				const counterFile = join(tempDir, "counter");
				writeFileSync(counterFile, "0");

				const counterPath = toShPath(counterFile);
				const command = `!sh -c 'count=$(cat "${counterPath}"); echo $((count + 1)) > "${counterPath}"; echo "key-value"'`;
				writeAuthJson({
					anthropic: { type: "api_key", key: command },
				});

				const storage1 = AuthStorage.create(authJsonPath);
				await storage1.getApiKey("anthropic");

				const storage2 = AuthStorage.create(authJsonPath);
				await storage2.getApiKey("anthropic");

				const count = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
				expect(count).toBe(1);
			});

			test("clearConfigValueCache allows command to run again", async () => {
				const counterFile = join(tempDir, "counter");
				writeFileSync(counterFile, "0");

				const counterPath = toShPath(counterFile);
				const command = `!sh -c 'count=$(cat "${counterPath}"); echo $((count + 1)) > "${counterPath}"; echo "key-value"'`;
				writeAuthJson({
					anthropic: { type: "api_key", key: command },
				});

				authStorage = AuthStorage.create(authJsonPath);
				await authStorage.getApiKey("anthropic");

				clearConfigValueCache();
				await authStorage.getApiKey("anthropic");

				const count = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
				expect(count).toBe(2);
			});

			test("different commands are cached separately", async () => {
				writeAuthJson({
					anthropic: { type: "api_key", key: "!echo key-anthropic" },
					openai: { type: "api_key", key: "!echo key-openai" },
				});

				authStorage = AuthStorage.create(authJsonPath);

				const keyA = await authStorage.getApiKey("anthropic");
				const keyB = await authStorage.getApiKey("openai");

				expect(keyA).toBe("key-anthropic");
				expect(keyB).toBe("key-openai");
			});

			test("failed commands are cached (not retried)", async () => {
				const counterFile = join(tempDir, "counter");
				writeFileSync(counterFile, "0");

				const counterPath = toShPath(counterFile);
				const command = `!sh -c 'count=$(cat "${counterPath}"); echo $((count + 1)) > "${counterPath}"; exit 1'`;
				writeAuthJson({
					anthropic: { type: "api_key", key: command },
				});

				authStorage = AuthStorage.create(authJsonPath);

				const key1 = await authStorage.getApiKey("anthropic");
				const key2 = await authStorage.getApiKey("anthropic");

				expect(key1).toBeUndefined();
				expect(key2).toBeUndefined();

				const count = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
				expect(count).toBe(1);
			});

			test("environment variables are not cached (changes are picked up)", async () => {
				const envVarName = "TEST_AUTH_KEY_CACHE_TEST_98765";
				const originalEnv = process.env[envVarName];

				try {
					process.env[envVarName] = "first-value";

					writeAuthJson({
						anthropic: { type: "api_key", key: `$${envVarName}` },
					});

					authStorage = AuthStorage.create(authJsonPath);

					const key1 = await authStorage.getApiKey("anthropic");
					expect(key1).toBe("first-value");

					process.env[envVarName] = "second-value";

					const key2 = await authStorage.getApiKey("anthropic");
					expect(key2).toBe("second-value");
				} finally {
					if (originalEnv === undefined) {
						delete process.env[envVarName];
					} else {
						process.env[envVarName] = originalEnv;
					}
				}
			});
		});
	});

	describe("lock compromise handling", () => {
		test("a compromised lock aborts the write and a later retry succeeds", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "anthropic-key" },
			});

			authStorage = AuthStorage.create(authJsonPath);

			const realLock = lockfile.lock.bind(lockfile);
			const lockSpy = vi.spyOn(lockfile, "lock");
			lockSpy.mockImplementationOnce(async (file, options) => {
				options?.onCompromised?.(new Error("Unable to update lock within the stale threshold"));
				return realLock(file, options);
			});

			await expect(
				authStorage.modify("openai", async () => ({ type: "api_key", key: "openai-key" })),
			).rejects.toThrow("Unable to update lock within the stale threshold");
			expect(JSON.parse(readFileSync(authJsonPath, "utf-8"))).toEqual({
				anthropic: { type: "api_key", key: "anthropic-key" },
			});

			lockSpy.mockRestore();

			await authStorage.modify("openai", async () => ({ type: "api_key", key: "openai-key" }));
			expect(authStorage.get("openai")).toEqual({ type: "api_key", key: "openai-key" });
		});
	});

	describe("persistence semantics", () => {
		test("set preserves unrelated external edits", () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "old-anthropic" },
				openai: { type: "api_key", key: "openai-key" },
			});

			authStorage = AuthStorage.create(authJsonPath);

			writeAuthJson({
				anthropic: { type: "api_key", key: "old-anthropic" },
				openai: { type: "api_key", key: "openai-key" },
				google: { type: "api_key", key: "google-key" },
			});

			authStorage.set("anthropic", { type: "api_key", key: "new-anthropic" });

			const updated = JSON.parse(readFileSync(authJsonPath, "utf-8")) as Record<string, { key: string }>;
			expect(updated.anthropic.key).toBe("new-anthropic");
			expect(updated.openai.key).toBe("openai-key");
			expect(updated.google.key).toBe("google-key");
		});

		test("remove preserves unrelated external edits", () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "anthropic-key" },
				openai: { type: "api_key", key: "openai-key" },
			});

			authStorage = AuthStorage.create(authJsonPath);

			writeAuthJson({
				anthropic: { type: "api_key", key: "anthropic-key" },
				openai: { type: "api_key", key: "openai-key" },
				google: { type: "api_key", key: "google-key" },
			});

			authStorage.remove("anthropic");

			const updated = JSON.parse(readFileSync(authJsonPath, "utf-8")) as Record<string, { key: string }>;
			expect(updated.anthropic).toBeUndefined();
			expect(updated.openai.key).toBe("openai-key");
			expect(updated.google.key).toBe("google-key");
		});

		test("does not overwrite a malformed auth file on a later write", () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "anthropic-key" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			writeFileSync(authJsonPath, "{invalid-json", "utf-8");

			authStorage.reload();
			expect(() => authStorage.set("openai", { type: "api_key", key: "openai-key" })).toThrow();

			const raw = readFileSync(authJsonPath, "utf-8");
			expect(raw).toBe("{invalid-json");
		});

		test("removeVerified deletes from disk and memory", () => {
			writeAuthJson({
				"mcp:remote": { type: "api_key", key: "token" },
				openai: { type: "api_key", key: "openai-key" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			authStorage.removeVerified("mcp:remote");

			const updated = JSON.parse(readFileSync(authJsonPath, "utf-8")) as Record<string, unknown>;
			expect(updated["mcp:remote"]).toBeUndefined();
			expect(authStorage.get("mcp:remote")).toBeUndefined();
			expect((updated.openai as { key: string }).key).toBe("openai-key");
		});

		test("removeVerified throws while the credential may still exist on disk", () => {
			writeAuthJson({
				"mcp:remote": { type: "api_key", key: "token" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			writeFileSync(authJsonPath, "{invalid-json", "utf-8");

			expect(() => authStorage.removeVerified("mcp:remote")).toThrow();
		});

		test("reload keeps the last valid snapshot when the file becomes malformed", () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "anthropic-key" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			writeFileSync(authJsonPath, "{invalid-json", "utf-8");

			authStorage.reload();

			expect(authStorage.get("anthropic")).toEqual({ type: "api_key", key: "anthropic-key" });
		});
	});

	describe("auth status", () => {
		test("does not expose stored API keys or OAuth tokens", () => {
			authStorage = AuthStorage.inMemory({
				anthropic: { type: "api_key", key: "secret-api-key" },
				openai: {
					type: "oauth",
					access: "secret-access-token",
					refresh: "secret-refresh-token",
					expires: Date.now() + 1000,
				},
			});

			expect(authStorage.getAuthStatus("anthropic")).toEqual({ configured: true, source: "stored" });
			expect(authStorage.getAuthStatus("openai")).toEqual({ configured: true, source: "stored" });
			expect(JSON.stringify(authStorage.getAuthStatus("anthropic"))).not.toContain("secret-api-key");
			expect(JSON.stringify(authStorage.getAuthStatus("openai"))).not.toContain("secret-access-token");
			expect(JSON.stringify(authStorage.getAuthStatus("openai"))).not.toContain("secret-refresh-token");
		});
	});

	describe("runtime overrides", () => {
		test("runtime override takes priority over auth.json", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "!echo stored-key" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			authStorage.setRuntimeApiKey("anthropic", "runtime-key");

			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBe("runtime-key");
		});

		test("removing runtime override falls back to auth.json", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "!echo stored-key" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			authStorage.setRuntimeApiKey("anthropic", "runtime-key");
			authStorage.removeRuntimeApiKey("anthropic");

			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBe("stored-key");
		});
	});
});
