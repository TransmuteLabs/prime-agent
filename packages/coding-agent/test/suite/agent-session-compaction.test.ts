import { appendFileSync } from "node:fs";
import {
	AgentContinueError,
	type AgentMessage,
	type AgentTool,
	type ShouldStopAfterTurnContext,
} from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type Context,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxToolCall,
	type Model,
	type SimpleStreamOptions,
	type ToolResultMessage,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { estimateTokens } from "../../src/core/compaction/index.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness, getMessageText, getUserTexts, type Harness } from "./harness.ts";

type SessionWithCompactionInternals = {
	_checkCompaction: (
		assistantMessage: AssistantMessage,
		skipAbortedCheck?: boolean,
		queueAutonomousContinuation?: boolean,
	) => Promise<boolean>;
	_runAutoCompaction: (reason: "overflow" | "threshold" | "requested", willRetry: boolean) => Promise<boolean>;
	_shouldStopAfterTurn: (context: ShouldStopAfterTurnContext) => boolean | Promise<boolean>;
	_compactBeforeNextAssistantResponse: (turn: ShouldStopAfterTurnContext) => Promise<unknown>;
	/** The decision half alone: queues the continuations without running the compaction. */
	_thresholdCompactionNeeded: (context: ShouldStopAfterTurnContext) => Promise<boolean>;
	_persistCompactionOutcome: (
		reason: "overflow" | "threshold" | "requested",
		outcome: "skipped" | "cancelled" | "failed",
		message: string,
	) => void;
};

function createUsage(totalTokens: number) {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createAssistant(
	harness: Harness,
	options: {
		stopReason?: AssistantMessage["stopReason"];
		errorMessage?: string;
		totalTokens?: number;
		timestamp?: number;
	},
): AssistantMessage {
	const model = harness.getModel();
	return {
		...fauxAssistantMessage("", {
			stopReason: options.stopReason,
			errorMessage: options.errorMessage,
			timestamp: options.timestamp,
		}),
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createUsage(options.totalTokens ?? 0),
	};
}

function failingGateCommand(): string {
	return `${process.execPath} -e "console.error('gate failed'); process.exit(1)"`;
}

function useSummaryStreamFn(
	harness: Harness,
	summary: string,
	onRequest?: (context: Context, options: SimpleStreamOptions | undefined) => void,
): () => number {
	let callCount = 0;
	harness.session.agent.streamFunction = (model, context, options) => {
		callCount++;
		onRequest?.(context, options);
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			const message: AssistantMessage = {
				...fauxAssistantMessage(summary),
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: createUsage(10),
			};
			stream.push({ type: "done", reason: "stop", message });
		});
		return stream;
	};
	return () => callCount;
}

function seedCompactableSession(harness: Harness): void {
	harness.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
	const now = Date.now();
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "message to compact" }],
		timestamp: now - 1000,
	});
	const assistant = createAssistant(harness, {
		stopReason: "stop",
		totalTokens: 100,
		timestamp: now - 500,
	});
	assistant.content = [{ type: "text", text: "assistant response to compact" }];
	harness.sessionManager.appendMessage(assistant);
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

