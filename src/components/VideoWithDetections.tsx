"use client";

import { useEffect, useMemo } from "react";
import { nearestFrame } from "@/lib/roboflow-evidence";
import type { AnalysisResult } from "@/lib/types";
import { formatTimestamp } from "@/lib/format";
import { BoundingBoxes } from "./BoundingBoxes";

export function VideoWithDetections({
  result,
  videoUrl,
  playerRef,
  inspectTimestamp,
  onTimeChange,
}: {
  result: AnalysisResult;
  videoUrl: string | null;
  playerRef: React.RefObject<HTMLVideoElement | null>;
  inspectTimestamp: number;
  onTimeChange: (seconds: number) => void;
}) {
  const frame = useMemo(() => nearestFrame(result, inspectTimestamp), [result, inspectTimestamp]);
  const poster = result.frames[0]?.frameImage;

  useEffect(() => {
    const video = playerRef.current;
    if (!video) return;
    const sync = () => onTimeChange(video.currentTime);
    video.addEventListener("timeupdate", sync);
    video.addEventListener("seeked", sync);
    return () => {
      video.removeEventListener("timeupdate", sync);
      video.removeEventListener("seeked", sync);
    };
  }, [playerRef, videoUrl, onTimeChange]);

  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <div className="mb-3 flex items-end justify-between gap-3">
        <div>
          <p className="text-[11px] uppercase tracking-[0.16em] text-muted">Session video</p>
          <h2 className="mt-1 text-sm font-semibold leading-5">{result.video.fileName}</h2>
          <p className="mt-1 text-xs text-muted">
            {formatTimestamp(result.video.duration)} · {result.video.width}×{result.video.height}
          </p>
        </div>
        <span className="rounded-full border border-border px-2 py-1 font-mono text-[10px] text-accent">
          Roboflow
        </span>
      </div>

      <div className="space-y-3">
        <div className="relative overflow-hidden rounded-xl bg-zinc-950">
          {videoUrl ? (
            <video
              ref={playerRef}
              src={videoUrl}
              poster={poster}
              controls
              playsInline
              preload="metadata"
              className="block aspect-9/16 w-full object-contain"
            />
          ) : (
            <div className="aspect-9/16 grid place-items-center px-6 text-center text-sm text-muted">
              The original MP4 is not in this browser session. Re-select the file on Upload — cached
              analysis will load without new API calls.
            </div>
          )}
        </div>

        {frame ? (
          <div>
            <p className="mb-2 text-xs text-muted">
              Inspector {formatTimestamp(frame.timestamp)} · {frame.detections.length}{" "}
              {frame.detections.length === 1 ? "Roboflow detection" : "Roboflow detections"}
            </p>
            <div className="relative overflow-hidden rounded-xl bg-zinc-950">
              {frame.frameImage ? (
                <>
                  {/* Sampled JPEG data URLs, not hosted assets. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={frame.frameImage}
                    alt={`Roboflow frame at ${formatTimestamp(frame.timestamp)}`}
                    className="block w-full"
                  />
                  <div className="pointer-events-none absolute inset-0">
                    <BoundingBoxes
                      detections={frame.detections}
                      imageWidth={frame.imageWidth}
                      imageHeight={frame.imageHeight}
                    />
                  </div>
                </>
              ) : (
                <div className="aspect-9/16 grid place-items-center text-xs text-muted">
                  No JPEG stored for this sample.
                </div>
              )}
            </div>
            {frame.detections.length > 0 ? (
              <p className="mt-2 text-[11px] leading-5 text-muted">
                {frame.detections
                  .slice(0, 5)
                  .map((detection) => `${detection.class} ${(detection.confidence * 100).toFixed(0)}%`)
                  .join(" · ")}
              </p>
            ) : (
              <p className="mt-2 text-[11px] text-muted">Roboflow reported no objects on this sample.</p>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
