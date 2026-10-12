import { detectionsForNote } from "@/lib/roboflow-evidence";
import { formatTimestamp } from "@/lib/format";
import type { AnalysisResult } from "@/lib/types";

export function SourceBadge({
  source,
  kind,
}: {
  source?: string;
  kind?: "observed" | "opinion";
}) {
  const label =
    source === "roboflow"
      ? "Roboflow"
      : source === "gemini"
        ? "Gemini"
        : source === "ffmpeg"
          ? "FFmpeg"
          : source === "transcript" || source === "audio"
            ? "Audio"
            : null;
  return (
    <span className="flex flex-wrap items-center gap-1">
      {label ? (
        <span
          className={`rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wide ${
            source === "roboflow"
              ? "border border-cyan-500/30 bg-cyan-500/10 text-cyan-100"
              : source === "gemini"
                ? "border border-violet-500/30 bg-violet-500/10 text-violet-100"
                : "border border-border text-muted"
          }`}
        >
          {label}
        </span>
      ) : null}
      {kind ? (
        <span className="text-[10px] uppercase tracking-wide text-muted">
          {kind === "observed" ? "observed" : "editorial"}
        </span>
      ) : null}
    </span>
  );
}

export function RoboflowEvidence({
  result,
  timestamp,
  onSeek,
}: {
  result: AnalysisResult;
  timestamp?: number;
  onSeek?: (seconds: number) => void;
}) {
  const evidence = detectionsForNote(result, timestamp);
  if (!evidence) return null;

  return (
    <div className="mt-2 rounded-lg border border-cyan-500/20 bg-cyan-500/5 px-2.5 py-2 text-[11px] leading-5 text-cyan-50/90">
      <p>
        Roboflow sample {formatTimestamp(evidence.timestamp)}
        {evidence.detections.length
          ? `: ${evidence.detections
              .map((item) => `${item.class} ${(item.confidence * 100).toFixed(0)}%`)
              .join(", ")}`
          : ": no objects on this sample"}
        .
      </p>
      {evidence.shifts.slice(0, 1).map((shift) => (
        <p key={`${shift.previousTimestamp}-${shift.timestamp}`} className="mt-1 text-cyan-100/70">
          Composition shift {formatTimestamp(shift.previousTimestamp)}→{formatTimestamp(shift.timestamp)}{" "}
          (object mix changed; not a scene-cut label).
          {onSeek ? (
            <button
              type="button"
              className="ml-1 underline"
              onClick={() => onSeek(shift.timestamp)}
            >
              Inspect
            </button>
          ) : null}
        </p>
      ))}
    </div>
  );
}
