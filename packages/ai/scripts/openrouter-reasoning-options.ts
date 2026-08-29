import type { ThinkingLevel, ThinkingLevelMap } from "../src/types.ts";
import { getEffortThinkingLevelMap } from "./models-dev-reasoning-options.ts";

const THINKING_LEVELS: readonly ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

export interface OpenRouterReasoningMetadata {
	mandatory?: boolean;
	default_enabled?: boolean;
	/** `null` means the route accepts every gateway effort instead of a published subset. */
	supported_efforts?: Array<ThinkingLevel | "none"> | null;
	default_effort?: ThinkingLevel | "none";
}

export interface OpenRouterReasoningCapabilities {
	/** Exact local-to-provider effort map. null entries are unsupported. */
	thinkingLevelMap?: ThinkingLevelMap;
	/** Whether the route exposes effort selection, rather than only an enabled toggle. */
	supportsReasoningEffort: boolean;
	/** Whether the route rejects attempts to disable reasoning. */
	mandatory: boolean;
}

function getEffortMap(reasoning: OpenRouterReasoningMetadata): ThinkingLevelMap | undefined {
	const mandatory = reasoning.mandatory === true;
	const efforts = reasoning.supported_efforts;
	if (efforts === null) {
		const map: ThinkingLevelMap = { off: mandatory ? null : "none" };
		for (const level of THINKING_LEVELS) {
			map[level] = level;
		}
		return map;
	}

	// OpenRouter's supported_efforts uses the same effort values as models.dev reasoning_options,
	// so both sources can share the same Pi thinking-level conversion.
	const map = efforts?.length ? getEffortThinkingLevelMap([{ type: "effort", values: efforts }]) : undefined;
	if (!map) return undefined;
	return { ...map, off: mandatory ? null : "none" };
}

/** The route supports reasoning as an on/off capability without effort selection. */
function toggleOnlyCapabilities(mandatory: boolean): OpenRouterReasoningCapabilities {
	return {
		// One generic active level, so the picker still offers reasoning.
		thinkingLevelMap: {
			...(mandatory ? { off: null } : {}),
			minimal: null,
			low: null,
			medium: null,
			high: "high",
			xhigh: null,
			max: null,
		},
		supportsReasoningEffort: false,
		mandatory,
	};
}

/** Convert OpenRouter's reasoning metadata into Pi model capabilities. */
export function getOpenRouterThinkingLevelMap(
	reasoning: OpenRouterReasoningMetadata | undefined,
): ThinkingLevelMap | undefined {
	if (!reasoning) return undefined;
	return getEffortMap(reasoning) ?? (reasoning.mandatory === true ? { off: null } : undefined);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Full capabilities for one OpenRouter catalog entry. The top-level `reasoning`
 * object over-reports (e.g. qwen3-max carries one despite not accepting reasoning
 * params), so the route's supported_parameters gates it.
 */
export function getOpenRouterReasoningCapabilities(model: unknown): OpenRouterReasoningCapabilities | undefined {
	if (!isRecord(model)) return undefined;
	const supportedParameters = Array.isArray(model.supported_parameters) ? model.supported_parameters : [];
	if (!supportedParameters.includes("reasoning") || !isRecord(model.reasoning)) return undefined;

	const reasoning = model.reasoning as OpenRouterReasoningMetadata;
	const mandatory = reasoning.mandatory === true;
	const thinkingLevelMap = getEffortMap(reasoning);
	if (!thinkingLevelMap) return toggleOnlyCapabilities(mandatory);
	return { thinkingLevelMap, supportsReasoningEffort: true, mandatory };
}
