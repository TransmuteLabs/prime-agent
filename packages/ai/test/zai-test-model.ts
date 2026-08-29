import { getModels } from "../src/compat.ts";
import type { Model } from "../src/types.ts";

const ZAI_TEST_MODEL_PREFERENCE = ["glm-5.2", "glm-5-turbo", "glm-4.7"];

export function getZaiTestModel(
	options: { toolStream?: boolean; smallestContextWindow?: boolean } = {},
): Model<"openai-completions"> {
	const models = getModels("zai") as Model<"openai-completions">[];
	const eligible = options.toolStream ? models.filter((model) => model.compat?.zaiToolStream) : models;
	if (eligible.length === 0) {
		throw new Error(`No ${options.toolStream ? "tool_stream-capable " : ""}z.ai model is available`);
	}
	if (options.smallestContextWindow) {
		return eligible.reduce((smallest, candidate) =>
			candidate.contextWindow < smallest.contextWindow ? candidate : smallest,
		);
	}
	for (const id of ZAI_TEST_MODEL_PREFERENCE) {
		const model = eligible.find((candidate) => candidate.id === id);
		if (model) return model;
	}
	return eligible[0];
}
