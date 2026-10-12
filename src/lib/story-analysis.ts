import { clampScore } from "./format";
import { analyzeWithGemini, type GeminiStoryResult } from "./gemini";
import { QuotaError } from "./roboflow";
import type {
  AnalysisResult,
  AudioInsights,
  FrameDetections,
  IdeaAnalysis,
  NarrativeSummary,
  SceneCut,
  SectionAnalysis,
  TimestampedNote,
  Transcript,
  VideoMetadata,
  VisualStats,
} from "./types";

const DEFAULT_WEIGHTS = {
  idea: 0.16,
  hook: 0.2,
  pacing: 0.16,
  storytelling: 0.16,
  outcome: 0.16,
  visuals: 0.16,
} as const;

const WEIGHTS_BY_FORMAT: Record<string, Record<string, number>> = {
  reaction: { idea: 0.1, hook: 0.22, pacing: 0.16, storytelling: 0.18, outcome: 0.2, visuals: 0.14 },
  cooking: { idea: 0.16, hook: 0.16, pacing: 0.16, storytelling: 0.12, outcome: 0.18, visuals: 0.22 },
  comedy: { idea: 0.14, hook: 0.22, pacing: 0.2, storytelling: 0.16, outcome: 0.18, visuals: 0.1 },
  educational: { idea: 0.22, hook: 0.16, pacing: 0.14, storytelling: 0.18, outcome: 0.18, visuals: 0.12 },
  commentary: { idea: 0.2, hook: 0.18, pacing: 0.16, storytelling: 0.18, outcome: 0.16, visuals: 0.12 },
  storytelling: { idea: 0.18, hook: 0.18, pacing: 0.16, storytelling: 0.22, outcome: 0.16, visuals: 0.1 },
  vlog: { idea: 0.14, hook: 0.18, pacing: 0.18, storytelling: 0.18, outcome: 0.14, visuals: 0.18 },
};

type Editorial = Omit<
  AnalysisResult,
  | "video"
  | "model"
  | "frames"
  | "visualStats"
  | "transcript"
  | "sceneCuts"
  | "visualChanges"
  | "audio"
  | "subtitles"
  | "warnings"
  | "usage"
>;

function emptySection(explanation: string): SectionAnalysis {
  return { score: null, uncertain: true, explanation, recommendations: [] };
}

function visualOnlyAnalysis(
  stats: VisualStats,
  frames: FrameDetections[],
  sceneCuts: SceneCut[],
  caption: string | undefined,
  missing: string[],
): GeminiStoryResult {
  const hookFrames = frames.filter((frame) => frame.timestamp <= 5);
  const hookClasses = [...new Set(hookFrames.flatMap((frame) => frame.detections.map((d) => d.class)))];
  const recs: TimestampedNote[] = [];
  if (stats.longestLowChangeSpan && stats.longestLowChangeSpan.seconds >= 6) {
    recs.push({
      timestamp: stats.longestLowChangeSpan.start,
      endTimestamp: stats.longestLowChangeSpan.end,
      source: "roboflow",
      kind: "observed",
      text: `Between ${stats.longestLowChangeSpan.start.toFixed(0)}s and ${stats.longestLowChangeSpan.end.toFixed(0)}s, Roboflow class composition changed very little.`,
      why: "Long visually static stretches can feel like the Short has stalled.",
    });
  }
  const visuals: SectionAnalysis = {
    score: null,
    uncertain: true,
    explanation: `Roboflow sampled ${stats.sampledFrameCount} frames. Classes: ${stats.uniqueClasses.join(", ") || "none"}. This is not a Gemini editorial review.`,
    recommendations: recs,
  };
  const idea: IdeaAnalysis = {
    score: null,
    uncertain: true,
    premise: "Language analysis was skipped because Gemini is unavailable.",
    explanation: `Visual-only fallback. Roboflow saw ${stats.uniqueClasses.join(", ") || "no classes"}.`,
    recommendations: [],
  };
  return {
    format: {
      label: "other",
      secondary: [],
      explanation: "Format classification requires Gemini.",
    },
    narrative: {
      premise: idea.premise,
      opening: `Hook-window Roboflow classes: ${hookClasses.join(", ") || "none"}.`,
      retention: `${sceneCuts.length} FFmpeg scene cut(s); ${stats.visualChanges.length} Roboflow composition shift(s).`,
      ending: "Ending payoff was not judged without Gemini.",
    },
    transcript: null,
    idea,
    hook: emptySection(`Hook-window detections: ${hookClasses.join(", ") || "none"}.`),
    pacing: emptySection(`${sceneCuts.length} scene cut(s); ${stats.visualChanges.length} likely visual composition shift(s).`),
    storytelling: emptySection("Storytelling was not judged without Gemini."),
    outcome: emptySection("Payoff was not judged without Gemini."),
    visuals,
    caption: caption ? emptySection("Caption analysis requires Gemini.") : null,
    strengths: [],
    weaknesses: recs.slice(0, 3),
    recommendations: recs.slice(0, 3),
    alternativeHook: null,
    missingEvidence: missing,
    usage: { inputTokens: 0, outputTokens: 0 },
  };
}

