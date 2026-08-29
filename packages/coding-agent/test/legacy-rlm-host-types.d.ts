import type { CreateRlmSubagentRuntimeOptions, RlmSubagentRuntime } from "../src/core/rlm-runtime.ts";

declare module "../src/core/rlm-runtime.ts" {
	interface SubagentRuntimeHost {
		releaseRlmSubagentRuntime?: (
			runtime: RlmSubagentRuntime,
			options: CreateRlmSubagentRuntimeOptions,
			status: "done" | "error" | "cancelled",
		) => Promise<void>;
	}
}
