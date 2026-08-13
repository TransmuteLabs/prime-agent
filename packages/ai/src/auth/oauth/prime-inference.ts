/**
 * Prime Inference login flow
 *
 * Browser challenge against https://api.primeintellect.ai: the CLI generates an
 * RSA keypair, POSTs the public key to /api/v1/auth_challenge/generate, the
 * user approves the challenge in the browser, and the API returns the API key
 * encrypted to the public key (RSA-OAEP SHA-256) via
 * /api/v1/auth_challenge/status polling.
 *
 * The resulting credential wraps a long-lived Prime API key; `refresh` is a
 * no-op because the key does not expire. An existing Prime CLI key from
 * ~/.prime/config.json is reused when it has inference access. After login the
 * user picks a team, persisted as team_id in ~/.prime/config.json where
 * getPrimeTeamId() reads it for the X-Prime-Team-ID request header.
 */

import { Buffer } from "node:buffer";
import { constants, generateKeyPairSync, privateDecrypt } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { OAuthAuth, OAuthCredential, ProviderAuthInteraction } from "../types.ts";

const DEFAULT_PRIME_API_BASE_URL = "https://api.primeintellect.ai";
const DEFAULT_PRIME_FRONTEND_URL = "https://app.primeintellect.ai";
const REQUEST_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 5_000;
// Prime API keys are long-lived; a far-future expiry keeps Models from
// attempting a refresh round-trip.
const API_KEY_EXPIRES_MS = 10 * 365 * 24 * 60 * 60 * 1000;

type PrimeCliConfig = {
	apiKey?: string;
	baseUrl: string;
	frontendUrl: string;
	teamId?: string;
};

type PrimeChallengeResponse = {
	challenge: string;
	statusAuthToken: string;
};

type PrimeTeam = {
	teamId: string;
	name: string;
	role?: string;
};

function primeCliConfigPath(): string {
	return join(homedir(), ".prime", "config.json");
}

function normalizeBaseUrl(value: string | undefined): string {
	return (value?.trim() || DEFAULT_PRIME_API_BASE_URL).replace(/\/+$/, "").replace(/\/api\/v1$/, "");
}

function normalizeUrl(value: string | undefined, fallback: string): string {
	return (value || fallback).trim().replace(/\/+$/, "");
}