function finalize(payload: GeminiStoryResult, missingEvidence: string[]): Editorial {
  const weights = WEIGHTS_BY_FORMAT[payload.format.label] ?? DEFAULT_WEIGHTS;
  const scored = [
    ["idea", payload.idea],
    ["hook", payload.hook],
    ["pacing", payload.pacing],
    ["storytelling", payload.storytelling],
    ["outcome", payload.outcome],
    ["visuals", payload.visuals],
  ] as const;
  let weighted = 0;
  let weightSum = 0;
  for (const [key, section] of scored) {
    if (section.score !== null && !section.uncertain) {
      weighted += section.score * weights[key];
      weightSum += weights[key];
    }
  }
  const overallScore = weightSum > 0 ? clampScore(weighted / weightSum) : null;
  const combined = [
    ...payload.recommendations,
    ...payload.hook.recommendations,
    ...payload.pacing.recommendations,
    ...payload.storytelling.recommendations,
    ...payload.outcome.recommendations,
    ...payload.visuals.recommendations,
  ];
  const seen = new Set<string>();
  const recommendations = combined.filter((item) => {
    const key = `${item.timestamp ?? ""}:${item.text}`;
    if (seen.has(key) || !item.text?.trim()) return false;
    seen.add(key);
    return true;
  });

  return {
    format: payload.format,
    narrative: payload.narrative,
    idea: payload.idea,
    hook: payload.hook,
    pacing: payload.pacing,
    storytelling: payload.storytelling,
    outcome: payload.outcome,
    visuals: payload.visuals,
    caption: payload.caption,
    strengths: payload.strengths,
    weaknesses: payload.weaknesses,
    alternativeHook: payload.alternativeHook,
    missingEvidence,
    recommendations: recommendations.slice(0, 6),
    overall: {
      score: overallScore,
      uncertain: overallScore === null,
      explanation:
        overallScore === null
          ? "Overall score left uncertain because too few categories had enough evidence."
          : `Weighted editorial average for a ${payload.format.label} Short. Not a forecast of views or retention.`,
      weights,
    },
  };
}

export async function analyzeStory(input: {
  video: VideoMetadata;
  frames: FrameDetections[];
  frameImages: { timestamp: number; data: string; mimeType?: string }[];
  stats: VisualStats;
  sceneCuts: SceneCut[];
  audio: AudioInsights | null;
  audioInline?: { mimeType: string; data: string };
  caption?: string;
  warnings: string[];
}): Promise<{
  editorial: Editorial;
  transcript: Transcript | null;
  narrative: NarrativeSummary;
  geminiUsage: { inputTokens: number; outputTokens: number; requests: number };
}> {
  const missing: string[] = [];
  if (!input.video.hasAudio) missing.push("The file has no audio track.");
  if (input.video.hasAudio && !input.audioInline?.data) {
    missing.push("Audio extraction failed, so speech was not sent to Gemini.");
  }
  if (!input.caption) missing.push("No publish caption was provided.");

  const geminiKey = process.env.GEMINI_API_KEY?.trim();
  if (!geminiKey) {
    input.warnings.push(
      "GEMINI_API_KEY is not set. Roboflow detections are real; editorial scores are marked uncertain.",
    );
    missing.push("Gemini editorial analysis was skipped because GEMINI_API_KEY is not set.");
    const fallback = visualOnlyAnalysis(input.stats, input.frames, input.sceneCuts, input.caption, missing);
    return {
      editorial: finalize(fallback, missing),
      transcript: null,
      narrative: fallback.narrative,
      geminiUsage: { inputTokens: 0, outputTokens: 0, requests: 0 },
    };
  }

  try {
    const payload = await analyzeWithGemini(input);
    const mergedMissing = [...missing, ...payload.missingEvidence];
    if (!payload.transcript?.text) {
      mergedMissing.push("No transcript was produced. Spoken lines were not treated as facts.");
    }
    return {
      editorial: finalize(payload, [...new Set(mergedMissing)]),
      transcript: payload.transcript,
      narrative: payload.narrative,
      geminiUsage: {
        inputTokens: payload.usage.inputTokens,
        outputTokens: payload.usage.outputTokens,
        requests: 1,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Gemini analysis failed.";
    if (error instanceof QuotaError) {
      input.warnings.push(message);
    } else {
      input.warnings.push(`Gemini editorial analysis failed: ${message}`);
    }
    missing.push("Gemini editorial analysis did not complete.");
    const fallback = visualOnlyAnalysis(input.stats, input.frames, input.sceneCuts, input.caption, missing);
    return {
      editorial: finalize(fallback, missing),
      transcript: null,
      narrative: fallback.narrative,
      geminiUsage: { inputTokens: 0, outputTokens: 0, requests: 0 },
    };
  }
}
