import { getGeminiConfig } from "./config";
import { stripDataUrl } from "./payload";
import { pickGeminiFrames } from "./pick-frames";
import { QuotaError } from "./roboflow";
import type {
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

export const VIDEO_FORMATS = [
  "reaction",
  "cooking",
  "comedy",
  "storytelling",
  "commentary",
  "educational",
  "vlog",
  "other",
] as const;

export type VideoFormatLabel = (typeof VIDEO_FORMATS)[number];

export type GeminiStoryResult = {
  format: {
    label: VideoFormatLabel;
    secondary: string[];
    explanation: string;
    embeddedContent?: string;
  };
  narrative: NarrativeSummary;
  transcript: Transcript | null;
  idea: IdeaAnalysis;
  hook: SectionAnalysis;
  pacing: SectionAnalysis;
  storytelling: SectionAnalysis;
  outcome: SectionAnalysis;
  visuals: SectionAnalysis;
  caption: SectionAnalysis | null;
  strengths: TimestampedNote[];
  weaknesses: TimestampedNote[];
  recommendations: TimestampedNote[];
  alternativeHook: { text: string; why: string } | null;
  missingEvidence: string[];
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
};

type GeminiResponse = {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
  };
  error?: { message?: string; status?: string; code?: number };
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

function asNotes(value: unknown): TimestampedNote[] {
  if (!Array.isArray(value)) return [];
  const notes: TimestampedNote[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const text = typeof record.text === "string" ? record.text.trim() : "";
    if (!text) continue;
    const note: TimestampedNote = { text };
    if (typeof record.timestamp === "number") note.timestamp = record.timestamp;
    if (typeof record.endTimestamp === "number") note.endTimestamp = record.endTimestamp;
    if (typeof record.why === "string" && record.why.trim()) note.why = record.why.trim();
    if (
      record.source === "roboflow" ||
      record.source === "gemini" ||
      record.source === "audio" ||
      record.source === "transcript" ||
      record.source === "ffmpeg"
    ) {
      note.source = record.source;
    }
    if (record.kind === "observed" || record.kind === "opinion") note.kind = record.kind;
    notes.push(note);
  }
  return notes;
}

function parseScore(value: unknown): { score: number | null; uncertain: boolean } {
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.uncertain === true || record.score === null) {
      return { score: null, uncertain: true };
    }
    if (typeof record.score === "number" && Number.isFinite(record.score)) {
      return { score: Math.max(1, Math.min(10, record.score)), uncertain: false };
    }
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return { score: Math.max(1, Math.min(10, value)), uncertain: false };
  }
  return { score: null, uncertain: true };
}

function normalizeSection(value: unknown, fallback: string): SectionAnalysis {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const { score, uncertain } = parseScore(record);
  return {
    score,
    uncertain: uncertain || !String(record.explanation || "").trim(),
    explanation: typeof record.explanation === "string" && record.explanation.trim() ? record.explanation.trim() : fallback,
    recommendations: asNotes(record.recommendations),
  };
}

