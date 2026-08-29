import {
	type ChildProcess,
	type ChildProcessByStdio,
	execFileSync,
	spawn as nodeSpawn,
	spawnSync as nodeSpawnSync,
	type SpawnOptions,
	type SpawnOptionsWithStdioTuple,
	type SpawnSyncOptionsWithStringEncoding,
	type SpawnSyncReturns,
	type StdioNull,
	type StdioPipe,
} from "node:child_process";
import { readFileSync } from "node:fs";
import { constants } from "node:os";
import type { Readable } from "node:stream";
import crossSpawn from "cross-spawn";

const EXIT_STDIO_GRACE_MS = 100;

export function spawnProcess(
	command: string,
	args: string[],
	options: SpawnOptionsWithStdioTuple<StdioNull, StdioPipe, StdioPipe>,
): ChildProcessByStdio<null, Readable, Readable>;
export function spawnProcess(command: string, args: string[], options: SpawnOptions): ChildProcess;
export function spawnProcess(command: string, args: string[], options: SpawnOptions): ChildProcess {
	return process.platform === "win32" ? crossSpawn(command, args, options) : nodeSpawn(command, args, options);
}

export function spawnProcessSync(
	command: string,
	args: string[],
	options: SpawnSyncOptionsWithStringEncoding,
): SpawnSyncReturns<string> {
	return process.platform === "win32"
		? crossSpawn.sync(command, args, options)
		: nodeSpawnSync(command, args, options);
}

/**
 * Wait for a child process to terminate without hanging on inherited stdio handles.
 *
 * A short-lived child can `exit` while a detached descendant keeps its stdout/stderr
 * pipe open. We must not resolve and destroy the streams on a fixed deadline measured
 * from `exit`, or output still being written past that deadline is silently lost
 * (earendil-works/pi#5303). Instead, after `exit` we wait for the pipes to fall idle:
 * the grace timer is re-armed on every chunk, so an actively writing descendant keeps
 * us reading, while a quiet inherited handle (e.g. a Windows daemonized descendant
 * that never lets `close` fire) still releases us after the grace elapses.
 */
/** Shell convention for a signal death: 128 + signal number, so SIGTERM reads as 143. */
function signalExitCode(signal: NodeJS.Signals | null): number | null {
	if (!signal) return null;
	const signalNumber = constants.signals[signal];
	return signalNumber === undefined ? 1 : 128 + signalNumber;
}

function normalizedExitCode(code: number | null, signal: NodeJS.Signals | null): number | null {
	return code ?? signalExitCode(signal);
}

export function waitForChildProcess(child: ChildProcess): Promise<number | null> {
	return new Promise((resolve, reject) => {
		let settled = false;
		let exited = false;
		let exitCode: number | null = null;
		let exitSignal: NodeJS.Signals | null = null;
		let postExitTimer: NodeJS.Timeout | undefined;
		// A stream that already ended emits no further "end", so its state has to be read up front.
		let stdoutEnded = child.stdout === null || child.stdout.readableEnded;
		let stderrEnded = child.stderr === null || child.stderr.readableEnded;

		const cleanup = () => {
			if (postExitTimer) {
				clearTimeout(postExitTimer);
				postExitTimer = undefined;
			}
			child.removeListener("error", onError);
			child.removeListener("exit", onExit);
			child.removeListener("close", onClose);
			child.stdout?.removeListener("end", onStdoutEnd);
			child.stderr?.removeListener("end", onStderrEnd);
			child.stdout?.removeListener("data", onData);
			child.stderr?.removeListener("data", onData);
		};

		const finalize = (code: number | null) => {
			if (settled) return;
			settled = true;
			cleanup();
			child.stdout?.destroy();
			child.stderr?.destroy();
			resolve(code);
		};

		const maybeFinalizeAfterExit = () => {
			if (!exited || settled) return;
			if (stdoutEnded && stderrEnded) {
				finalize(normalizedExitCode(exitCode, exitSignal));
			}
		};

		const armIdleTimer = () => {
			if (postExitTimer) clearTimeout(postExitTimer);
			postExitTimer = setTimeout(() => finalize(normalizedExitCode(exitCode, exitSignal)), EXIT_STDIO_GRACE_MS);
		};

		const onData = () => {
			// Output is still arriving after exit; defer finalizing so we don't
			// destroy the stream mid-write and truncate the tail.
			if (exited && !settled) armIdleTimer();
		};

		const onStdoutEnd = () => {
			stdoutEnded = true;
			maybeFinalizeAfterExit();
		};

		const onStderrEnd = () => {
			stderrEnded = true;
			maybeFinalizeAfterExit();
		};

		const onError = (err: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(err);
		};

		const onExit = (code: number | null, signal: NodeJS.Signals | null = null) => {
			exited = true;
			exitCode = code;
			exitSignal = signal;
			maybeFinalizeAfterExit();
			if (!settled) {
				armIdleTimer();
			}
		};

		const onClose = (code: number | null, signal: NodeJS.Signals | null = null) => {
			finalize(normalizedExitCode(code, signal));
		};

		child.stdout?.once("end", onStdoutEnd);
		child.stderr?.once("end", onStderrEnd);
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);
		child.once("error", onError);
		child.once("exit", onExit);
		child.once("close", onClose);

		// A child that had already terminated when this was called will never emit exit or close.
		if (child.exitCode !== null || child.signalCode !== null) {
			onExit(child.exitCode, child.signalCode);
		}
	});
}

export function processIdExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** A zombie has already exited; it only lingers until its parent reaps it. */
export function isZombieProcess(pid: number): boolean {
	if (process.platform === "win32") {
		return false;
	}
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const state = stat
			.slice(stat.lastIndexOf(")") + 2)
			.trimStart()
			.charAt(0);
		return state === "Z";
	} catch {
		// Fall through to the portable process listing used on macOS and BSD.
	}
	try {
		const state = execFileSync("ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8" }).trim();
		return state.startsWith("Z");
	} catch {
		return false;
	}
}

export function isProcessAlive(pid: number): boolean {
	return processIdExists(pid) && !isZombieProcess(pid);
}

export function signalProcessGroupOrProcess(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(-pid, signal);
		return;
	} catch {
		// Fall back when process groups are unavailable or the group already exited.
	}
	try {
		process.kill(pid, signal);
	} catch {
		// The process may already be fully reaped.
	}
}