function stringField(data: Record<string, unknown>, key: string): string | undefined {
	const value = data[key];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberField(data: Record<string, unknown>, key: string): number | undefined {
	const value = data[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readPrimeCliConfigData(): Record<string, unknown> {
	const configPath = primeCliConfigPath();
	if (!existsSync(configPath)) return {};
	try {
		const parsed = JSON.parse(readFileSync(configPath, "utf-8")) as unknown;
		return isRecord(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

function loadPrimeCliConfig(): PrimeCliConfig {
	const data = readPrimeCliConfigData();
	const config: PrimeCliConfig = {
		baseUrl: normalizeBaseUrl(stringField(data, "base_url")),
		frontendUrl: normalizeUrl(stringField(data, "frontend_url"), DEFAULT_PRIME_FRONTEND_URL),
	};
	const apiKey = stringField(data, "api_key");
	if (apiKey) config.apiKey = apiKey;
	const teamId = stringField(data, "team_id");
	if (teamId) config.teamId = teamId;
	return config;
}

/** Persist the team selection so getPrimeTeamId() can resolve it later. */
function savePrimeCliTeamSelection(team: PrimeTeam | null): void {
	const data = readPrimeCliConfigData();
	if (team) {
		data.team_id = team.teamId;
		data.team_name = team.name;
		if (team.role) {
			data.team_role = team.role;
		} else {
			delete data.team_role;
		}
	} else {
		delete data.team_id;
		delete data.team_name;
		delete data.team_role;
	}
	const configPath = primeCliConfigPath();
	const dir = join(homedir(), ".prime");
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
	}
	const tempPath = `${configPath}.${process.pid}.tmp`;
	try {
		writeFileSync(tempPath, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
		renameSync(tempPath, configPath);
		chmodSync(configPath, 0o600);
	} finally {
		if (existsSync(tempPath)) {
			rmSync(tempPath, { force: true });
		}
	}
}

function requestSignal(signal: AbortSignal): AbortSignal {
	return AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), signal]);
}

async function readResponseMessage(response: Response): Promise<string> {
	const text = await response.text().catch(() => "");
	if (!text.trim()) {
		return response.statusText || "Unknown error";
	}

	try {
		const parsed = JSON.parse(text) as unknown;
		if (isRecord(parsed)) {
			const error = parsed.error;
			if (isRecord(error)) {
				const message = stringField(error, "message");
				if (message) return message;
			}
			const detail = stringField(parsed, "detail");
			if (detail) return detail;
			const message = stringField(parsed, "message");
			if (message) return message;
		}
	} catch {
		// Fall back to raw text.
	}

	return text.trim();
}

async function readJsonObject(response: Response, context: string): Promise<Record<string, unknown>> {
	let parsed: unknown;
	try {
		parsed = (await response.json()) as unknown;
	} catch {
		throw new Error(`${context} returned an invalid response`);
	}
	if (!isRecord(parsed)) {
		throw new Error(`${context} returned an invalid response`);
	}
	return parsed;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		signal.throwIfAborted();
		const onAbort = () => {
			clearTimeout(timeout);
			reject(signal.reason);
		};
		const timeout = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

async function checkPrimeInferenceAccess(apiKey: string, baseUrl: string, signal: AbortSignal): Promise<void> {
	const response = await fetch(`${normalizeBaseUrl(baseUrl)}/api/v1/user/whoami`, {
		method: "GET",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			Accept: "application/json",
		},
		signal: requestSignal(signal),
	});

	if (!response.ok) {
		throw new Error(`Prime whoami failed: ${await readResponseMessage(response)}`);
	}

	const data = await readJsonObject(response, "Prime whoami");
	const user = data.data;
	if (!isRecord(user)) {
		throw new Error("Prime whoami response missing user data");
	}

	const scope = user.scope;
	if (!isRecord(scope) || !isRecord(scope.inference)) {
		throw new Error("Prime token is missing inference permissions");
	}

	if (scope.inference.write !== true) {
		throw new Error("Prime token does not have inference write permission");
	}
}

function parsePrimeTeam(value: unknown): PrimeTeam | undefined {
	if (!isRecord(value)) return undefined;
	const teamId = stringField(value, "teamId");
	if (!teamId) return undefined;
	const team: PrimeTeam = {
		teamId,
		name: stringField(value, "name") ?? "Unknown",
	};
	const role = stringField(value, "role");
	if (role) team.role = role;
	return team;
}

async function fetchPrimeTeams(apiKey: string, baseUrl: string, signal: AbortSignal): Promise<PrimeTeam[]> {
	const teams: PrimeTeam[] = [];
	let offset = 0;
	const limit = 100;

	while (true) {
		const url = new URL(`${normalizeBaseUrl(baseUrl)}/api/v1/user/teams`);
		url.searchParams.set("offset", String(offset));
		url.searchParams.set("limit", String(limit));
		const response = await fetch(url, {
			method: "GET",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				Accept: "application/json",
			},
			signal: requestSignal(signal),
		});

		if (!response.ok) {
			throw new Error(`Failed to fetch Prime teams: ${await readResponseMessage(response)}`);
		}

		const data = await readJsonObject(response, "Prime teams");
		const batch = data.data;
		if (!Array.isArray(batch)) {
			throw new Error("Prime teams response missing team data");
		}

		for (const item of batch) {
			const team = parsePrimeTeam(item);
			if (team) teams.push(team);
		}

		const totalCount = numberField(data, "total_count") ?? teams.length;
		if (batch.length === 0 || teams.length >= totalCount) break;
		offset += limit;
	}

	return teams;
}

function createPrimeChallengeKeypair(): { privateKey: string; publicKey: string } {
	const { privateKey, publicKey } = generateKeyPairSync("rsa", {
		modulusLength: 2048,
		publicExponent: 0x10001,
		publicKeyEncoding: {
			type: "spki",
			format: "pem",
		},
		privateKeyEncoding: {
			type: "pkcs8",
			format: "pem",
		},
	});
	return { privateKey, publicKey };
}

function decryptPrimeChallengeResult(privateKey: string, encryptedResult: string): string {
	const decrypted = privateDecrypt(
		{
			key: privateKey,
			padding: constants.RSA_PKCS1_OAEP_PADDING,
			oaepHash: "sha256",
		},
		Buffer.from(encryptedResult, "base64"),
	);
	return decrypted.toString("utf-8");
}

async function generatePrimeChallenge(
	config: PrimeCliConfig,
	publicKey: string,
	signal: AbortSignal,
): Promise<PrimeChallengeResponse> {
	const response = await fetch(`${config.baseUrl}/api/v1/auth_challenge/generate`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ encryptionPublicKey: publicKey }),
		signal: requestSignal(signal),
	});

	if (!response.ok) {
		throw new Error(`Failed to generate Prime login challenge: ${await readResponseMessage(response)}`);
	}

	const data = await readJsonObject(response, "Prime login challenge");
	const challenge = stringField(data, "challenge");
	const statusAuthToken = stringField(data, "status_auth_token");
	if (!challenge || !statusAuthToken) {
		throw new Error("Prime login challenge response missing required fields");
	}

	return { challenge, statusAuthToken };
}