const SYSTEM_PROMPT = `You are a YouTube Shorts editor reviewing one video.
Combine Roboflow object detections, sampled frames, audio/transcript, and measured visual changes.
Return JSON only.

Accuracy:
- Never invent dialogue, timestamps, objects, or performance statistics.
- Do not predict views or retention percentages.
- Roboflow detections are the only object-detection source. Do not add objects Roboflow did not report.
- You MAY describe visible actions, on-screen text, and people in the JPEG frames you actually received.
- Mark kind "observed" for facts from frames, audio, transcript, or Roboflow. Mark kind "opinion" for editorial judgment.
- If evidence is thin for a category, set uncertain=true and score=null instead of guessing.

Format:
- Choose a primary format and optional secondary formats from: reaction, cooking, comedy, storytelling, commentary, educational, vlog, other.
- Do not call a reaction video a cooking tutorial just because food appears inside embedded footage.
- If someone is reacting to another creator's clip, say so in embeddedContent and originalVsReaction.

Evaluation must match the format:
- Reaction: context setup, commentary quality, humor, whether the reaction payoff lands.
- Cooking: clarity of the process, visual appetizing quality, whether the result is shown.
- Comedy: setup/punchline timing, not tutorial structure.
- Educational/commentary: claim, evidence, takeaway.

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
        jsonShape: {
          format: {
            label: "reaction",
            secondary: ["commentary"],
            explanation: "why this format",
            embeddedContent: "optional description of nested footage",
          },
          narrative: {
            premise: "",
            opening: "",
            retention: "",
            ending: "",
            originalVsReaction: "",
          },
          transcript: { text: "", language: "en", segments: [{ start: 0, end: 1, text: "" }] },
          idea: { score: 7, uncertain: false, premise: "", explanation: "", recommendations: [] },
          hook: { score: 7, uncertain: false, explanation: "", recommendations: [] },
          pacing: { score: 7, uncertain: false, explanation: "", recommendations: [] },
          storytelling: { score: 7, uncertain: false, explanation: "", recommendations: [] },
          outcome: { score: 7, uncertain: false, explanation: "", recommendations: [] },
          visuals: { score: 7, uncertain: false, explanation: "", recommendations: [] },
          caption: { score: 7, uncertain: false, explanation: "", recommendations: [] },
          strengths: [{ timestamp: 0, text: "", why: "", source: "gemini", kind: "opinion" }],
          weaknesses: [{ timestamp: 0, text: "", why: "", source: "gemini", kind: "opinion" }],
          recommendations: [{ timestamp: 0, text: "", why: "", source: "gemini", kind: "opinion" }],
          alternativeHook: { text: "", why: "" },
          missingEvidence: ["if audio failed, say so"],
        },
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

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.model)}:generateContent`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": config.apiKey,
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: "user", parts }],
      generationConfig: {
        temperature: 0.25,
        maxOutputTokens: config.maxOutputTokens,
        responseMimeType: "application/json",
      },
    }),
  });

  const payload = (await response.json()) as GeminiResponse;
  const quota =
    response.status === 429 ||
    response.status === 402 ||
    payload.error?.status === "RESOURCE_EXHAUSTED" ||
    payload.error?.code === 429;
  if (quota) {
    throw new QuotaError(
      `Gemini quota or rate limit reached. The app will not retry or switch to a more expensive model. ${payload.error?.message || ""}`.trim(),
    );
  }
  if (!response.ok) {
    throw new Error(payload.error?.message || `Gemini request failed with HTTP ${response.status}.`);
  }

  const text = payload.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("") || "";
  if (!text) {
    throw new Error(
      `Gemini returned an empty analysis (${payload.candidates?.[0]?.finishReason || "no finish reason"}).`,
    );
  }

  const parsed = JSON.parse(text) as Record<string, unknown>;
  const formatRecord = parsed.format && typeof parsed.format === "object" ? (parsed.format as Record<string, unknown>) : {};
  const formatLabel = VIDEO_FORMATS.includes(formatRecord.label as VideoFormatLabel)
    ? (formatRecord.label as VideoFormatLabel)
    : "other";
  const secondary = Array.isArray(formatRecord.secondary)
    ? formatRecord.secondary.filter((item): item is string => typeof item === "string")
    : [];
  const narrativeRecord =
    parsed.narrative && typeof parsed.narrative === "object" ? (parsed.narrative as Record<string, unknown>) : {};
  const ideaRecord = parsed.idea && typeof parsed.idea === "object" ? (parsed.idea as Record<string, unknown>) : {};
  const transcriptRecord =
    parsed.transcript && typeof parsed.transcript === "object" ? (parsed.transcript as Record<string, unknown>) : null;

  return {
    format: {
      label: formatLabel,
      secondary,
      explanation:
        typeof formatRecord.explanation === "string" && formatRecord.explanation.trim()
          ? formatRecord.explanation.trim()
          : "Format was not clearly stated.",
      embeddedContent:
        typeof formatRecord.embeddedContent === "string" ? formatRecord.embeddedContent.trim() : undefined,
    },
    narrative: {
      premise: String(narrativeRecord.premise || ideaRecord.premise || "").trim() || "The model did not state a premise.",
      opening: String(narrativeRecord.opening || "").trim() || "Opening was not described.",
      retention: String(narrativeRecord.retention || "").trim() || "What keeps viewers watching was not described.",
      ending: String(narrativeRecord.ending || "").trim() || "Ending was not described.",
      originalVsReaction:
        typeof narrativeRecord.originalVsReaction === "string"
          ? narrativeRecord.originalVsReaction.trim()
          : undefined,
    },
    transcript:
      transcriptRecord && typeof transcriptRecord.text === "string" && transcriptRecord.text.trim()
        ? {
            text: transcriptRecord.text.trim(),
            language: typeof transcriptRecord.language === "string" ? transcriptRecord.language : undefined,
            segments: Array.isArray(transcriptRecord.segments)
              ? transcriptRecord.segments.flatMap((item) => {
                  if (!item || typeof item !== "object") return [];
                  const record = item as Record<string, unknown>;
                  if (typeof record.text !== "string") return [];
                  return [
                    {
                      start: typeof record.start === "number" ? record.start : 0,
                      end: typeof record.end === "number" ? record.end : 0,
                      text: record.text,
                    },
                  ];
                })
              : [],
          }
        : null,
    idea: {
      ...normalizeSection(parsed.idea, "No idea analysis was returned."),
      premise: String(ideaRecord.premise || narrativeRecord.premise || "").trim() || "The model did not state a premise.",
    },
    hook: normalizeSection(parsed.hook, "No hook analysis was returned."),
    pacing: normalizeSection(parsed.pacing, "No pacing analysis was returned."),
    storytelling: normalizeSection(parsed.storytelling, "No storytelling analysis was returned."),
    outcome: normalizeSection(parsed.outcome, "No payoff analysis was returned."),
    visuals: normalizeSection(parsed.visuals, "No visual analysis was returned."),
    caption: input.caption
      ? normalizeSection(parsed.caption, "Caption was provided but not analyzed.")
      : null,
    strengths: asNotes(parsed.strengths).slice(0, 3),
    weaknesses: asNotes(parsed.weaknesses).slice(0, 3),
    recommendations: asNotes(parsed.recommendations).slice(0, 3),
    alternativeHook:
      parsed.alternativeHook &&
      typeof parsed.alternativeHook === "object" &&
      typeof (parsed.alternativeHook as Record<string, unknown>).text === "string" &&
      String((parsed.alternativeHook as Record<string, unknown>).text).trim()
        ? {
            text: String((parsed.alternativeHook as Record<string, unknown>).text).trim(),
            why: String((parsed.alternativeHook as Record<string, unknown>).why || "").trim(),
          }
        : null,
    missingEvidence: Array.isArray(parsed.missingEvidence)
      ? parsed.missingEvidence.filter((item): item is string => typeof item === "string")
      : [],
    usage: {
      inputTokens: payload.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: payload.usageMetadata?.candidatesTokenCount ?? 0,
    },
  };
}
