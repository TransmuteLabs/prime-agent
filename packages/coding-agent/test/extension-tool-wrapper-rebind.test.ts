import { describe, expect, it } from "vitest";
import type { ExtensionRunner } from "../src/core/extensions/runner.ts";
import type { RegisteredTool } from "../src/core/extensions/types.ts";
import { wrapRegisteredTools } from "../src/core/extensions/wrapper.ts";

const STALE = "This extension ctx is stale after session replacement or reload.";

function makeRunner(id: string): ExtensionRunner & { invalidate(): void } {
	let stale = false;
	return {
		createContext() {
			if (stale) throw new Error(STALE);
			return { id } as unknown as ReturnType<ExtensionRunner["createContext"]>;
		},
		getActiveTools: () => [],
		invalidate() {
			stale = true;
		},
	} as unknown as ExtensionRunner & { invalidate(): void };
}

function toolThatReturnsCtxId(): RegisteredTool {
	return {
		definition: {
			name: "probe",
			label: "probe",
			description: "returns the ctx id",
			parameters: { type: "object", properties: {} } as never,
			execute: async (_id: string, _params: unknown, _signal: AbortSignal, _onUpdate: unknown, ctx: unknown) => ({
				content: [{ type: "text", text: (ctx as { id: string }).id }],
			}),
		},
		sourceInfo: { source: "builtin" },
	} as unknown as RegisteredTool;
}

describe("wrapRegisteredTools runner rebinding", () => {
	it("resolves the current runner at execute time when given a getter", async () => {
		let runner = makeRunner("first");
		const [tool] = wrapRegisteredTools([toolThatReturnsCtxId()], () => runner);

		const first = await tool.execute("c1", {}, new AbortController().signal);
		expect((first.content[0] as { text: string }).text).toBe("first");

		runner.invalidate();
		runner = makeRunner("second");

		const second = await tool.execute("c2", {}, new AbortController().signal);
		expect((second.content[0] as { text: string }).text).toBe("second");
	});

	it("stays wedged on a stale runner when bound to a fixed instance (old behavior)", async () => {
		const runner = makeRunner("only");
		const [tool] = wrapRegisteredTools([toolThatReturnsCtxId()], runner);

		await expect(tool.execute("c1", {}, new AbortController().signal)).resolves.toBeTruthy();

		runner.invalidate();
		// The merged wrapper's execute is async, so the stale-ctx guard surfaces as a rejection.
		await expect(tool.execute("c2", {}, new AbortController().signal)).rejects.toThrow(STALE);
	});
});
