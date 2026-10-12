import type { AnalysisResult, VisualStats } from "./types";

const PLACEHOLDER = "Editorial scoring requires Gemini. Roboflow detections below are real.";

export function cvOnlyEditorial(stats: VisualStats): Pick<
  AnalysisResult,
  | "format"
  | "narrative"
  | "idea"
  | "hook"
  | "pacing"
  | "storytelling"
  | "outcome"
  | "visuals"
  | "caption"
  | "strengths"
  | "weaknesses"
  | "alternativeHook"
  | "missingEvidence"
  | "recommendations"
  | "overall"
> {
  const visualsNote = `Roboflow sampled ${stats.sampledFrameCount} frames. Classes: ${stats.uniqueClasses.join(", ") || "none"}. ${stats.visualChanges.length} likely composition shift(s) between neighboring samples.`;
  const empty = {
    score: null as number | null,
    uncertain: true,
    explanation: PLACEHOLDER,
    recommendations: [] as AnalysisResult["recommendations"],
  };
  return {
    format: { label: "uncertain", secondary: [], explanation: PLACEHOLDER },
    narrative: {
      premise: PLACEHOLDER,
      opening: PLACEHOLDER,
      retention: PLACEHOLDER,
      ending: PLACEHOLDER,
    },
    idea: { ...empty, premise: PLACEHOLDER },
    hook: empty,
    pacing: empty,
    storytelling: empty,
    outcome: empty,
    visuals: {
      score: null,
      uncertain: true,
      explanation: visualsNote,
      recommendations: stats.visualChanges.map((change) => ({
        timestamp: change.timestamp,
        endTimestamp: change.previousTimestamp,
        source: "roboflow" as const,
        kind: "observed" as const,
        text: `${change.note} Added: ${change.added.join(", ") || "—"}. Removed: ${change.removed.join(", ") || "—"}.`,
      })),
    },
    caption: null,
    strengths: [],
    weaknesses: [],
    alternativeHook: null,
    missingEvidence: ["Gemini editorial analysis is not available for this run."],
    recommendations: [],
    overall: {
      score: null,
      uncertain: true,
      explanation: PLACEHOLDER,
      weights: {},
    },
  };
}