async function pollPrimeChallengeResult(
	config: PrimeCliConfig,
	challenge: PrimeChallengeResponse,
	privateKey: string,
	signal: AbortSignal,
): Promise<string> {
	while (true) {
		signal.throwIfAborted();

		const statusUrl = new URL(`${config.baseUrl}/api/v1/auth_challenge/status`);
		statusUrl.searchParams.set("challenge", challenge.challenge);
		const response = await fetch(statusUrl, {
			method: "GET",
			headers: { Authorization: `Bearer ${challenge.statusAuthToken}` },
			signal: requestSignal(signal),
		});

		if (response.status === 404) {
			throw new Error("Prime login challenge expired");
		}
		if (!response.ok) {
			throw new Error(`Failed to check Prime login status: ${await readResponseMessage(response)}`);
		}

		const data = await readJsonObject(response, "Prime login status");
		const encryptedResult = stringField(data, "result");
		if (encryptedResult) {
			return decryptPrimeChallengeResult(privateKey, encryptedResult);
		}

		await sleep(POLL_INTERVAL_MS, signal);
	}
}

async function runPrimeBrowserLogin(config: PrimeCliConfig, interaction: ProviderAuthInteraction): Promise<string> {
	const { privateKey, publicKey } = createPrimeChallengeKeypair();
	const challenge = await generatePrimeChallenge(config, publicKey, interaction.signal);
	const url = new URL(`${config.frontendUrl}/dashboard/tokens/challenge`);
	url.searchParams.set("code", challenge.challenge);
	interaction.notify({ type: "auth_url", url: url.toString(), instructions: `Code: ${challenge.challenge}` });
	return pollPrimeChallengeResult(config, challenge, privateKey, interaction.signal);
}

async function selectPrimeTeam(
	apiKey: string,
	config: PrimeCliConfig,
	interaction: ProviderAuthInteraction,
): Promise<void> {
	// PRIME_TEAM_ID env always wins over the stored selection.
	if (typeof process !== "undefined" && process.env.PRIME_TEAM_ID?.trim()) return;

	let teams: PrimeTeam[];
	try {
		interaction.notify({ type: "progress", message: "Loading Prime teams..." });
		teams = await fetchPrimeTeams(apiKey, config.baseUrl, interaction.signal);
	} catch {
		// Team selection is optional; the header is simply omitted without it.
		return;
	}
	if (teams.length === 0) {
		if (config.teamId) savePrimeCliTeamSelection(null);
		return;
	}

	const selectedId = await interaction.prompt({
		type: "select",
		message: "Select a Prime team",
		options: [
			{ id: "", label: "No team (personal account)" },
			...teams.map((team) => ({
				id: team.teamId,
				label: team.name,
				...(team.role ? { description: team.role } : {}),
			})),
		],
	});
	const selected = teams.find((team) => team.teamId === selectedId) ?? null;
	savePrimeCliTeamSelection(selected);
}

async function loginPrimeInference(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
	const config = loadPrimeCliConfig();
	let apiKey: string | undefined;

	if (config.apiKey) {
		interaction.notify({ type: "progress", message: "Checking existing Prime CLI credentials..." });
		try {
			await checkPrimeInferenceAccess(config.apiKey, config.baseUrl, interaction.signal);
			apiKey = config.apiKey;
		} catch (error) {
			interaction.signal.throwIfAborted();
			const message = error instanceof Error ? error.message : String(error);
			interaction.notify({
				type: "progress",
				message: `Existing Prime CLI key cannot access Prime Inference (${message}). Starting browser login...`,
			});
		}
	}

	if (!apiKey) {
		apiKey = await runPrimeBrowserLogin(config, interaction);
		interaction.notify({ type: "progress", message: "Checking Prime Inference access..." });
		await checkPrimeInferenceAccess(apiKey, config.baseUrl, interaction.signal);
	}

	interaction.signal.throwIfAborted();
	await selectPrimeTeam(apiKey, config, interaction);

	return {
		type: "oauth",
		access: apiKey,
		refresh: apiKey,
		expires: Date.now() + API_KEY_EXPIRES_MS,
	};
}

export const primeInferenceOAuth: OAuthAuth = {
	name: "Prime Inference",
	loginLabel: "Sign in with Prime Intellect",

	login: loginPrimeInference,

	// The credential wraps a long-lived API key; there is nothing to exchange.
	refresh: async (credential) => credential,

	async toAuth(credential) {
		return { apiKey: credential.access };
	},
};
