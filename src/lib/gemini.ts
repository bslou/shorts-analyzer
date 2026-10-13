import { getGeminiConfig } from "./config";
import { stripDataUrl } from "./payload";
import { pickGeminiFrames } from "./pick-frames";
import { QuotaError } from "./roboflow";
import {
  FORMAT_EXAMPLES,
  GeminiAnalysisError,
  buildGeminiStory,
  type ParsedGeminiStory,
} from "./video-format";
import type { AudioInsights, FrameDetections, SceneCut, VideoMetadata, VisualStats } from "./types";

export { GeminiAnalysisError };

export type GeminiStoryResult = ParsedGeminiStory & {
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
};

type GeminiPart = {
  text?: string;
  thought?: boolean;
  inlineData?: unknown;
};

type GeminiResponse = {
  candidates?: Array<{
    content?: { parts?: GeminiPart[]; role?: string };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
    thoughtsTokenCount?: number;
  };
  error?: { message?: string; status?: string; code?: number };
};

const NOTE_SCHEMA = {
  type: "OBJECT",
  properties: {
    timestamp: { type: "NUMBER", description: "Seconds from start when this is observable." },
    endTimestamp: { type: "NUMBER" },
    text: { type: "STRING" },
    why: { type: "STRING" },
    source: { type: "STRING", description: "roboflow, gemini, audio, transcript, or ffmpeg" },
    kind: { type: "STRING", description: "observed or opinion" },
  },
  required: ["text"],
};

const SECTION_SCHEMA = {
  type: "OBJECT",
  properties: {
    score: { type: "NUMBER", nullable: true, description: "Editorial 1-10, or null when uncertain." },
    uncertain: { type: "BOOLEAN" },
    explanation: { type: "STRING" },
    recommendations: { type: "ARRAY", items: NOTE_SCHEMA },
  },
  required: ["score", "uncertain", "explanation", "recommendations"],
};

const IDEA_SCHEMA = {
  type: "OBJECT",
  properties: {
    score: { type: "NUMBER", nullable: true },
    uncertain: { type: "BOOLEAN" },
    premise: { type: "STRING" },
    explanation: { type: "STRING" },
    recommendations: { type: "ARRAY", items: NOTE_SCHEMA },
  },
  required: ["score", "uncertain", "premise", "explanation", "recommendations"],
};

/** OpenAPI-style schema for Gemini responseSchema. Format labels stay open strings. */
export const GEMINI_ANALYSIS_SCHEMA = {
  type: "OBJECT",
  properties: {
    format: {
      type: "OBJECT",
      properties: {
        label: {
          type: "STRING",
          description:
            "Open-ended snake_case format inferred from this video. Not limited to a fixed list. Use other only when the format cannot be determined.",
        },
        secondary: { type: "ARRAY", items: { type: "STRING" } },
        explanation: { type: "STRING" },
        embeddedContent: { type: "STRING" },
      },
      required: ["label", "secondary", "explanation"],
    },
    narrative: {
      type: "OBJECT",
      properties: {
        premise: { type: "STRING" },
        opening: { type: "STRING" },
        retention: { type: "STRING" },
        ending: { type: "STRING" },
        originalVsReaction: { type: "STRING" },
      },
      required: ["premise", "opening", "retention", "ending"],
    },
    transcript: {
      type: "OBJECT",
      nullable: true,
      properties: {
        text: { type: "STRING" },
        language: { type: "STRING" },
        segments: {
          type: "ARRAY",
          items: {
            type: "OBJECT",
            properties: {
              start: { type: "NUMBER" },
              end: { type: "NUMBER" },
              text: { type: "STRING" },
            },
            required: ["start", "end", "text"],
          },
        },
      },
      required: ["text", "segments"],
    },
    idea: IDEA_SCHEMA,
    hook: SECTION_SCHEMA,
    pacing: SECTION_SCHEMA,
    storytelling: SECTION_SCHEMA,
    outcome: SECTION_SCHEMA,
    visuals: SECTION_SCHEMA,
    caption: { ...SECTION_SCHEMA, nullable: true },
    strengths: { type: "ARRAY", items: NOTE_SCHEMA },
    weaknesses: { type: "ARRAY", items: NOTE_SCHEMA },
    recommendations: { type: "ARRAY", items: NOTE_SCHEMA },
    alternativeHook: {
      type: "OBJECT",
      nullable: true,
      properties: {
        text: { type: "STRING" },
        why: { type: "STRING" },
      },
      required: ["text", "why"],
    },
    missingEvidence: { type: "ARRAY", items: { type: "STRING" } },
  },
  required: [
    "format",
    "narrative",
    "idea",
    "hook",
    "pacing",
    "storytelling",
    "outcome",
    "visuals",
    "strengths",
    "weaknesses",
    "recommendations",
    "missingEvidence",
  ],
};

