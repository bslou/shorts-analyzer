import type { ReactNode } from "react";
import type { AnalysisResult, SectionAnalysis } from "@/lib/types";
import { formatTimestamp } from "@/lib/format";
import { RoboflowEvidence, SourceBadge } from "./RoboflowEvidence";
import { ScoreRing } from "./ScoreRing";

export function SectionCard({
  title,
  subtitle,
  analysis,
  result,
  onSeek,
  window,
  weight,
  extra,
}: {
  title: string;
  subtitle?: string;
  analysis: SectionAnalysis;
  result: AnalysisResult;
  onSeek?: (seconds: number) => void;
  window?: { start: number; end: number; label: string };
  weight?: number;
  extra?: ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-border bg-surface p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-base font-semibold">{title}</h2>
          {subtitle ? <p className="mt-1 text-sm leading-5 text-muted">{subtitle}</p> : null}
          {weight !== undefined ? (
            <p className="mt-2 text-[11px] text-muted">
              Weight in overall: {(weight * 100).toFixed(0)}% of scored categories
            </p>
          ) : null}
        </div>
        <ScoreRing score={analysis.score} size={72} uncertain={analysis.uncertain} />
      </div>
      {analysis.uncertain ? (
        <p className="mt-3 text-[11px] uppercase tracking-[0.14em] text-amber-200">
          Uncertain — not enough evidence to score
        </p>
      ) : null}
      <p className="mt-3 text-sm leading-6 text-zinc-300">{analysis.explanation}</p>
      {extra}
      {window ? (
        <p className="mt-2 text-[11px] text-muted">
          Evidence window {window.label}. Object labels in that window come from Roboflow samples, not
          Gemini.
        </p>
      ) : null}
      {analysis.recommendations.length > 0 ? (
        <ul className="mt-4 space-y-2">
          {analysis.recommendations.map((item, index) => (
            <li key={`${item.text}-${index}`} className="rounded-xl bg-surface-2 px-3 py-2.5">
              <div className="flex flex-wrap items-center gap-2">
                {item.timestamp !== undefined && onSeek ? (
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
              <p className="mt-1.5 text-sm text-zinc-300">{item.text}</p>
              <RoboflowEvidence result={result} timestamp={item.timestamp} onSeek={onSeek} />
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
