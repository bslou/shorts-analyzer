"use client";

import type { AnalysisResult } from "@/lib/types";
import { formatTimestamp } from "@/lib/format";

const COLORS = ["#8b7dff", "#5b8cff", "#67e8f9", "#f0abfc", "#86efac", "#fdba74"];

export function DetectionTimeline({
  result,
  onSeek,
  selectedTimestamp,
}: {
  result: AnalysisResult;
  onSeek: (seconds: number) => void;
  selectedTimestamp?: number | null;
}) {
  const classes = result.visualStats.uniqueClasses;
  const duration = Math.max(result.video.duration, 0.01);
  const changes = new Set(result.visualStats.visualChanges.map((change) => change.timestamp));

  return (
    <section className="rounded-2xl border border-border bg-surface p-5">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Roboflow detection timeline</h2>
          <p className="mt-1 text-sm text-muted">
            Shorts Visual Timeline workflow · sampled JPEGs, not every video frame. Click a timestamp
            to inspect that frame.
          </p>
        </div>
        <span className="rounded-full border border-border px-3 py-1 text-xs text-muted">
          {result.visualStats.sampledFrameCount} frames
        </span>
      </div>

      <div className="relative mb-4 h-16 overflow-hidden rounded-xl bg-surface-2">
        {result.frames.map((frame) => {
          const selected = selectedTimestamp === frame.timestamp;
          const changed = changes.has(frame.timestamp);
          return (
            <button
              key={frame.timestamp}
              type="button"
              title={`${formatTimestamp(frame.timestamp)} · ${frame.detections.map((d) => d.class).join(", ") || "none"}`}
              onClick={() => onSeek(frame.timestamp)}
              className={`absolute top-2 h-12 rounded-sm ${
                selected ? "bg-accent" : changed ? "bg-amber-400/50 hover:bg-amber-300/70" : "bg-accent/30 hover:bg-accent/70"
              }`}
              style={{
                left: `${(frame.timestamp / duration) * 100}%`,
                width: `${Math.max(0.8, (result.visualStats.intervalSeconds / duration) * 100)}%`,
              }}
            />
          );
        })}
      </div>
      <p className="mb-4 text-[11px] text-muted">Amber markers are likely composition shifts, not scene cuts.</p>

      <div className="flex flex-wrap gap-2">
        {classes.length === 0 ? (
          <p className="text-sm text-muted">No objects were detected on sampled frames.</p>
        ) : (
          classes.map((name, index) => (
            <span
              key={name}
              className="rounded-full px-3 py-1 text-xs"
              style={{ background: `${COLORS[index % COLORS.length]}22`, color: COLORS[index % COLORS.length] }}
            >
              {name} × {result.visualStats.classCounts[name] ?? 0}
            </span>
          ))
        )}
      </div>

      {result.visualStats.visualChanges.length > 0 ? (
        <ul className="mt-4 space-y-2 text-sm">
          {result.visualStats.visualChanges.map((change) => (
            <li key={`${change.previousTimestamp}-${change.timestamp}`} className="rounded-xl bg-surface-2 px-3 py-2">
              <button className="font-mono text-xs text-accent" onClick={() => onSeek(change.timestamp)}>
                {formatTimestamp(change.previousTimestamp)} → {formatTimestamp(change.timestamp)}
              </button>
              <p className="mt-1 text-zinc-300">{change.note}</p>
              <p className="text-xs text-muted">
                Added {change.added.join(", ") || "—"} · removed {change.removed.join(", ") || "—"}
              </p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-4 text-sm text-muted">
          Neighboring samples did not show a strong composition shift. Individual objects can appear
          or disappear without that being a cut.
        </p>
      )}

      <div className="mt-5 max-h-72 overflow-auto rounded-xl border border-border">
        <table className="w-full text-left text-sm">
          <thead className="sticky top-0 bg-surface-2 text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-3 py-2">Time</th>
              <th className="px-3 py-2">Class</th>
              <th className="px-3 py-2">Confidence</th>
              <th className="px-3 py-2">Center box</th>
            </tr>
          </thead>
          <tbody>
            {result.frames.flatMap((frame) =>
              frame.detections.length === 0
                ? [
                    <tr key={`empty-${frame.timestamp}`} className="border-t border-border/70">
                      <td className="px-3 py-2">
                        <button className="font-mono text-accent" onClick={() => onSeek(frame.timestamp)}>
                          {formatTimestamp(frame.timestamp)}
                        </button>
                      </td>
                      <td className="px-3 py-2 text-muted" colSpan={3}>
                        No detections
                      </td>
                    </tr>,
                  ]
                : frame.detections.map((detection, index) => (
                    <tr key={`${frame.timestamp}-${detection.class}-${index}`} className="border-t border-border/70">
                      <td className="px-3 py-2">
                        <button className="font-mono text-accent" onClick={() => onSeek(frame.timestamp)}>
                          {formatTimestamp(frame.timestamp)}
                        </button>
                      </td>
                      <td className="px-3 py-2">{detection.class}</td>
                      <td className="px-3 py-2">{(detection.confidence * 100).toFixed(1)}%</td>
                      <td className="px-3 py-2 font-mono text-xs text-muted">
                        {Math.round(detection.boundingBox.x)},{Math.round(detection.boundingBox.y)}{" "}
                        {Math.round(detection.boundingBox.width)}×{Math.round(detection.boundingBox.height)}
                      </td>
                    </tr>
                  )),
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
