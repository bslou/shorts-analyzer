"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { detectionsInWindow, nearestFrame } from "@/lib/roboflow-evidence";
import { SCORE_CATEGORIES, scoreBreakdown, sectionFor } from "@/lib/score-math";
import type { AnalysisResult, TimestampedNote } from "@/lib/types";
import { formatTimestamp } from "@/lib/format";
import { DetectionTimeline } from "./DetectionTimeline";
import { RoboflowEvidence, SourceBadge } from "./RoboflowEvidence";
import { ScoreRing } from "./ScoreRing";
import { SectionCard } from "./SectionCard";
import { VideoWithDetections } from "./VideoWithDetections";

function NoteList({
  title,
  items,
  result,
  onSeek,
}: {
  title: string;
  items: TimestampedNote[];
  result: AnalysisResult;
  onSeek: (seconds: number) => void;
}) {
  return (
    <section className="rounded-2xl border border-border bg-surface p-5">
      <h2 className="text-base font-semibold">{title}</h2>
      {items.length === 0 ? (
        <p className="mt-3 text-sm text-muted">None with enough evidence to report.</p>
      ) : (
        <ul className="mt-4 space-y-3">
          {items.map((item, index) => (
            <li key={`${item.text}-${index}`} className="rounded-xl bg-surface-2 px-3 py-3">
              <div className="flex flex-wrap items-center gap-2">
                {item.timestamp !== undefined ? (
                  <button
                    type="button"
                    className="font-mono text-xs text-accent hover:underline"
                    onClick={() => onSeek(item.timestamp!)}
                  >
                    {formatTimestamp(item.timestamp)}
                    {item.endTimestamp !== undefined ? `–${formatTimestamp(item.endTimestamp)}` : ""}
                  </button>
                ) : null}
                <SourceBadge source={item.source} kind={item.kind} />
              </div>
              <p className="mt-2 text-sm leading-6 text-zinc-200">{item.text}</p>
              {item.why ? <p className="mt-1 text-xs leading-5 text-muted">{item.why}</p> : null}
              <RoboflowEvidence result={result} timestamp={item.timestamp} onSeek={onSeek} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function AnalysisDashboard({
  result,
  videoUrl,
}: {
  result: AnalysisResult;
  videoUrl: string | null;
}) {
  const playerRef = useRef<HTMLVideoElement>(null);
  const [inspectTimestamp, setInspectTimestamp] = useState(result.frames[0]?.timestamp ?? 0);
  const breakdown = useMemo(() => scoreBreakdown(result), [result]);
  const selectedFrame = nearestFrame(result, inspectTimestamp);

  const seek = useCallback((seconds: number) => {
    setInspectTimestamp(seconds);
    const video = playerRef.current;
    if (!video) return;
    const apply = () => {
      video.currentTime = seconds;
    };
    if (video.readyState >= 1) apply();
    else video.addEventListener("loadedmetadata", apply, { once: true });
  }, []);

  const hookWindow = detectionsInWindow(result, 0, Math.min(5, result.video.duration));
  const endStart = Math.max(0, result.video.duration - 4);
  const endWindow = detectionsInWindow(result, endStart, result.video.duration);

  return (
    <div className="mx-auto grid max-w-7xl gap-6 px-5 py-6 lg:grid-cols-[minmax(280px,380px)_minmax(0,1fr)]">
      <aside className="space-y-4 lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:self-start lg:overflow-y-auto">
        <VideoWithDetections
          result={result}
          videoUrl={videoUrl}
          playerRef={playerRef}
          inspectTimestamp={inspectTimestamp}
          onTimeChange={setInspectTimestamp}
        />
        <section className="rounded-2xl border border-border bg-surface px-4 py-3 text-xs leading-5 text-muted">
          <p className="text-[11px] uppercase tracking-[0.14em] text-zinc-400">Estimated cost</p>
          <p className="mt-2 text-zinc-200">
            Roboflow ${(result.usage.roboflowUsd?.usd ?? 0).toFixed(4)}{" "}
            <span className="text-muted">({result.usage.roboflowUsd?.label ?? "unavailable"})</span>
          </p>
          <p className="text-zinc-200">
            Gemini ${(result.usage.geminiUsd?.usd ?? 0).toFixed(4)}{" "}
            <span className="text-muted">({result.usage.geminiUsd?.label ?? "unavailable"})</span>
          </p>
          <p className="mt-1 font-medium text-foreground">
            Total ${(result.usage.totalUsd ?? 0).toFixed(4)}
            {result.usage.overBudget ? " · over soft budget" : ""}
          </p>
          <p className="mt-2">
            {result.usage.sampledFrames ?? result.frames.length} Roboflow samples ·{" "}
            {result.usage.geminiFrames ?? "—"} Gemini frames · {result.usage.geminiModel || "Flash"}
          </p>
          {result.usage.roboflowCachedFrames ? (
            <p className="mt-1">Roboflow cache hit: {result.usage.roboflowCachedFrames} frames, no new calls.</p>
          ) : (
            <p className="mt-1">{result.usage.roboflowCalls} Roboflow Workflow calls this run.</p>
          )}
          {result.usage.geminiRequests === 0 ? (
            <p>Gemini cache hit or skipped.</p>
          ) : (
            <p>
              Gemini tokens (actual): {result.usage.geminiInputTokens} in / {result.usage.geminiOutputTokens} out.
              Free-tier credits may cover list-price estimates.
            </p>
          )}
        </section>
      </aside>

      <div className="space-y-4">
        {result.warnings.length > 0 ? (
          <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-100">
            {result.warnings.map((warning) => (
              <p key={warning}>{warning}</p>
            ))}
          </div>
        ) : null}

        <section className="rounded-2xl border border-border bg-surface p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0 max-w-2xl">
              <p className="text-[11px] uppercase tracking-[0.16em] text-muted">Detected format</p>
              <h1 className="mt-2 text-2xl font-semibold capitalize">{result.format.label}</h1>
              {result.format.secondary.length > 0 ? (
                <p className="mt-1 text-sm text-muted">Also: {result.format.secondary.join(", ")}</p>
              ) : null}
              <p className="mt-3 text-sm leading-6 text-zinc-300">{result.format.explanation}</p>
              {result.format.embeddedContent ? (
                <p className="mt-2 text-sm leading-6 text-zinc-400">{result.format.embeddedContent}</p>
              ) : null}
            </div>
            <ScoreRing score={breakdown.overall} label="Overall" uncertain={breakdown.overall === null} />
          </div>

          <div className="mt-5 overflow-hidden rounded-xl border border-border">
            <table className="w-full text-left text-sm">
              <thead className="bg-surface-2 text-[11px] uppercase tracking-[0.12em] text-muted">
                <tr>
                  <th className="px-3 py-2 font-medium">Category</th>
                  <th className="px-3 py-2 font-medium">Score</th>
                  <th className="px-3 py-2 font-medium">Weight</th>
                  <th className="px-3 py-2 font-medium">Points</th>
                </tr>
              </thead>
              <tbody>
                {breakdown.rows.map((row) => (
                  <tr key={row.key} className="border-t border-border/80">
                    <td className="px-3 py-2 text-zinc-200">{row.label}</td>
                    <td className="px-3 py-2 font-mono text-xs">
                      {row.included ? row.score?.toFixed(1) : "—"}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-muted">
                      {(row.weight * 100).toFixed(0)}%
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-muted">
                      {row.included && breakdown.weightSum
                        ? ((row.contribution / breakdown.weightSum) * 10).toFixed(2)
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs leading-5 text-muted">
            Overall is a weighted average of scored categories for a {result.format.label} Short
            {breakdown.overall !== null ? ` (${breakdown.overall.toFixed(1)})` : ""}. Uncertain
            categories are omitted. This is editorial judgment, not a prediction of views, retention,
            or virality.
          </p>
        </section>

        <section className="rounded-2xl border border-border bg-surface p-5">
          <h2 className="text-base font-semibold">What the video is doing</h2>
          <dl className="mt-4 grid gap-4 text-sm md:grid-cols-2">
            <div>
              <dt className="text-[11px] uppercase tracking-[0.12em] text-muted">Premise</dt>
              <dd className="mt-1 leading-6 text-zinc-200">{result.narrative.premise}</dd>
            </div>
            <div>
              <dt className="text-[11px] uppercase tracking-[0.12em] text-muted">Opening</dt>
              <dd className="mt-1 leading-6 text-zinc-200">{result.narrative.opening}</dd>
            </div>
            <div>
              <dt className="text-[11px] uppercase tracking-[0.12em] text-muted">Why it might hold attention</dt>
              <dd className="mt-1 leading-6 text-zinc-200">{result.narrative.retention}</dd>
            </div>
            <div>
              <dt className="text-[11px] uppercase tracking-[0.12em] text-muted">Ending</dt>
              <dd className="mt-1 leading-6 text-zinc-200">{result.narrative.ending}</dd>
            </div>
          </dl>
          {result.narrative.originalVsReaction ? (
            <p className="mt-4 text-sm leading-6 text-zinc-300">{result.narrative.originalVsReaction}</p>
          ) : null}
        </section>

        <div className="grid gap-4 xl:grid-cols-2">
          {SCORE_CATEGORIES.map((category) => {
            const window =
              category.key === "hook"
                ? { start: 0, end: 5, label: "0:00–0:05" }
                : category.key === "outcome"
                  ? { start: endStart, end: result.video.duration, label: `${formatTimestamp(endStart)}–end` }
                  : undefined;
            const support =
              category.key === "hook"
                ? hookWindow
                : category.key === "outcome"
                  ? endWindow
                  : category.key === "visuals" || category.key === "pacing"
                    ? {
                        frameCount: result.visualStats.sampledFrameCount,
                        classes: result.visualStats.uniqueClasses,
                        shifts: result.visualStats.visualChanges,
                      }
                    : null;
            return (
              <SectionCard
                key={category.key}
                title={category.label}
                subtitle={category.question}
                analysis={sectionFor(result, category.key)}
                result={result}
                onSeek={seek}
                weight={result.overall.weights[category.key]}
                window={window}
                extra={
                  support ? (
                    <p className="mt-3 text-[11px] leading-5 text-cyan-100/80">
                      {`Roboflow${window ? ` in ${window.label}` : ""}: ${support.frameCount} ${
                        support.frameCount === 1 ? "sample" : "samples"
                      }${support.classes.length ? ` · ${support.classes.slice(0, 8).join(", ")}` : " · no classes"}${
                        support.shifts.length
                          ? ` · ${support.shifts.length} composition shift${support.shifts.length === 1 ? "" : "s"} (not scene cuts)`
                          : ""
                      }.`}
                    </p>
                  ) : (
                    <p className="mt-3 text-[11px] text-muted">
                      This score is Gemini editorial judgment. Roboflow objects are shown on timestamped notes.
                    </p>
                  )
                }
              />
            );
          })}
        </div>

        <NoteList title="Strengths" items={result.strengths} result={result} onSeek={seek} />
        <NoteList title="Weaknesses" items={result.weaknesses} result={result} onSeek={seek} />
        <NoteList title="Editing recommendations" items={result.recommendations} result={result} onSeek={seek} />

        {result.alternativeHook ? (
          <section className="rounded-2xl border border-border bg-surface p-5">
            <h2 className="text-base font-semibold">Suggested opening hook</h2>
            <p className="mt-1 text-[11px] uppercase tracking-[0.12em] text-muted">Gemini editorial</p>
            <p className="mt-3 text-sm leading-6 text-zinc-200">{result.alternativeHook.text}</p>
            {result.alternativeHook.why ? (
              <p className="mt-2 text-sm leading-6 text-muted">{result.alternativeHook.why}</p>
            ) : null}
          </section>
        ) : null}

        {result.transcript?.text ? (
          <section className="rounded-2xl border border-border bg-surface p-5">
            <h2 className="text-base font-semibold">Transcript</h2>
            <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-zinc-300">{result.transcript.text}</p>
          </section>
        ) : null}

        {result.missingEvidence.length > 0 ? (
          <section className="rounded-2xl border border-border bg-surface p-5">
            <h2 className="text-base font-semibold">Missing evidence</h2>
            <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-muted">
              {result.missingEvidence.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </section>
        ) : null}

        <DetectionTimeline
          result={result}
          onSeek={seek}
          selectedTimestamp={selectedFrame?.timestamp ?? inspectTimestamp}
        />
      </div>
    </div>
  );
}