function compactDetections(frames: FrameDetections[]) {
  return frames.map((frame) => ({
    t: Number(frame.timestamp.toFixed(2)),
    detections: frame.detections.slice(0, 10).map((detection) => ({
      class: detection.class,
      confidence: Number(detection.confidence.toFixed(3)),
      x: Math.round(detection.boundingBox.x),
      y: Math.round(detection.boundingBox.y),
      w: Math.round(detection.boundingBox.width),
      h: Math.round(detection.boundingBox.height),
    })),
  }));
}

function logGeminiDebug(info: Record<string, unknown>) {
  if (process.env.NODE_ENV === "production") return;
  console.info("[gemini]", info);
}

const SYSTEM_PROMPT = `You are a YouTube Shorts editor reviewing one video.
Combine Roboflow object detections, sampled frames, audio/transcript, and measured visual changes.
Return JSON that matches the provided response schema.

Accuracy:
- Never invent dialogue, timestamps, objects, or performance statistics.
- Do not predict views or retention percentages.
- Roboflow detections are the only object-detection source. Do not add objects Roboflow did not report.
- You MAY describe visible actions, on-screen text, and people in the JPEG frames you actually received.
- Mark kind "observed" for facts from frames, audio, transcript, or Roboflow. Mark kind "opinion" for editorial judgment.
- If evidence is thin for a category, set uncertain=true and score=null instead of guessing.

Format:
- Assign a primary snake_case format label from this video's visuals, audio/transcript, and structure.
- Examples (not exhaustive): ${FORMAT_EXAMPLES.join(", ")}.
- If none of the examples fit, invent a concise snake_case label that describes the format.
- Use "other" only when the format genuinely cannot be determined from the evidence you received.
- Do not default to reaction, cooking, or other because those words appear in examples.
- If nested or reacted-to footage is present, describe it in embeddedContent.

Evaluation:
- Score idea, hook, pacing, storytelling, payoff (outcome), and visuals using criteria that fit the detected format.
- Infer those criteria from the format (for example a street interview on questions, responses, pacing, and payoff; a reaction on commentary quality and reaction payoff).
- Do not force an unrelated structure onto the video.

Scores are editorial 1-10, not forecasts.
Provide exactly three strengths, three weaknesses, and three editing recommendations when evidence allows; fewer is fine if evidence is thin.
Every important criticism needs a timestamp and something observable.
Each recommendation needs a short "why" explaining the likely viewer effect.
Suggest an alternative opening hook only if the current opening is weak and you can ground the suggestion in what the video actually contains.`;

