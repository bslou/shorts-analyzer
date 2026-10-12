export type BoundingBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type Detection = {
  class: string;
  classId?: number;
  confidence: number;
  boundingBox: BoundingBox;
};

export type FrameDetections = {
  timestamp: number;
  framePath?: string;
  frameImage?: string;
  imageWidth: number;
  imageHeight: number;
  inferenceId?: string;
  detections: Detection[];
};

export type VisualChange = {
  timestamp: number;
  previousTimestamp: number;
  added: string[];
  removed: string[];
  similarity: number;
  note: string;
};

export type VideoMetadata = {
  duration: number;
  width: number;
  height: number;
  frameRate: number;
  hasAudio: boolean;
  codec?: string;
  fileName: string;
};

export type TranscriptSegment = {
  start: number;
  end: number;
  text: string;
};

export type Transcript = {
  text: string;
  language?: string;
  segments: TranscriptSegment[];
};

export type SceneCut = {
  timestamp: number;
  score: number;
};

export type AudioInsights = {
  implemented: true;
  hasAudio: boolean;
  meanVolumeDb: number | null;
  maxVolumeDb: number | null;
  silenceRanges: { start: number; end: number }[];
  notes: string;
};

export type EvidenceSource = "roboflow" | "gemini" | "audio" | "transcript" | "ffmpeg";

export type TimestampedNote = {
  timestamp?: number;
  endTimestamp?: number;
  text: string;
  why?: string;
  source?: EvidenceSource;
  kind?: "observed" | "opinion";
};

export type SectionAnalysis = {
  score: number | null;
  uncertain: boolean;
  explanation: string;
  recommendations: TimestampedNote[];
};

export type IdeaAnalysis = SectionAnalysis & {
  premise: string;
};

export type VideoFormat = {
  label: string;
  secondary: string[];
  explanation: string;
  embeddedContent?: string;
};

export type NarrativeSummary = {
  premise: string;
  opening: string;
  retention: string;
  ending: string;
  originalVsReaction?: string;
};

export type CostLine = {
  usd: number;
  source: "actual-tokens" | "estimate" | "cached" | "free-tier";
  label: string;
};

export type UsageReport = {
  roboflowCalls: number;
  roboflowCachedFrames: number;
  roboflowCreditsEstimate: number;
  roboflowUsd: CostLine;
  geminiRequests: number;
  geminiInputTokens: number;
  geminiOutputTokens: number;
  geminiUsd: CostLine;
  totalUsd: number;
  softBudgetUsd: number;
  overBudget: boolean;
  geminiModel: string;
  sampledFrames: number;
  geminiFrames: number;
  notes: string[];
};

export type AnalysisResult = {
  video: VideoMetadata;
  model: {
    provider: "roboflow";
    endpoint: string;
    modelId: string;
  };
  frames: FrameDetections[];
  visualStats: VisualStats;
  transcript: Transcript | null;
  sceneCuts: SceneCut[];
  visualChanges: VisualChange[];
  audio: AudioInsights | null;
  format: VideoFormat;
  narrative: NarrativeSummary;
  idea: IdeaAnalysis;
  hook: SectionAnalysis;
  pacing: SectionAnalysis;
  storytelling: SectionAnalysis;
  outcome: SectionAnalysis;
  visuals: SectionAnalysis;
  caption: SectionAnalysis | null;
  strengths: TimestampedNote[];
  weaknesses: TimestampedNote[];
  alternativeHook: { text: string; why: string } | null;
  missingEvidence: string[];
  subtitles: {
    implemented: false;
    status: "future";
    note: string;
  };
  overall: {
    score: number | null;
    uncertain: boolean;
    explanation: string;
    weights: Record<string, number>;
  };
  recommendations: TimestampedNote[];
  warnings: string[];
  usage: UsageReport;
};

export type VisualStats = {
  sampledFrameCount: number;
  intervalSeconds: number;
  uniqueClasses: string[];
  classCounts: Record<string, number>;
  detectionsPerFrame: number[];
  visualChanges: VisualChange[];
  longestLowChangeSpan: { start: number; end: number; seconds: number } | null;
};

export type BudgetEstimate = {
  roboflowUsd: number;
  geminiUsd: number;
  totalUsd: number;
  softBudgetUsd: number;
  roboflowFrames: number;
  geminiFrames: number;
  notes: string[];
};

export type ProgressEvent =
  | { type: "stage"; stage: AnalysisStage; message: string }
  | { type: "progress"; stage: AnalysisStage; completed: number; total: number }
  | { type: "error"; stage: AnalysisStage; message: string; code?: "budget"; estimate?: BudgetEstimate }
  | { type: "complete"; result: AnalysisResult };

export type AnalysisStage =
  | "uploading"
  | "validating"
  | "extracting_frames"
  | "roboflow"
  | "transcribing"
  | "analyzing_story"
  | "generating_recommendations"
  | "preparing_results";