describe("AgentSession compaction characterization", () => {
	const harnesses: Harness[] = [];

	beforeEach(() => {
		vi.useRealTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("manually compacts using an extension-provided summary", async () => {
		const summaryUsage = {
			input: 10,
			output: 20,
			cacheRead: 30,
			cacheWrite: 40,
			totalTokens: 100,
			cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
		};
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "summary from extension",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							usage: summaryUsage,
							details: { source: "extension" },
						},
					}));
				},
			],
		});
		harnesses.push(harness);

		await harness.session.prompt("one");
		await harness.session.prompt("two");
		const statsBefore = harness.session.getSessionStats();

		const pruneOversizedVariables = vi.fn(async () => ["large_text"]);
		const listNamespaceNames = vi.fn(async () => ["small_value"]);
		const internals = harness.session as unknown as { _ipythonKernelProvisioner?: unknown };
		const previousProvisioner = internals._ipythonKernelProvisioner;
		internals._ipythonKernelProvisioner = {
			hasRunningKernel: true,
			pruneOversizedVariables,
			listNamespaceNames,
		};
		let result!: Awaited<ReturnType<typeof harness.session.compact>>;
		try {
			result = await harness.session.compact();
		} finally {
			internals._ipythonKernelProvisioner = previousProvisioner;
		}
		const compactionEntries = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
		const estimatedTokensAfter = harness.session.messages.reduce((sum, message) => sum + estimateTokens(message), 0);

		expect(pruneOversizedVariables).toHaveBeenCalledOnce();
		expect(listNamespaceNames).toHaveBeenCalledOnce();
		expect(pruneOversizedVariables.mock.invocationCallOrder[0] as number).toBeLessThan(
			listNamespaceNames.mock.invocationCallOrder[0] as number,
		);
		expect(harness.session.messages).toContainEqual(
			expect.objectContaining({
				role: "custom",
				customType: "ipython_state",
				content: expect.stringContaining("were removed: large_text"),
			}),
		);
		expect(result.summary).toBe("summary from extension");
		expect(result.usage).toEqual(summaryUsage);
		expect(result.estimatedTokensAfter).toBe(estimatedTokensAfter);
		expect(compactionEntries).toHaveLength(1);
		const compactionEntry = compactionEntries[0];
		if (compactionEntry?.type === "compaction") {
			expect(compactionEntry.usage).toEqual(summaryUsage);
		}
		const statsAfter = harness.session.getSessionStats();
		expect(statsAfter.tokens.input).toBe(statsBefore.tokens.input + summaryUsage.input);
		expect(statsAfter.tokens.output).toBe(statsBefore.tokens.output + summaryUsage.output);
		expect(statsAfter.tokens.cacheRead).toBe(statsBefore.tokens.cacheRead + summaryUsage.cacheRead);
		expect(statsAfter.tokens.cacheWrite).toBe(statsBefore.tokens.cacheWrite + summaryUsage.cacheWrite);
		expect(statsAfter.cost).toBe(statsBefore.cost + summaryUsage.cost.total);
		expect(harness.session.messages[0]?.role).toBe("compactionSummary");
	});

	it("allows a queued prompt to start when manual compaction ends", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "manual compacted",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		harness.setResponses([fauxAssistantMessage("queued response")]);

		let queuedPrompt: Promise<void> | undefined;
		harness.session.subscribe((event) => {
			if (event.type === "compaction_end" && event.reason === "manual" && event.result) {
				expect(harness.session.isCompacting).toBe(false);
				queuedPrompt = harness.session.prompt("queued after compaction");
			}
		});

		await harness.session.compact();
		if (!queuedPrompt) throw new Error("compaction_end did not start the queued prompt");
		await queuedPrompt;

		expect(getUserTexts(harness)).toContain("queued after compaction");
		expect(harness.session.getLastAssistantText()).toBe("queued response");
	});

	it("throws when compacting without a model", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.agent.state.model = undefined as unknown as Model<any>;

		await expect(harness.session.compact()).rejects.toThrow("No model selected");
	});

	it("throws when compacting without configured auth", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);

		await expect(harness.session.compact()).rejects.toThrow(`No API key found for ${harness.getModel().provider}.`);
	});

	it("manually compacts with a custom streamFn when registry auth is absent", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		seedCompactableSession(harness);
		const getStreamCallCount = useSummaryStreamFn(harness, "summary from custom stream");

		const result = await harness.session.compact();

		expect(result.summary).toContain("summary from custom stream");
		expect(getStreamCallCount()).toBe(1);
	});

	it("manually compacts with provider-resolved bearer auth", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		const model = harness.getModel();
		harness.session.modelRuntime.registerNativeProvider({
			id: model.provider,
			name: "Faux bearer provider",
			auth: {
				apiKey: {
					name: "Faux bearer token",
					resolve: async () => ({
						auth: { headers: { Authorization: "Bearer ambient-token" } },
						source: "ambient bearer token",
					}),
				},
			},
			getModels: () => harness.models,
			stream: () => createAssistantMessageEventStream(),
			streamSimple: () => createAssistantMessageEventStream(),
		});
		seedCompactableSession(harness);
		harness.setResponses([
			(_context, options) => {
				expect(options?.apiKey).toBeUndefined();
				expect(options?.headers).toEqual({ Authorization: "Bearer ambient-token" });
				return fauxAssistantMessage("summary with bearer auth");
			},
		]);

		const result = await harness.session.compact();

		expect(result.summary).toContain("summary with bearer auth");
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("uses the standalone compaction request context", async () => {
		const harness = await createHarness({ settings: { compaction: { keepRecentTokens: 1 } } });
		harnesses.push(harness);
		seedCompactableSession(harness);

		const transformContext = vi.fn(async (messages: AgentMessage[]) => messages);
		harness.session.agent.transformContext = transformContext;
		harness.session.agent.sessionId = "active-routing-session";
		harness.session.agent.transport = "websocket";

		let requestContext: Context | undefined;
		let requestOptions: SimpleStreamOptions | undefined;
		useSummaryStreamFn(harness, "standalone summary", (context, options) => {
			requestContext = context;
			requestOptions = options;
		});

		await harness.session.compact();

		expect(transformContext).not.toHaveBeenCalled();
		expect(requestContext?.systemPrompt).not.toBe(harness.session.agent.state.systemPrompt);
		expect(requestContext?.tools).toBeUndefined();
		expect(JSON.stringify(requestContext?.messages)).toContain("<conversation>");
		expect(requestOptions).toMatchObject({ cacheRetention: "none" });
		expect(requestOptions?.sessionId).not.toBe("active-routing-session");
		expect(requestOptions?.transport).toBeUndefined();
	});

	it("persists usage from pi-generated manual compaction", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		seedCompactableSession(harness);
		useSummaryStreamFn(harness, "summary from custom stream");

		const result = await harness.session.compact();

		const compactionEntries = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
		expect(result.usage).toEqual(createUsage(10));
		expect(compactionEntries).toHaveLength(1);
		expect(compactionEntries[0]?.type === "compaction" ? compactionEntries[0].usage : undefined).toEqual(
			createUsage(10),
		);
	});

	it("auto-compacts with a custom streamFn when registry auth is absent", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		seedCompactableSession(harness);
		const getStreamCallCount = useSummaryStreamFn(harness, "auto summary from custom stream");
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;

		await sessionInternals._runAutoCompaction("threshold", false);

		const compactionEntries = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
		const compactionEnd = harness.eventsOfType("compaction_end").at(-1);
		expect(compactionEntries).toHaveLength(1);
		expect(compactionEnd?.result?.estimatedTokensAfter).toBeGreaterThan(0);
		expect(getStreamCallCount()).toBe(1);
	});

	it("notifies extensions when auto-compaction fails", async () => {
		const failedEvents: Array<{
			reason: "manual" | "threshold" | "overflow";
			errorMessage?: string;
			aborted: boolean;
			willRetry: boolean;
			fromExtension: boolean;
		}> = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_compact_failed", async (event) => {
						failedEvents.push(event);
					});
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		harness.session.agent.streamFunction = () => {
			throw new Error("summary generator blew up");
		};
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;

		await expect(sessionInternals._runAutoCompaction("threshold", false)).resolves.toBe(false);

		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
			reason: "threshold",
			aborted: false,
			willRetry: false,
			errorMessage: "Auto-compaction failed: summary generator blew up",
		});
		expect(failedEvents).toEqual([
			expect.objectContaining({
				type: "session_compact_failed",
				reason: "threshold",
				aborted: false,
				willRetry: false,
				fromExtension: false,
				errorMessage: "Auto-compaction failed: summary generator blew up",
			}),
		]);
	});

	it("compacts and resumes after a length stop below the desired output limit", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 1000, maxTokens: 100 }],
			settings: { compaction: { keepRecentTokens: 1, reserveTokens: 0 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "overflow compacted",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("partial response", { stopReason: "length" }),
			fauxAssistantMessage("completed response"),
		]);

		await harness.session.prompt("x".repeat(5000));

		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
			reason: "overflow",
			aborted: false,
			willRetry: true,
		});
		expect(harness.session.getLastAssistantText()).toBe("completed response");
	});

	it("compacts after a tool result before the next assistant request in the same run", async () => {
		const toolResult = `large-tool-result:${"x".repeat(6800)}`;
		const largeTool: AgentTool = {
			name: "large_result",
			label: "Large result",
			description: "Returns enough content to cross the compaction threshold",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: toolResult }], details: {} }),
		};
		const order: string[] = [];
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 2600, maxTokens: 100 }],
			settings: { compaction: { enabled: true, reserveTokens: 400, keepRecentTokens: 1750 } },
			tools: [largeTool],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", (event) => {
						order.push("compaction");
						return {
							compaction: {
								summary: "compacted history",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
								details: {},
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		let resumedRequest = "";
		harness.setResponses([
			fauxAssistantMessage(`old-history:${"a".repeat(800)}`),
			fauxAssistantMessage(`recent-history:${"b".repeat(800)}`),
			fauxAssistantMessage(fauxToolCall("large_result", {}), { stopReason: "toolUse" }),
			(context) => {
				order.push("provider");
				resumedRequest = JSON.stringify(context.messages);
				return fauxAssistantMessage("finished after compaction");
			},
		]);

		await harness.session.prompt("seed old history");
		await harness.session.prompt("seed recent history");
		const agentStartsBefore = harness.eventsOfType("agent_start").length;
		await harness.session.prompt("run the large tool");

		expect(order).toEqual(["compaction", "provider"]);
		expect(harness.eventsOfType("agent_start")).toHaveLength(agentStartsBefore + 1);
		expect(harness.eventsOfType("compaction_start").at(-1)).toEqual({
			type: "compaction_start",
			reason: "threshold",
		});
		expect(resumedRequest).toContain("compacted history");
		expect(resumedRequest).toContain("large-tool-result");
		expect(harness.session.getLastAssistantText()).toBe("finished after compaction");
	});

	it("includes steering queued during compaction in the resumed assistant request", async () => {
		const largeTool: AgentTool = {
			name: "large_result",
			label: "Large result",
			description: "Returns enough content to cross the compaction threshold",
			parameters: Type.Object({}),
			execute: async () => ({
				content: [{ type: "text", text: `large-tool-result:${"x".repeat(6800)}` }],
				details: {},
			}),
		};
		let markCompactionStarted = () => {};
		const compactionStarted = new Promise<void>((resolve) => {
			markCompactionStarted = resolve;
		});
		let releaseCompaction = () => {};
		const compactionReleased = new Promise<void>((resolve) => {
			releaseCompaction = resolve;
		});
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 2600, maxTokens: 100 }],
			settings: { compaction: { enabled: true, reserveTokens: 400, keepRecentTokens: 1750 } },
			tools: [largeTool],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						markCompactionStarted();
						await compactionReleased;
						return {
							compaction: {
								summary: "compacted history",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
								details: {},
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		let resumedRequest = "";
		harness.setResponses([
			fauxAssistantMessage(`old-history:${"a".repeat(800)}`),
			fauxAssistantMessage(`recent-history:${"b".repeat(800)}`),
			fauxAssistantMessage(fauxToolCall("large_result", {}), { stopReason: "toolUse" }),
			(context) => {
				resumedRequest = JSON.stringify(context.messages);
				return fauxAssistantMessage("finished after compaction");
			},
			fauxAssistantMessage("finished after delayed steering"),
		]);

		await harness.session.prompt("seed old history");
		await harness.session.prompt("seed recent history");
		const promptPromise = harness.session.prompt("run the large tool");
		await compactionStarted;
		await harness.session.steer("change direction");
		releaseCompaction();
		await promptPromise;

		expect(resumedRequest).toContain("change direction");
		expect(harness.faux.state.callCount).toBe(4);
	});

	it("does not compact after a terminating tool result", async () => {
		const terminatingTool: AgentTool = {
			name: "terminate_with_large_result",
			label: "Terminate with large result",
			description: "Returns enough content to cross the compaction threshold, then terminates",
			parameters: Type.Object({}),
			execute: async () => ({
				content: [{ type: "text", text: `large-tool-result:${"x".repeat(6800)}` }],
				details: {},
				terminate: true,
			}),
		};
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 2600, maxTokens: 100 }],
			settings: { compaction: { enabled: true, reserveTokens: 400, keepRecentTokens: 1750 } },
			tools: [terminatingTool],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", (event) => ({
						compaction: {
							summary: "unexpected compaction",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(`old-history:${"a".repeat(800)}`),
			fauxAssistantMessage(`recent-history:${"b".repeat(800)}`),
			fauxAssistantMessage(fauxToolCall("terminate_with_large_result", {}), { stopReason: "toolUse" }),
		]);

		await harness.session.prompt("seed old history");
		await harness.session.prompt("seed recent history");
		await harness.session.prompt("run the terminating tool");

		// The between-turn check is the subject: a batch that terminates the run must not compact
		// on the way to a next assistant request, because there is no next request. Counting
		// provider calls measures exactly that and stays independent of the run-end check, which
		// this tree bases on the whole session rather than the last assistant message's usage
		// (_getThresholdContextTokens), so an appended tool result counts here immediately
		// instead of at the next prompt.
		expect(harness.faux.state.callCount).toBe(3);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("does not compact when a length stop reaches the desired output limit", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 1_000_000, maxTokens: 100 }],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("x".repeat(400), { stopReason: "length" })]);

		await harness.session.prompt("hello");

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.eventsOfType("compaction_start")).toHaveLength(0);
	});

	it("stops after one compact-and-retry when a second response is also truncated", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 1_000_000, maxTokens: 100 }],
			settings: { compaction: { keepRecentTokens: 1, reserveTokens: 0 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "overflow compacted",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			() => fauxAssistantMessage("x".repeat(64), { stopReason: "length", timestamp: Date.now() + 10_000 }),
			() => fauxAssistantMessage("y".repeat(64), { stopReason: "length", timestamp: Date.now() + 10_000 }),
		]);

		await harness.session.prompt("x".repeat(5000));

		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.eventsOfType("compaction_start").filter((event) => event.reason === "overflow")).toHaveLength(1);
		expect(harness.eventsOfType("compaction_end").at(-1)?.errorMessage).toBe(
			"Truncated response recovery failed after one compact-and-retry attempt.",
		);
	});

	it("keeps overflow wording when a repeated length stop fills the context window", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 100, maxTokens: 100 }],
		});
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const lengthOverflowMessage = createAssistant(harness, {
			stopReason: "length",
			totalTokens: 100,
			timestamp: Date.now(),
		});
		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);
		const compactionErrors: string[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "compaction_end" && event.errorMessage) {
				compactionErrors.push(event.errorMessage);
			}
		});

		await sessionInternals._checkCompaction(lengthOverflowMessage);
		await sessionInternals._checkCompaction({ ...lengthOverflowMessage, timestamp: Date.now() + 1 });

		expect(runAutoCompactionSpy).toHaveBeenCalledTimes(1);
		expect(compactionErrors).toContain(
			"Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.",
		);
	});

	it("cancels in-progress manual compaction when abortCompaction is called", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						return await new Promise<{ cancel: true }>((resolve) => {
							event.signal.addEventListener("abort", () => resolve({ cancel: true }), { once: true });
						});
					});
				},
			],
		});
		harnesses.push(harness);

		await harness.session.prompt("one");
		await harness.session.prompt("two");

		const compactPromise = harness.session.compact();
		await new Promise((resolve) => setTimeout(resolve, 0));
		harness.session.abortCompaction();

		await expect(compactPromise).rejects.toThrow("Compaction cancelled");
	});

	it("resumes after threshold compaction when only agent-level queued messages exist", async () => {
		vi.useFakeTimers();
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "auto compacted",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		await harness.session.prompt("first");
		await harness.session.prompt("second");

		harness.session.agent.followUp({
			role: "custom",
			customType: "test",
			content: [{ type: "text", text: "queued custom" }],
			display: false,
			timestamp: Date.now(),
		});

		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;

		await expect(sessionInternals._runAutoCompaction("threshold", false)).resolves.toBe(true);
	});

	it("does not retry overflow recovery more than once", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const overflowMessage = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "prompt is too long",
			timestamp: Date.now(),
		});
		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);
		const compactionErrors: string[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "compaction_end" && event.errorMessage) {
				compactionErrors.push(event.errorMessage);
			}
		});

		await sessionInternals._checkCompaction(overflowMessage);
		await sessionInternals._checkCompaction({ ...overflowMessage, timestamp: Date.now() + 1 });

		expect(runAutoCompactionSpy).toHaveBeenCalledTimes(1);
		expect(compactionErrors).toContain(
			"Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.",
		);
	});

	it("compacts successful overflow responses without retrying", async () => {
		const harness = await createHarness({
			settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 0 } },
			models: [{ id: "faux-1", contextWindow: 1, maxTokens: 100 }],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "successful overflow compacted",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("completed answer")]);

		await expect(harness.session.prompt("hello")).resolves.toBeUndefined();

		const compactionEnd = harness.eventsOfType("compaction_end").at(-1);
		expect(compactionEnd).toMatchObject({
			reason: "overflow",
			aborted: false,
			willRetry: false,
		});
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("ignores stale pre-compaction assistant usage on pre-prompt checks", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const staleTimestamp = Date.now() - 10_000;
		const staleAssistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 610_000,
			timestamp: staleTimestamp,
		});

		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "before compaction" }],
			timestamp: staleTimestamp - 1000,
		});
		harness.sessionManager.appendMessage(staleAssistant);
		const firstKeptEntryId = harness.sessionManager.getEntries()[0]!.id;
		harness.sessionManager.appendCompaction(
			"summary",
			firstKeptEntryId,
			staleAssistant.usage.totalTokens,
			undefined,
			false,
		);
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "after compaction" }],
			timestamp: Date.now(),
		});

		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);

		await sessionInternals._checkCompaction(staleAssistant, false);

		expect(runAutoCompactionSpy).not.toHaveBeenCalled();
	});

	it("triggers threshold compaction for error messages using the last successful usage", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const successfulAssistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 190_000,
			timestamp: Date.now(),
		});
		const errorAssistant = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "529 overloaded",
			timestamp: Date.now() + 1000,
		});
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() - 1000 },
			successfulAssistant,
			{ role: "user", content: [{ type: "text", text: "retry" }], timestamp: Date.now() + 500 },
			errorAssistant,
		];

		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);

		await sessionInternals._checkCompaction(errorAssistant);

		expect(runAutoCompactionSpy).toHaveBeenCalledWith("threshold", false, true);
	});

	it("triggers threshold compaction when trailing context exceeds the model window", async () => {
		const harness = await createHarness({
			settings: { compaction: { enabled: true, reserveTokens: 1000 } },
			models: [{ id: "faux-1", contextWindow: 200_000 }],
		});
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const successfulAssistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 10_000,
			timestamp: Date.now(),
		});
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() - 1000 },
			successfulAssistant,
			{
				role: "custom",
				customType: "large-context",
				content: [{ type: "text", text: "x".repeat(800_000) }],
				display: false,
				timestamp: Date.now() + 500,
			},
		];

		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);

		await sessionInternals._checkCompaction(successfulAssistant, false);

		expect(runAutoCompactionSpy).toHaveBeenCalledWith("threshold", false, true);
	});

	it("compacts before the next model call of a tool loop", async () => {
		const harness = await createHarness({
			settings: { compaction: { enabled: true, reserveTokens: 1000 } },
			models: [{ id: "faux-1", contextWindow: 200_000 }],
		});
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const successfulAssistant = createAssistant(harness, {
			stopReason: "toolUse",
			totalTokens: 10_000,
			timestamp: Date.now(),
		});
		const toolResult: ToolResultMessage<unknown> = {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "large-context",
			content: [{ type: "text", text: "x".repeat(800_000) }],
			isError: false,
			timestamp: Date.now() + 500,
		};
		const messages: AgentMessage[] = [
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() - 1000 },
			successfulAssistant,
			toolResult,
		];
		harness.session.agent.state.messages = messages;

		await sessionInternals._compactBeforeNextAssistantResponse({
			message: successfulAssistant,
			toolResults: [toolResult],
			hasMoreToolCalls: true,
			context: { systemPrompt: harness.session.systemPrompt, messages, tools: [] },
			newMessages: [successfulAssistant, toolResult],
		});

		expect(harness.eventsOfType("compaction_start").map((event) => event.reason)).toEqual(["threshold"]);
	});

	it("queues a failing autonomous gate continuation before the compaction that precedes the next turn", async () => {
		vi.useFakeTimers();
		let queuedBeforeCompaction: readonly string[] = [];
		let autonomousBeforeCompaction: ReturnType<typeof harness.session.getAutonomousStatus> | undefined;
		const harness = await createHarness({
			autonomous: {
				enabled: true,
				maxContinuations: 2,
				maxTurns: 100,
				gates: { commands: [failingGateCommand()], maxRetries: 5 },
			},
			settings: { compaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 1 } },
			models: [{ id: "faux-1", contextWindow: 200_000 }],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						queuedBeforeCompaction = harness.session.getFollowUpMessages();
						autonomousBeforeCompaction = harness.session.getAutonomousStatus();
						return {
							compaction: {
								summary: "auto compacted",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
								details: {},
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const successfulAssistant = createAssistant(harness, {
			stopReason: "toolUse",
			totalTokens: 10_000,
			timestamp: Date.now(),
		});
		const toolResult: ToolResultMessage<unknown> = {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "large-context",
			content: [{ type: "text", text: "x".repeat(800_000) }],
			isError: false,
			timestamp: Date.now() + 500,
		};
		const currentUser = {
			role: "user",
			content: [{ type: "text", text: "hello" }],
			timestamp: Date.now() - 1000,
		} satisfies Parameters<typeof harness.sessionManager.appendMessage>[0];
		const oldUser = {
			role: "user",
			content: [{ type: "text", text: "old" }],
			timestamp: Date.now() - 3000,
		} satisfies Parameters<typeof harness.sessionManager.appendMessage>[0];
		const oldAssistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 100,
			timestamp: Date.now() - 2000,
		});
		const oldMessages: AgentMessage[] = [oldUser, oldAssistant];
		const messages: AgentMessage[] = [currentUser, successfulAssistant, toolResult];
		for (const message of [oldUser, oldAssistant, currentUser, successfulAssistant]) {
			harness.sessionManager.appendMessage(message);
		}
		harness.session.agent.state.messages = [...oldMessages, ...messages];

		const continueSpy = vi.spyOn(harness.session.agent, "continue").mockResolvedValue();
		const followUpSpy = vi.spyOn(harness.session.agent, "followUp");

		await sessionInternals._compactBeforeNextAssistantResponse({
			message: successfulAssistant,
			toolResults: [toolResult],
			hasMoreToolCalls: true,
			context: { systemPrompt: harness.session.systemPrompt, messages, tools: [] },
			newMessages: [successfulAssistant, toolResult],
		});
		await vi.advanceTimersByTimeAsync(100);

		expect(autonomousBeforeCompaction).toMatchObject({
			continuationsUsed: 1,
			gates: expect.objectContaining({ maxRetries: 5 }),
		});
		expect(followUpSpy).not.toHaveBeenCalled();
		const queuedText = queuedBeforeCompaction[0] ?? "";
		expect(queuedText).toContain("Autonomous quality gate failed (attempt 1/5)");
		expect(queuedText).toContain("gate failed");

		// The loop owns the next turn now, so the continuation must not also be scheduled.
		expect(continueSpy).not.toHaveBeenCalled();
		expect(harness.session.getFollowUpMessages()).toEqual([]);
	});

	it("keeps autonomous continuation bookkeeping when only steering queue is drained", async () => {
		vi.useFakeTimers();
		const harness = await createHarness({
			autonomous: {
				enabled: true,
				maxContinuations: 2,
				maxTurns: 100,
				gates: { commands: [failingGateCommand()], maxRetries: 5 },
			},
			settings: { compaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 1 } },
			models: [{ id: "faux-1", contextWindow: 200_000 }],
		});
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as {
			_schedulePostCompactionContinue(): void;
			_postCompactionContinuationMessages: AgentMessage[];
		};
		const steeringMessage = {
			role: "user",
			content: [{ type: "text", text: "steer first" }],
			timestamp: Date.now(),
		} satisfies AgentMessage;
		const autonomousMessage = {
			role: "user",
			content: [{ type: "text", text: "autonomous follow-up" }],
			timestamp: Date.now(),
		} satisfies AgentMessage;
		sessionInternals._postCompactionContinuationMessages = [autonomousMessage];
		harness.session.agent.state.messages = [{ ...fauxAssistantMessage("done"), timestamp: Date.now() - 1000 }];
		harness.session.agent.steer(steeringMessage);
		harness.session.agent.followUp(autonomousMessage);
		const continueSpy = vi.spyOn(harness.session.agent, "continue").mockResolvedValue();
		const followUpSpy = vi.spyOn(harness.session.agent, "followUp");

		sessionInternals._schedulePostCompactionContinue();
		await vi.advanceTimersByTimeAsync(100);

		expect(continueSpy).toHaveBeenCalledTimes(1);
		expect(sessionInternals._postCompactionContinuationMessages).toEqual([autonomousMessage]);
		expect(followUpSpy).toHaveBeenCalledWith(autonomousMessage);
	});

	it.each([
		{
			name: "untracked queued input",
			text: "queued input",
			response: "queued input handled",
			tracked: false,
		},
		{
			name: "post-compaction continuation",
			text: "session-owned continuation",
			response: "continuation handled",
			tracked: true,
		},
	])("does not continue again after the session pump handles $name", async ({ text, response, tracked }) => {
		vi.useFakeTimers();
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as {
			_schedulePostCompactionContinue(): void;
			_postCompactionContinuationMessages: AgentMessage[];
			_postCompactionContinuationScheduled: boolean;
			_createPreparedTurnAction(
				schedule: "followUp",
				text: string,
				images: undefined,
				options: { message?: AgentMessage; resumeIfIdle: boolean },
			): unknown;
			_admitSessionInput(action: unknown, options?: { wake?: boolean }): { accepted: boolean };
		};
		const continuation = {
			role: "user",
			content: [{ type: "text", text }],
			timestamp: Date.now(),
		} satisfies AgentMessage;
		if (tracked) sessionInternals._postCompactionContinuationMessages = [continuation];
		harness.setResponses([fauxAssistantMessage(response)]);
		sessionInternals._admitSessionInput(
			sessionInternals._createPreparedTurnAction("followUp", text, undefined, {
				...(tracked && { message: continuation }),
				resumeIfIdle: tracked,
			}),
		);
		const continueSpy = vi.spyOn(harness.session.agent, "continue");

		sessionInternals._schedulePostCompactionContinue();
		await vi.advanceTimersByTimeAsync(200);

		expect(continueSpy).not.toHaveBeenCalled();
		expect(sessionInternals._postCompactionContinuationScheduled).toBe(false);
		expect(sessionInternals._postCompactionContinuationMessages).toEqual([]);
		expect(harness.session.messages.at(-1)).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: response }],
		});
	});

	it("keeps autonomous threshold continuations when post-compaction continue must retry", async () => {
		vi.useFakeTimers();
		const harness = await createHarness({
			autonomous: {
				enabled: true,
				maxContinuations: 2,
				maxTurns: 100,
				gates: { commands: [failingGateCommand()], maxRetries: 5 },
			},
			settings: { compaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 1 } },
			models: [{ id: "faux-1", contextWindow: 200_000 }],
		});
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as {
			_schedulePostCompactionContinue(): void;
			_postCompactionContinuationMessages: AgentMessage[];
			_postCompactionContinuationScheduled: boolean;
		};
		const queuedMessage = {
			role: "user",
			content: [{ type: "text", text: "autonomous follow-up" }],
			timestamp: Date.now(),
		} satisfies AgentMessage;
		sessionInternals._postCompactionContinuationMessages = [queuedMessage];
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() - 1000 },
		];
		const continueSpy = vi
			.spyOn(harness.session.agent, "continue")
			.mockRejectedValueOnce(new AgentContinueError("busy", "already processing"));

		sessionInternals._schedulePostCompactionContinue();
		await vi.advanceTimersByTimeAsync(100);

		expect(continueSpy).toHaveBeenCalledTimes(1);
		expect(sessionInternals._postCompactionContinuationMessages).toEqual([queuedMessage]);
		expect(sessionInternals._postCompactionContinuationScheduled).toBe(true);
	});

	it("clears queued autonomous threshold continuations when autonomous mode is disabled", async () => {
		vi.useFakeTimers();
		const harness = await createHarness({
			autonomous: {
				enabled: true,
				maxContinuations: 2,
				maxTurns: 100,
				gates: { commands: [failingGateCommand()], maxRetries: 5 },
			},
			settings: { compaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 1 } },
			models: [{ id: "faux-1", contextWindow: 200_000 }],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "auto compacted",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const successfulAssistant = createAssistant(harness, {
			stopReason: "toolUse",
			totalTokens: 10_000,
			timestamp: Date.now(),
		});
		const toolResult: ToolResultMessage<unknown> = {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "large-context",
			content: [{ type: "text", text: "x".repeat(800_000) }],
			isError: false,
			timestamp: Date.now() + 500,
		};
		const oldUser = {
			role: "user",
			content: [{ type: "text", text: "old" }],
			timestamp: Date.now() - 3000,
		} satisfies Parameters<typeof harness.sessionManager.appendMessage>[0];
		const oldAssistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 100,
			timestamp: Date.now() - 2000,
		});
		const currentUser = {
			role: "user",
			content: [{ type: "text", text: "hello" }],
			timestamp: Date.now() - 1000,
		} satisfies Parameters<typeof harness.sessionManager.appendMessage>[0];
		for (const message of [oldUser, oldAssistant, currentUser, successfulAssistant]) {
			harness.sessionManager.appendMessage(message);
		}
		harness.session.agent.state.messages = [oldUser, oldAssistant, currentUser, successfulAssistant, toolResult];

		await sessionInternals._thresholdCompactionNeeded({
			message: successfulAssistant,
			toolResults: [toolResult],
			hasMoreToolCalls: true,
			context: {
				systemPrompt: harness.session.systemPrompt,
				messages: [currentUser, successfulAssistant, toolResult],
				tools: [],
			},
			newMessages: [successfulAssistant, toolResult],
		});
		expect(harness.session.getFollowUpMessages()).toHaveLength(1);

		await harness.session.prompt("/autonomous off");
		await harness.session.waitForIdle();
		expect(harness.session.getAutonomousStatus().enabled).toBe(false);
		expect(harness.session.getFollowUpMessages()).toEqual([]);

		await sessionInternals._runAutoCompaction("threshold", false);
		await vi.advanceTimersByTimeAsync(100);

		expect(harness.session.getFollowUpMessages()).toEqual([]);
	});

	it("queues a failing autonomous gate continuation before post-turn threshold compaction", async () => {
		vi.useFakeTimers();
		const harness = await createHarness({
			autonomous: {
				enabled: true,
				maxContinuations: 2,
				maxTurns: 100,
				gates: { commands: [failingGateCommand()], maxRetries: 5 },
			},
			settings: { compaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 1 } },
			models: [{ id: "faux-1", contextWindow: 200_000 }],
		});
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const successfulAssistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 10_000,
			timestamp: Date.now(),
		});
		const largeToolResult: ToolResultMessage<unknown> = {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "large-context",
			content: [{ type: "text", text: "x".repeat(800_000) }],
			isError: false,
			timestamp: Date.now() + 500,
		};
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() - 1000 },
			successfulAssistant,
			largeToolResult,
		];

		const runCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);
		const followUpSpy = vi.spyOn(harness.session.agent, "followUp");

		await sessionInternals._checkCompaction(successfulAssistant, false);

		expect(runCompactionSpy).toHaveBeenCalledWith("threshold", false, true);
		expect(followUpSpy).not.toHaveBeenCalled();
		expect(harness.session.getAutonomousStatus().continuationsUsed).toBe(1);
		const queuedText = harness.session.getFollowUpMessages()[0] ?? "";
		expect(queuedText).toContain("Autonomous quality gate failed (attempt 1/5)");
		expect(queuedText).toContain("gate failed");
	});

	it("does not queue autonomous gate continuations for pre-prompt threshold compaction", async () => {
		vi.useFakeTimers();
		const harness = await createHarness({
			autonomous: {
				enabled: true,
				maxContinuations: 2,
				maxTurns: 100,
				gates: { commands: [failingGateCommand()], maxRetries: 5 },
			},
			settings: { compaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 1 } },
			models: [{ id: "faux-1", contextWindow: 200_000 }],
		});
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const successfulAssistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 10_000,
			timestamp: Date.now(),
		});
		const largeToolResult: ToolResultMessage<unknown> = {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "large-context",
			content: [{ type: "text", text: "x".repeat(800_000) }],
			isError: false,
			timestamp: Date.now() + 500,
		};
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() - 1000 },
			successfulAssistant,
			largeToolResult,
		];

		const runCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);
		const followUpSpy = vi.spyOn(harness.session.agent, "followUp");

		await sessionInternals._checkCompaction(successfulAssistant, false, false);

		expect(runCompactionSpy).toHaveBeenCalledWith("threshold", false, false);
		expect(followUpSpy).not.toHaveBeenCalled();
		expect(harness.session.getAutonomousStatus().continuationsUsed).toBe(0);
	});

	it("waits for threshold-compaction autonomous continuations before finishing prompt", async () => {
		vi.useFakeTimers();
		const harness = await createHarness({
			autonomous: {
				enabled: true,
				maxContinuations: 1,
				maxTurns: 100,
				gates: { commands: [failingGateCommand()], maxRetries: 5 },
			},
			settings: { compaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 1 } },
			models: [{ id: "faux-1", contextWindow: 200_000 }],
		});
		harnesses.push(harness);
		const highUsageDone = {
			...fauxAssistantMessage("done"),
			usage: createUsage(10_000),
		};
		harness.setResponses([highUsageDone, fauxAssistantMessage("retry")]);
		const promptPromise = harness.session.prompt("make the change");

		await vi.waitFor(() => expect(harness.session.getAutonomousStatus().continuationsUsed).toBe(1));
		await vi.advanceTimersByTimeAsync(100);
		await promptPromise;

		expect(harness.session.getAutonomousStatus()).toMatchObject({
			continuationsUsed: 1,
			turnsUsed: 2,
		});
	});

	it("does not trigger threshold compaction for error messages when no prior usage exists", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const errorAssistant = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "529 overloaded",
			timestamp: Date.now(),
		});
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() - 1000 },
			errorAssistant,
		];

		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);

		await sessionInternals._checkCompaction(errorAssistant);

		expect(runAutoCompactionSpy).not.toHaveBeenCalled();
	});

	it("does not trigger threshold compaction when only kept pre-compaction usage exists", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const preCompactionTimestamp = Date.now() - 10_000;
		const keptAssistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 190_000,
			timestamp: preCompactionTimestamp,
		});

		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "before compaction" }],
			timestamp: preCompactionTimestamp - 1000,
		});
		harness.sessionManager.appendMessage(keptAssistant);
		const firstKeptEntryId = harness.sessionManager.getEntries()[0]!.id;
		harness.sessionManager.appendCompaction(
			"summary",
			firstKeptEntryId,
			keptAssistant.usage.totalTokens,
			undefined,
			false,
		);

		const errorAssistant = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "529 overloaded",
			timestamp: Date.now(),
		});
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "kept user" }], timestamp: preCompactionTimestamp - 1000 },
			keptAssistant,
			{ role: "user", content: [{ type: "text", text: "new prompt" }], timestamp: Date.now() - 500 },
			errorAssistant,
		];

		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);

		await sessionInternals._checkCompaction(errorAssistant);

		expect(runAutoCompactionSpy).not.toHaveBeenCalled();
	});

	it("does not trigger threshold compaction below the threshold or when disabled", async () => {
		const belowThresholdHarness = await createHarness({
			settings: { compaction: { enabled: true, reserveTokens: 1000 } },
			models: [{ id: "faux-1", contextWindow: 200_000 }],
		});
		harnesses.push(belowThresholdHarness);
		const disabledHarness = await createHarness({ settings: { compaction: { enabled: false } } });
		harnesses.push(disabledHarness);

		const belowThresholdInternals = belowThresholdHarness.session as unknown as SessionWithCompactionInternals;
		const disabledInternals = disabledHarness.session as unknown as SessionWithCompactionInternals;
		const belowThresholdSpy = vi.spyOn(belowThresholdInternals, "_runAutoCompaction").mockResolvedValue(false);
		const disabledSpy = vi.spyOn(disabledInternals, "_runAutoCompaction").mockResolvedValue(false);

		await belowThresholdInternals._checkCompaction(
			createAssistant(belowThresholdHarness, { stopReason: "stop", totalTokens: 1_000, timestamp: Date.now() }),
		);
		await disabledInternals._checkCompaction(
			createAssistant(disabledHarness, { stopReason: "stop", totalTokens: 1_000_000, timestamp: Date.now() }),
		);

		expect(belowThresholdSpy).not.toHaveBeenCalled();
		expect(disabledSpy).not.toHaveBeenCalled();
	});

	it("compacts through the model summarizer, persists metadata, emits events, and remains usable", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			persistSession: true,
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("one response"),
			fauxAssistantMessage("two response"),
			fauxAssistantMessage("model-generated summary"),
			fauxAssistantMessage("model-generated turn summary"),
			fauxAssistantMessage("still usable"),
		]);
		await harness.session.prompt("one");
		await harness.session.prompt("two");

		const result = await harness.session.compact();
		const entry = harness.sessionManager.getEntries().find((candidate) => candidate.type === "compaction");

		expect(result.summary).toContain("model-generated summary");
		expect(result.tokensBefore).toBeGreaterThan(0);
		expect(result.firstKeptEntryId).toBeTruthy();
		expect(entry).toMatchObject({
			type: "compaction",
			summary: expect.stringContaining("model-generated summary"),
			firstKeptEntryId: result.firstKeptEntryId,
			tokensBefore: result.tokensBefore,
			fromHook: false,
		});
		expect(harness.session.messages[0]).toMatchObject({
			role: "compactionSummary",
			summary: expect.stringContaining("model-generated summary"),
		});
		expect(harness.eventsOfType("compaction_start")).toEqual([expect.objectContaining({ reason: "manual" })]);
		expect(harness.eventsOfType("compaction_end")).toEqual([
			expect.objectContaining({
				reason: "manual",
				result: expect.objectContaining({ tokensBefore: result.tokensBefore }),
				aborted: false,
				willRetry: false,
			}),
		]);

		await harness.session.prompt("after compaction");
		expect(harness.session.messages.at(-1)).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "still usable" }],
		});
	});

	it("renders an executing /compact as activity instead of queued work", async () => {
		let releaseCompaction: () => void = () => {};
		const compactionGate = new Promise<void>((resolve) => {
			releaseCompaction = resolve;
		});
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			persistSession: true,
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async () => {
						await compactionGate;
					});
				},
			],
		});
		harnesses.push(harness);
		let releaseTurn: () => void = () => {};
		const turnGate = new Promise<void>((resolve) => {
			releaseTurn = resolve;
		});
		harness.setResponses([
			async () => {
				await turnGate;
				return fauxAssistantMessage("slow response");
			},
			fauxAssistantMessage("model-generated summary"),
			fauxAssistantMessage("model-generated turn summary"),
		]);
		const running = harness.session.prompt("one");
		// Queue the command while the turn streams, then let the turn finish.
		const queued = harness.session.prompt("/compact", { streamingBehavior: "steer" });
		releaseTurn();
		await vi.waitFor(() =>
			expect(harness.session.getSessionActionSnapshot()).toMatchObject({
				queuedCount: 0,
				steering: [],
				followUps: [],
				active: { kind: "session_command", phase: "running", label: "/compact" },
			}),
		);
		expect(harness.session.isSessionActive).toBe(true);
		releaseCompaction();
		await Promise.all([running, queued]);

		const order = harness.events.map((event) => event.type);
		expect(order.indexOf("compaction_start")).toBeGreaterThan(order.indexOf("agent_end"));
		expect(harness.eventsOfType("compaction_start")).toEqual([expect.objectContaining({ reason: "manual" })]);
		expect(harness.eventsOfType("compaction_end")).toEqual([
			expect.objectContaining({ reason: "manual", aborted: false }),
		]);
	});

	it("reschedules a pending post-compaction continuation after successful manual compaction", async () => {
		vi.useFakeTimers();
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "summary from extension",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: { source: "extension" },
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		const internals = harness.session as unknown as {
			_schedulePostCompactionContinue(): void;
			_cancelPostCompactionContinue(): void;
			_postCompactionContinuationScheduled: boolean;
		};
		try {
			await harness.session.prompt("one");
			await harness.session.prompt("two");
			internals._schedulePostCompactionContinue();

			await harness.session.compact();

			expect(internals._postCompactionContinuationScheduled).toBe(true);
		} finally {
			internals._cancelPostCompactionContinue();
		}
	});

	it("treats session-owned queued inputs as queued work after compaction", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "summary from extension",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: { source: "extension" },
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		const internals = harness.session as unknown as {
			_cancelPostCompactionContinue(): void;
			_scheduleAutoRefineAfterCompaction(willContinueAfterCompaction: boolean): void;
		};
		const scheduleAutoRefineSpy = vi.spyOn(internals, "_scheduleAutoRefineAfterCompaction");
		try {
			await harness.session.prompt("one");
			await harness.session.prompt("two");
			// Hold the input in the session-owned follow-up queue across compaction.
			const pause = harness.session.acquireQueuedWorkPause();
			await harness.session.followUp("queued across compaction", undefined, { resumeIfIdle: true });
			expect(harness.session.queuedActionCount).toBe(1);

			await harness.session.compact();

			// Session-owned queued work counts as queued: refine defers to the next
			// turn boundary instead of running before the queued input's turn.
			expect(scheduleAutoRefineSpy).toHaveBeenCalledWith(true);

			pause.release();
		} finally {
			harness.session.clearQueue();
			internals._cancelPostCompactionContinue();
		}
	});

	it("defers post-compaction refine behind a preparing session action", async () => {
		const preparationReached = vi.fn();
		let releasePreparation = () => {};
		const preparationGate = new Promise<void>((resolve) => {
			releasePreparation = resolve;
		});
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async (event) => {
						if (event.prompt !== "preparing across compaction") return;
						preparationReached();
						await preparationGate;
					});
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "summary from extension",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: { source: "extension" },
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("one response"),
			fauxAssistantMessage("two response"),
			fauxAssistantMessage("prepared response"),
		]);
		await harness.session.prompt("one");
		await harness.session.prompt("two");
		await harness.session.followUp("preparing across compaction", undefined, { resumeIfIdle: true });
		await vi.waitFor(() => expect(preparationReached).toHaveBeenCalledOnce());
		const internals = harness.session as unknown as SessionWithCompactionInternals & {
			_cancelPostCompactionContinue(): void;
			_scheduleAutoRefineAfterCompaction(willContinueAfterCompaction: boolean): void;
		};
		const scheduleAutoRefineSpy = vi.spyOn(internals, "_scheduleAutoRefineAfterCompaction");
		try {
			await internals._runAutoCompaction("requested", false);
			expect(scheduleAutoRefineSpy).toHaveBeenCalledWith(true);
		} finally {
			releasePreparation();
			internals._cancelPostCompactionContinue();
		}
		await harness.session.waitForIdle();
	});

	it("keeps prior autonomous continuations when later threshold compaction is skipped", async () => {
		const harness = await createHarness({
			autonomous: {
				enabled: true,
				maxContinuations: 4,
				maxTurns: 100,
				gates: { commands: [failingGateCommand()], maxRetries: 5 },
			},
		});
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as {
			_queueAutonomousContinuationForThresholdCompaction(
				message: AssistantMessage,
			): Promise<AgentMessage | undefined>;
			_clearQueuedAutonomousContinuationsAfterSkippedThresholdCompaction(
				shouldContinueAfterThreshold: boolean,
				queuedMessages: AgentMessage[],
			): void;
			_postCompactionContinuationMessages: AgentMessage[];
		};
		const firstAssistant = createAssistant(harness, { stopReason: "toolUse", totalTokens: 10_000 });
		const secondAssistant = createAssistant(harness, { stopReason: "toolUse", totalTokens: 10_000 });

		const firstQueued = await sessionInternals._queueAutonomousContinuationForThresholdCompaction(firstAssistant);
		const secondQueued = await sessionInternals._queueAutonomousContinuationForThresholdCompaction(secondAssistant);

		expect(firstQueued).toBeDefined();
		expect(secondQueued).toBeDefined();
		expect(harness.session.getAutonomousStatus().continuationsUsed).toBe(2);
		sessionInternals._clearQueuedAutonomousContinuationsAfterSkippedThresholdCompaction(true, [secondQueued!]);

		expect(harness.session.getAutonomousStatus().continuationsUsed).toBe(1);
		expect(sessionInternals._postCompactionContinuationMessages).toEqual([firstQueued]);
		expect(harness.session.getFollowUpMessages()).toHaveLength(1);
	});

	it("clears queued autonomous continuations when threshold compaction is skipped", async () => {
		const harness = await createHarness({
			autonomous: {
				enabled: true,
				maxContinuations: 2,
				maxTurns: 100,
				gates: { commands: [failingGateCommand()], maxRetries: 5 },
			},
			settings: { compaction: { keepRecentTokens: 1 } },
		});
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const successfulAssistant = createAssistant(harness, {
			stopReason: "toolUse",
			totalTokens: 10_000,
			timestamp: Date.now(),
		});
		const toolResult: ToolResultMessage<unknown> = {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "large-context",
			content: [{ type: "text", text: "x".repeat(800_000) }],
			isError: false,
			timestamp: Date.now() + 500,
		};
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() - 1000 },
			successfulAssistant,
			toolResult,
		];

		const compactionNeeded = await sessionInternals._thresholdCompactionNeeded({
			message: successfulAssistant,
			toolResults: [toolResult],
			hasMoreToolCalls: true,
			context: {
				systemPrompt: harness.session.systemPrompt,
				messages: [successfulAssistant, toolResult],
				tools: [],
			},
			newMessages: [successfulAssistant, toolResult],
		});
		expect(compactionNeeded).toBe(true);
		expect(harness.session.getFollowUpMessages()).toHaveLength(1);
		expect(harness.session.getAutonomousStatus().continuationsUsed).toBe(1);

		await sessionInternals._runAutoCompaction("threshold", false);

		expect(harness.session.agent.hasQueuedMessages()).toBe(false);
		expect(harness.session.getAutonomousStatus().continuationsUsed).toBe(0);
	});

	it("emits a warning and persists the outcome outside model context when auto-compaction has nothing to summarize", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		await harness.session.prompt("one");

		const endEvents: Array<{ errorMessage?: string; errorSeverity?: string }> = [];
		harness.session.subscribe((event) => {
			if (event.type === "compaction_end") {
				expect(harness.session.messages.at(-1)).toMatchObject({ customType: "compaction_outcome" });
				endEvents.push({ errorMessage: event.errorMessage, errorSeverity: event.errorSeverity });
			}
		});

		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		await sessionInternals._runAutoCompaction("threshold", false);

		expect(endEvents).toHaveLength(1);
		expect(endEvents[0].errorSeverity).toBe("warning");
		expect(endEvents[0].errorMessage).toContain("Auto-compaction skipped");

		// The unsuccessful outcome is disclosed as a durable custom message that stays out of model context.
		const outcome = harness.session.messages.at(-1);
		expect(outcome).toMatchObject({
			role: "custom",
			customType: "compaction_outcome",
			content: endEvents[0].errorMessage,
			display: true,
			details: { reason: "threshold", outcome: "skipped" },
		});
		expect(harness.session.agent.convertToLlm([outcome!])).toEqual([]);
	});

	it("rolls back failed outcome persistence without breaking the persisted branch", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("persisted response")]);
		await harness.session.prompt("persist this turn");

		const internals = harness.session as unknown as SessionWithCompactionInternals;
		const sessionFile = harness.sessionManager.getSessionFile()!;
		const persistedLeafId = harness.sessionManager.getLeafId();
		const persistedEntries = harness.sessionManager.getEntries();
		vi.spyOn(harness.sessionManager, "_persist").mockImplementationOnce(() => {
			appendFileSync(sessionFile, '{"type":"custom_message"');
			throw new Error("disk full");
		});

		expect(() =>
			internals._persistCompactionOutcome("requested", "failed", "Requested compaction failed"),
		).not.toThrow();
		// The live outcome message discloses that it was not saved.
		expect(harness.session.messages.at(-1)).toMatchObject({
			role: "custom",
			customType: "compaction_outcome",
			content: expect.stringContaining("could not be saved to session history"),
			details: { reason: "requested", outcome: "failed" },
		});
		// In-memory state is fully rolled back: no outcome entry, same leaf and entries.
		expect(harness.sessionManager.getLeafId()).toBe(persistedLeafId);
		expect(harness.sessionManager.getEntries()).toEqual(persistedEntries);

		// The next append attaches to the persisted leaf and rewrites a coherent file.
		const nextId = harness.sessionManager.appendCustomEntry("after_failed_outcome");
		const reloaded = SessionManager.open(sessionFile);
		expect(reloaded.getEntry(nextId)?.parentId).toBe(persistedLeafId);
		expect(reloaded.getBranch().map((entry) => entry.id)).toEqual(
			harness.sessionManager.getBranch().map((entry) => entry.id),
		);
		expect(reloaded.getEntries()).not.toContainEqual(
			expect.objectContaining({ type: "custom_message", customType: "compaction_outcome" }),
		);
		// The unpersisted disclosure survives context rebuilds (e.g. thinking toggle).
		const rebuilt = harness.session.buildSessionContext();
		expect(rebuilt.messages.at(-1)).toMatchObject({
			role: "custom",
			customType: "compaction_outcome",
			content: expect.stringContaining("could not be saved to session history"),
		});

		// Cross a millisecond boundary so the later turn's timestamp is strictly newer.
		await new Promise((resolve) => setTimeout(resolve, 5));
		harness.setResponses([fauxAssistantMessage("later response")]);
		await harness.session.prompt("later turn");
		const reordered = harness.session.buildSessionContext().messages;
		const outcomeIndex = reordered.findIndex(
			(message) => message.role === "custom" && message.customType === "compaction_outcome",
		);
		const laterTurnIndex = reordered.findIndex(
			(message) => message.role === "user" && getMessageText(message).includes("later turn"),
		);
		expect(outcomeIndex).toBeGreaterThanOrEqual(0);
		expect(laterTurnIndex).toBeGreaterThan(outcomeIndex);
	});

	it("keeps an unpersisted outcome in agent state after a successful compaction", async () => {
		const harness = await createHarness({
			persistSession: true,
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "post-failure summary",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: { source: "extension" },
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("one response"), fauxAssistantMessage("two response")]);
		await harness.session.prompt("one");
		await harness.session.prompt("two");

		const internals = harness.session as unknown as SessionWithCompactionInternals;
		vi.spyOn(harness.sessionManager, "_persist").mockImplementationOnce(() => {
			throw new Error("disk full");
		});
		internals._persistCompactionOutcome("requested", "failed", "Requested compaction failed");

		// Compaction reloads agent.state.messages from the session file; the
		// memory-only disclosure must survive.
		await harness.session.compact();

		expect(harness.session.messages).toContainEqual(
			expect.objectContaining({
				role: "custom",
				customType: "compaction_outcome",
				content: expect.stringContaining("could not be saved to session history"),
			}),
		);
	});
});