export async function analyzeWithGemini(input: {
  video: VideoMetadata;
  frames: FrameDetections[];
  frameImages: { timestamp: number; data: string; mimeType?: string }[];
  stats: VisualStats;
  sceneCuts: SceneCut[];
  audio: AudioInsights | null;
  audioInline?: { mimeType: string; data: string };
  caption?: string;
}): Promise<GeminiStoryResult> {
  const config = getGeminiConfig();
  if (!config.apiKey) {
    throw new Error(
      "GEMINI_API_KEY is not set. Add a Google AI Studio key to .env.local for Flash editorial analysis.",
    );
  }

  const extraTimes = [
    ...input.stats.visualChanges.map((change) => change.timestamp),
    ...input.sceneCuts.map((cut) => cut.timestamp),
    input.video.duration,
  ];
  const selected = pickGeminiFrames(input.frameImages, config.maxFrames, extraTimes);
  const imageParts = selected.map((frame) => ({
    text: `Frame at ${frame.timestamp.toFixed(2)}s (JPEG sent to you).`,
    inlineData: {
      mimeType: frame.mimeType || "image/jpeg",
      data: stripDataUrl(frame.data),
    },
  }));

  const parts: Array<Record<string, unknown>> = [
    {
      text: JSON.stringify({
        task: "One structured Shorts editorial review.",
        video: input.video,
        caption: input.caption || null,
        sceneCutsFromFfmpeg: input.sceneCuts,
        audioMeasurements: input.audio,
        visualStatsFromRoboflow: input.stats,
        roboflowDetections: compactDetections(input.frames),
        geminiFrameTimestamps: selected.map((frame) => frame.timestamp),
      }),
    },
  ];

  for (const part of imageParts) {
    parts.push({ text: part.text });
    parts.push({ inlineData: part.inlineData });
  }

  if (input.audioInline?.data) {
    const mimeType = input.audioInline.mimeType || "audio/wav";
    parts.push({
      text: "Complete audio from the Short (full duration, not a snippet). Transcribe speech into transcript.text. If speech is missing or unintelligible, say so in missingEvidence and do not invent lines.",
    });
    parts.push({
      inlineData: {
        mimeType,
        data: stripDataUrl(input.audioInline.data),
      },
    });
  }

  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: "user", parts }],
    generationConfig: {
      temperature: 0.25,
      maxOutputTokens: config.maxOutputTokens,
      responseMimeType: "application/json",
      responseSchema: GEMINI_ANALYSIS_SCHEMA,
    },
  });
  const models = config.model.endsWith("-preview")
    ? [config.model]
    : [config.model, `${config.model}-preview`];
  const urls = models.flatMap((model) => [
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    `https://generativelanguage.googleapis.com/v1/models/${encodeURIComponent(model)}:generateContent`,
  ]);
  let payload: GeminiResponse = {};
  let response: Response | null = null;
  for (const url of urls) {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": config.apiKey,
      },
      body,
    });
    payload = (await response.json()) as GeminiResponse;
    const versionMiss =
      response.status === 404 ||
      /not found for API version|is not found for API version|not supported for generateContent/i.test(
        payload.error?.message || "",
      );
    if (!versionMiss || url === urls[urls.length - 1]) break;
  }
  if (!response) throw new Error("Gemini request failed.");
  const quota =
    response.status === 429 ||
    response.status === 402 ||
    payload.error?.status === "RESOURCE_EXHAUSTED" ||
    payload.error?.code === 429 ||
    /high demand|RESOURCE_EXHAUSTED/i.test(payload.error?.message || "");
  if (quota) {
    throw new QuotaError(
      `Gemini quota or rate limit reached. The app will not retry or switch to a more expensive model. ${payload.error?.message || ""}`.trim(),
    );
  }
  if (!response.ok) {
    throw new Error(payload.error?.message || `Gemini request failed with HTTP ${response.status}.`);
  }

  const candidate = payload.candidates?.[0];
  const finishReason = candidate?.finishReason || "unknown";
  const partSummaries = (candidate?.content?.parts || []).map((part) => {
    if (part.thought) return "thought";
    if (typeof part.text === "string") return `text:${part.text.length}`;
    return Object.keys(part).join(",") || "empty-part";
  });
  const text = (candidate?.content?.parts || []).map((part) => (part.thought ? "" : part.text || "")).join("");
  logGeminiDebug({
    finishReason,
    promptTokenCount: payload.usageMetadata?.promptTokenCount ?? null,
    candidatesTokenCount: payload.usageMetadata?.candidatesTokenCount ?? null,
    thoughtsTokenCount: payload.usageMetadata?.thoughtsTokenCount ?? null,
    totalTokenCount: payload.usageMetadata?.totalTokenCount ?? null,
    candidateCount: payload.candidates?.length ?? 0,
    partKinds: partSummaries,
    textChars: text.length,
    maxOutputTokens: config.maxOutputTokens,
  });

  if (finishReason === "MAX_TOKENS" && !text.trim()) {
    throw new GeminiAnalysisError(
      `Gemini hit the output token limit (${config.maxOutputTokens}) before returning JSON. Increase GEMINI_MAX_OUTPUT_TOKENS.`,
      finishReason,
    );
  }
  if (!text.trim()) {
    throw new GeminiAnalysisError(`Gemini returned an empty analysis (${finishReason}).`, finishReason);
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new GeminiAnalysisError(
      finishReason === "MAX_TOKENS"
        ? `Gemini output was truncated at ${config.maxOutputTokens} tokens (finishReason MAX_TOKENS) and was not valid JSON.`
        : `Gemini returned invalid JSON (finishReason ${finishReason}).`,
      finishReason,
    );
  }

  if (finishReason === "MAX_TOKENS") {
    logGeminiDebug({ finishReason, truncated: true, parsedKeys: Object.keys(parsed) });
  }

  const story = buildGeminiStory(parsed, input.caption);
  return {
    ...story,
    usage: {
      inputTokens: payload.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: payload.usageMetadata?.candidatesTokenCount ?? 0,
    },
  };
}
