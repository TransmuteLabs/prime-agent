import { enableCompileCache } from "node:module";
import { maybeStartDaemonEarly } from "./cli/daemon-launch.ts";
import {
	closeOwnedSessionWorkerOwnerWatch,
	installOwnedSessionWorkerOwnerWatch,
	isOwnedSessionWorkerProcess,
	maybeRunOwnedSessionWorkerFrontend,
} from "./cli/owned-session-worker.ts";
import { APP_NAME } from "./config.ts";

export async function runCli(): Promise<void> {
	try {
		enableCompileCache?.();
	} catch {
		// Read-only cache dir; startup just skips the cache.
	}

	process.title = APP_NAME;
	process.env.PI_CODING_AGENT = "true";
	process.env.AI_AGENT = "pi";
	process.emitWarning = (() => {}) as typeof process.emitWarning;

	installOwnedSessionWorkerOwnerWatch();

	const args = process.argv.slice(2);
	const handledByOwnedWorker = await maybeRunOwnedSessionWorkerFrontend(args);
	if (handledByOwnedWorker) {
		return;
	}

	if (!isOwnedSessionWorkerProcess()) {
		// Boot a cold daemon concurrently with this process's heavy imports.
		maybeStartDaemonEarly(args);
	}
	const [{ configureHttpDispatcher }, { main }] = await Promise.all([
		import("./core/http-dispatcher.ts"),
		import("./main.ts"),
	]);

	// The dispatcher is installed before provider SDKs issue requests; runtime settings are
	// applied later, once SettingsManager has loaded global and project settings.
	configureHttpDispatcher();

	try {
		await main(args);
	} finally {
		closeOwnedSessionWorkerOwnerWatch();
	}
}
