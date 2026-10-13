import type {
  IdeaAnalysis,
  NarrativeSummary,
  SectionAnalysis,
  TimestampedNote,
  Transcript,
} from "./types";

/** Examples for the model only — not a closed set of allowed labels. */
export const FORMAT_EXAMPLES = [
  "reaction",
  "street_interview",
  "mini_documentary",
  "challenge",
  "product_demo",
  "tutorial",
  "ranking",
  "comedy_skit",
  "cooking",
  "commentary",
  "educational",
  "vlog",
  "storytelling",
] as const;

const MAX_LABEL_LEN = 48;

export function toSnakeCase(value: string) {
  return value
    .trim()
    .replace(/['’]/g, "")
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .toLowerCase();
}

export function normalizeFormatLabel(
  raw: unknown,
): { ok: true; label: string } | { ok: false; reason: "missing" | "empty" | "malformed" } {
  if (raw == null) return { ok: false, reason: "missing" };
  if (typeof raw !== "string") return { ok: false, reason: "malformed" };
  const snake = toSnakeCase(raw);
  if (!snake || snake === "snake_case_format" || snake === "optional_secondary_format") {
    return { ok: false, reason: "empty" };
  }
  if (snake.length > MAX_LABEL_LEN || !/^[a-z][a-z0-9_]*$/.test(snake)) {
    return { ok: false, reason: "malformed" };
  }
  return { ok: true, label: snake };
}

function readFormatRecord(parsed: Record<string, unknown>): Record<string, unknown> {
  if (typeof parsed.format === "string") {
    return { label: parsed.format };
  }
  if (parsed.format && typeof parsed.format === "object") {
    return parsed.format as Record<string, unknown>;
  }
  return {};
}

export type ParsedVideoFormat = {
  label: string;
  secondary: string[];
  explanation: string;
  embeddedContent?: string;
  parseFailure: "missing" | "empty" | "malformed" | null;
};

export function parseVideoFormat(parsed: Record<string, unknown>): ParsedVideoFormat {
  const record = readFormatRecord(parsed);
  const rawLabel = record.label ?? record.name ?? record.type;
  const normalized = normalizeFormatLabel(rawLabel);
  const secondary = Array.isArray(record.secondary)
    ? record.secondary.flatMap((item) => {
        const result = normalizeFormatLabel(item);
        return result.ok ? [result.label] : [];
      })
    : [];
  const explanation =
    typeof record.explanation === "string" && record.explanation.trim()
      ? record.explanation.trim()
      : "";

  if (!normalized.ok) {
    return {
      label: "unclassified",
      secondary,
      explanation: explanation || "Gemini did not return a usable format label.",
      parseFailure: normalized.reason,
    };
  }

  return {
    label: normalized.label,
    secondary: secondary.filter((item) => item !== normalized.label),
    explanation: explanation || (normalized.label === "other" ? "Format could not be determined from the evidence." : ""),
    embeddedContent:
      typeof record.embeddedContent === "string" && record.embeddedContent.trim()
        ? record.embeddedContent.trim()
        : undefined,
    parseFailure: null,
  };
}

export function displayFormatLabel(label: string) {
  return label.replace(/_/g, " ");
}

export class GeminiAnalysisError extends Error {
  finishReason: string;
  constructor(message: string, finishReason = "unknown") {
    super(message);
    this.name = "GeminiAnalysisError";
    this.finishReason = finishReason;
  }
}

export type ParsedGeminiStory = {
  format: {
    label: string;
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
};

function asNotes(value: unknown, field: string): TimestampedNote[] {
  if (!Array.isArray(value)) {
    throw new GeminiAnalysisError(`${field} must be an array.`, "incomplete");
  }
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

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new GeminiAnalysisError(`Gemini JSON is missing ${field}.`, "incomplete");
  }
  return value.trim();
}

function parseScore(value: unknown, field: string): { score: number | null; uncertain: boolean } {
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.uncertain === true || record.score === null) {
      return { score: null, uncertain: true };
    }
    if (typeof record.score === "number" && Number.isFinite(record.score)) {
      return { score: Math.max(1, Math.min(10, record.score)), uncertain: false };
    }
    throw new GeminiAnalysisError(`${field}.score is invalid.`, "incomplete");
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return { score: Math.max(1, Math.min(10, value)), uncertain: false };
  }
  throw new GeminiAnalysisError(`${field} is missing a score object.`, "incomplete");
}

function requireSection(value: unknown, field: string): SectionAnalysis {
  if (!value || typeof value !== "object") {
    throw new GeminiAnalysisError(`Gemini JSON is missing ${field}.`, "incomplete");
  }
  const record = value as Record<string, unknown>;
  const { score, uncertain } = parseScore(record, field);
  return {
    score,
    uncertain,
    explanation: requireText(record.explanation, `${field}.explanation`),
    recommendations: asNotes(record.recommendations ?? [], `${field}.recommendations`),
  };
}

export function buildGeminiStory(parsed: Record<string, unknown>, caption?: string): ParsedGeminiStory {
  const format = parseVideoFormat(parsed);
  if (format.parseFailure) {
    throw new GeminiAnalysisError(
      `Gemini JSON format label was ${format.parseFailure}; incomplete analysis was rejected.`,
      "incomplete",
    );
  }

  const narrativeRecord =
    parsed.narrative && typeof parsed.narrative === "object" ? (parsed.narrative as Record<string, unknown>) : null;
  if (!narrativeRecord) {
    throw new GeminiAnalysisError("Gemini JSON is missing narrative.", "incomplete");
  }

  const idea = requireSection(parsed.idea, "idea");
  const ideaRecord = parsed.idea as Record<string, unknown>;
  const hook = requireSection(parsed.hook, "hook");
  const pacing = requireSection(parsed.pacing, "pacing");
  const storytelling = requireSection(parsed.storytelling, "storytelling");
  const outcome = requireSection(parsed.outcome, "outcome");
  const visuals = requireSection(parsed.visuals, "visuals");
  const strengths = asNotes(parsed.strengths, "strengths");
  const weaknesses = asNotes(parsed.weaknesses, "weaknesses");
  const recommendations = asNotes(parsed.recommendations, "recommendations");

  const scored = [idea, hook, pacing, storytelling, outcome, visuals];
  const hasAnyScore = scored.some((section) => section.score !== null);
  if (!hasAnyScore && strengths.length === 0 && weaknesses.length === 0 && recommendations.length === 0) {
    throw new GeminiAnalysisError(
      "Gemini JSON is missing scores, strengths, weaknesses, and recommendations.",
      "incomplete",
    );
  }

  const transcriptRecord =
    parsed.transcript && typeof parsed.transcript === "object" ? (parsed.transcript as Record<string, unknown>) : null;
  const transcript: Transcript | null =
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
      : null;

  const alternativeRecord =
    parsed.alternativeHook && typeof parsed.alternativeHook === "object"
      ? (parsed.alternativeHook as Record<string, unknown>)
      : null;

  return {
    format: {
      label: format.label,
      secondary: format.secondary,
      explanation: requireText(format.explanation, "format.explanation"),
      embeddedContent: format.embeddedContent,
    },
    narrative: {
      premise: requireText(narrativeRecord.premise || ideaRecord.premise, "narrative.premise"),
      opening: requireText(narrativeRecord.opening, "narrative.opening"),
      retention: requireText(narrativeRecord.retention, "narrative.retention"),
      ending: requireText(narrativeRecord.ending, "narrative.ending"),
      originalVsReaction:
        typeof narrativeRecord.originalVsReaction === "string"
          ? narrativeRecord.originalVsReaction.trim()
          : undefined,
    },
    transcript,
    idea: {
      ...idea,
      premise: requireText(ideaRecord.premise || narrativeRecord.premise, "idea.premise"),
    },
    hook,
    pacing,
    storytelling,
    outcome,
    visuals,
    caption: caption ? requireSection(parsed.caption, "caption") : null,
    strengths: strengths.slice(0, 3),
    weaknesses: weaknesses.slice(0, 3),
    recommendations: recommendations.slice(0, 3),
    alternativeHook:
      alternativeRecord && typeof alternativeRecord.text === "string" && alternativeRecord.text.trim()
        ? {
            text: alternativeRecord.text.trim(),
            why: String(alternativeRecord.why || "").trim(),
          }
        : null,
    missingEvidence: Array.isArray(parsed.missingEvidence)
      ? parsed.missingEvidence.filter((item): item is string => typeof item === "string")
      : [],
  };
}

export function isReusableGeminiCache(story: {
  editorial?: {
    format?: { label?: string };
    idea?: SectionAnalysis;
    hook?: SectionAnalysis;
    pacing?: SectionAnalysis;
    storytelling?: SectionAnalysis;
    outcome?: SectionAnalysis;
    visuals?: SectionAnalysis;
  };
  geminiUsage?: { requests?: number };
}): boolean {
  if (!story || (story.geminiUsage?.requests ?? 0) < 1) return false;
  const editorial = story.editorial;
  if (!editorial?.format?.label || editorial.format.label === "unclassified") return false;
  const sections = [
    editorial.idea,
    editorial.hook,
    editorial.pacing,
    editorial.storytelling,
    editorial.outcome,
    editorial.visuals,
  ];
  return sections.every(
    (section) =>
      Boolean(section?.explanation?.trim()) &&
      !/without Gemini|did not complete|No \w+ analysis was returned/i.test(section!.explanation),
  );
}

