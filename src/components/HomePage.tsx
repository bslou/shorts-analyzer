"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { AppHeader } from "@/components/AppHeader";
import { readVideoMeta } from "@/lib/client-validate";
import { adaptiveFrameTarget, estimateAnalysisCost } from "@/lib/cost";
import { formatDuration } from "@/lib/format";
import { runBrowserAnalysis } from "@/lib/client-analyze";
import { fileFingerprint, getCachedAnalysis, rememberSessionVideo, storeAnalysis } from "@/lib/session";
import type { AnalysisStage, BudgetEstimate, ProgressEvent } from "@/lib/types";

const STAGES: { id: AnalysisStage; label: string }[] = [
  { id: "validating", label: "Validating video" },
  { id: "extracting_frames", label: "Extracting JPEG frames" },
  { id: "roboflow", label: "Running Shorts Visual Timeline" },
  { id: "transcribing", label: "Extracting audio" },
  { id: "analyzing_story", label: "Gemini editorial review" },
  { id: "preparing_results", label: "Building dashboard" },
];

type Status = {
  roboflowConfigured: boolean;
  geminiConfigured: boolean;
  modelId?: string;
  endpoint?: string;
  geminiModel?: string;
  geminiMaxFrames?: number;
  frameIntervalSeconds?: number;
  hookSeconds?: number;
  hookIntervalSeconds?: number;
  minRoboflowFrames?: number;
  maxRoboflowFrames?: number;
  softBudgetUsd?: number;
  roboflowUsdPerImage?: number;
  geminiInputUsdPerMillion?: number;
  geminiOutputUsdPerMillion?: number;
  error?: string;
};

export function HomePage() {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<{
    url: string;
    duration: number;
    width: number;
    height: number;
  } | null>(null);
  const [caption, setCaption] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<AnalysisStage | null>(null);
  const [stageMessage, setStageMessage] = useState("");
  const [frameProgress, setFrameProgress] = useState<{ completed: number; total: number } | null>(
    null,
  );
  const [status, setStatus] = useState<Status | null>(null);
  const [cached, setCached] = useState(false);
  const [force, setForce] = useState(false);
  const [approveOverBudget, setApproveOverBudget] = useState(false);
  const [budgetBlock, setBudgetBlock] = useState<BudgetEstimate | null>(null);

  useEffect(() => {
    fetch("/api/status")
      .then((response) => response.json())
      .then((data: Status) => setStatus(data))
      .catch(() => setStatus({ roboflowConfigured: false, geminiConfigured: false }));
  }, []);

  const stageIndex = useMemo(
    () => STAGES.findIndex((item) => item.id === stage),
    [stage],
  );

  async function onFile(next: File | null) {
    setError(null);
    setFile(null);
    setCached(false);
    setForce(false);
    setApproveOverBudget(false);
    setBudgetBlock(null);
    setPreview(null);
    if (!next) return;
    try {
      const meta = await readVideoMeta(next);
      const fingerprint = fileFingerprint(next);
      const url = await rememberSessionVideo(next, fingerprint);
      setFile(next);
      setPreview({ ...meta, url });
      URL.revokeObjectURL(meta.url);
      setCached(Boolean(await getCachedAnalysis(fingerprint)));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Invalid video.");
    }
  }

  const previewCost = useMemo(() => {
    if (!preview || !status) return null;
    const frames = adaptiveFrameTarget(
      preview.duration,
      status.minRoboflowFrames ?? 24,
      status.maxRoboflowFrames ?? 36,
    );
    return estimateAnalysisCost({
      roboflowFramesToBill: cached && !force ? 0 : frames,
      geminiWillBill: !(cached && !force),
      geminiFrames: status.geminiMaxFrames ?? 12,
      hasAudio: true,
      roboflowUsdPerImage: status.roboflowUsdPerImage ?? 0.0008,
      inputUsdPerMillion: status.geminiInputUsdPerMillion ?? 0.15,
      outputUsdPerMillion: status.geminiOutputUsdPerMillion ?? 0.6,
      softBudgetUsd: status.softBudgetUsd ?? 0.05,
      geminiModel: status.geminiModel ?? "gemini-2.5-flash",
    });
  }, [preview, status, cached, force]);

  async function analyze() {
    if (!file || !preview) return;
    if (cached && !force) {
      const previous = await getCachedAnalysis(fileFingerprint(file));
      if (previous) {
        const url = await rememberSessionVideo(file, fileFingerprint(file));
        storeAnalysis(previous, url, fileFingerprint(file));
        router.push("/analysis");
        return;
      }
    }

    setBusy(true);
    setError(null);
    setBudgetBlock(null);
    setStage("extracting_frames");
    setStageMessage("Extracting JPEG frames in the browser");
    setFrameProgress(null);

    try {
      if (!status) throw new Error("Server status is not available yet. Refresh and try again.");
      const result = await runBrowserAnalysis({
        file,
        videoUrl: preview.url,
        caption: caption.trim(),
        force,
        approveOverBudget,
        status,
        onEvent: (event: ProgressEvent) => {
          if (event.type === "stage") {
            setStage(event.stage);
            setStageMessage(event.message);
          } else if (event.type === "progress") {
            setStage(event.stage);
            setFrameProgress({ completed: event.completed, total: event.total });
            if (event.stage === "roboflow") {
              setStageMessage(`Roboflow inference ${event.completed}/${event.total} frames`);
            }
          }
        },
      });
      const url = await rememberSessionVideo(file, fileFingerprint(file));
      storeAnalysis(result, url, fileFingerprint(file));
      router.push("/analysis");
    } catch (caught) {
      const extra = caught as Error & { code?: "budget"; estimate?: BudgetEstimate };
      if (extra.code === "budget" && extra.estimate) {
        setBudgetBlock(extra.estimate);
        setBusy(false);
        setStage(null);
        return;
      }
      setError(caught instanceof Error ? caught.message : "Analysis failed.");
      setBusy(false);
      setStage(null);
    }
  }

  return (
    <div className="min-h-screen">
      <AppHeader />
      <main className="mx-auto max-w-5xl px-5 py-12">
        <div className="max-w-2xl">
          <p className="text-xs uppercase tracking-[0.22em] text-accent">Roboflow + Gemini</p>
          <h1 className="mt-3 text-4xl font-semibold tracking-tight">
            Analyze YouTube Shorts with real computer vision
          </h1>
          <p className="mt-4 max-w-xl text-muted leading-7">
            Choose a vertical MP4. Frames and the complete audio track are extracted in your
            browser — the original file is never uploaded. Roboflow detects objects on sampled
            JPEGs. Gemini then reviews those detections with the opening, transitions, ending,
            and full audio.
          </p>
        </div>

        {status && !status.roboflowConfigured ? (
          <div className="mt-8 rounded-2xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-100">
            {status.error ||
              "ROBOFLOW_API_KEY is not configured. Add it to .env.local before analyzing. Analysis will not fake detections."}
          </div>
        ) : null}
        {status && status.roboflowConfigured && !status.geminiConfigured ? (
          <div className="mt-8 rounded-2xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
            GEMINI_API_KEY is missing. Roboflow detections will still run; editorial scores will be marked uncertain.
          </div>
        ) : null}

        <div className="mt-10 grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
          <section className="rounded-3xl border border-border bg-surface p-6">
            <label
              className="flex cursor-pointer flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-surface-2 px-6 py-12 text-center hover:border-accent/50"
            >
              <input
                type="file"
                accept="video/mp4,.mp4"
                className="hidden"
                disabled={busy}
                onChange={(event) => onFile(event.target.files?.[0] ?? null)}
              />
              <p className="text-sm font-medium">Drop or choose an MP4 Short</p>
              <p className="mt-2 text-xs text-muted">
                Vertical video · max 180s · 9:16 preferred · 1080×1920 target
              </p>
            </label>

            {error ? (
              <p className="mt-4 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-100">
                {error}
              </p>
            ) : null}

            {budgetBlock ? (
              <div className="mt-4 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-3 text-sm text-amber-100">
                <p className="font-medium">This run is over the ${budgetBlock.softBudgetUsd.toFixed(2)} soft budget.</p>
                <p className="mt-1 text-xs">
                  Estimate: Roboflow ${budgetBlock.roboflowUsd.toFixed(4)} ({budgetBlock.roboflowFrames} frames) +
                  Gemini ${budgetBlock.geminiUsd.toFixed(4)} ({budgetBlock.geminiFrames} frames) = $
                  {budgetBlock.totalUsd.toFixed(4)}. Quality will not be reduced. Check the box to approve paid
                  calls.
                </p>
                <label className="mt-2 flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={approveOverBudget}
                    onChange={(event) => setApproveOverBudget(event.target.checked)}
                  />
                  Approve spending above the soft budget for this analysis
                </label>
              </div>
            ) : null}

            {cached ? (
              <div className="mt-4 rounded-xl border border-accent/30 bg-accent/10 px-3 py-2 text-sm">
                This file was already analyzed in this session. Open the dashboard without new API
                calls, or check reanalyze to spend credits again.
                <label className="mt-2 flex items-center gap-2 text-xs text-muted">
                  <input
                    type="checkbox"
                    checked={force}
                    disabled={busy}
                    onChange={(event) => setForce(event.target.checked)}
                  />
                  Reanalyze (new Roboflow and Gemini API calls)
                </label>
              </div>
            ) : null}

            <label className="mt-6 block text-sm text-muted">
              Optional publish caption
              <textarea
                value={caption}
                disabled={busy}
                onChange={(event) => setCaption(event.target.value)}
                className="mt-2 h-24 w-full resize-none rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-accent"
                placeholder="The caption you would publish with this Short"
              />
            </label>

            <button
              type="button"
              disabled={!file || busy || status?.roboflowConfigured === false}
              onClick={analyze}
              className="mt-6 w-full rounded-xl bg-linear-to-r from-accent to-accent-2 py-3 text-sm font-semibold text-black disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy
                ? "Analyzing…"
                : cached && !force
                  ? "View previous analysis"
                  : budgetBlock && approveOverBudget
                    ? "Analyze at full quality"
                    : "Analyze Video"}
            </button>
          </section>

          <section className="rounded-3xl border border-border bg-surface p-6">
            {preview ? (
              <>
                <video src={preview.url} controls playsInline className="mx-auto max-h-[420px] rounded-xl" />
                <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <dt className="text-muted">File</dt>
                    <dd>{file?.name}</dd>
                  </div>
                  <div>
                    <dt className="text-muted">Duration</dt>
                    <dd>{formatDuration(preview.duration)}</dd>
                  </div>
                  <div>
                    <dt className="text-muted">Resolution</dt>
                    <dd>
                      {preview.width}×{preview.height}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted">Roboflow model</dt>
                    <dd className="font-mono text-xs">{status?.modelId ?? "shorts-visual-timeline"}</dd>
                  </div>
                </dl>
                {previewCost ? (
                  <div className="mt-4 rounded-xl bg-surface-2 px-3 py-3 text-xs leading-5 text-muted">
                    <p>
                      Planned ~{previewCost.roboflowFrames} Roboflow frames + {previewCost.geminiFrames} Gemini
                      frames on {status?.geminiModel ?? "gemini-2.5-flash"}.
                    </p>
                    <p className="mt-1">
                      Estimate: Roboflow ${previewCost.roboflow.usd.toFixed(4)} ({previewCost.roboflow.label}) ·
                      Gemini ${previewCost.gemini.usd.toFixed(4)} ({previewCost.gemini.label}) · total $
                      {previewCost.totalUsd.toFixed(4)} / ${previewCost.softBudgetUsd.toFixed(2)} budget.
                    </p>
                    {previewCost.overBudget ? (
                      <p className="mt-1 text-amber-200">Over soft budget — you will be asked to approve before paid calls.</p>
                    ) : (
                      <p className="mt-1">Target band for a 30–60s Short is about $0.01–$0.03 at list prices.</p>
                    )}
                  </div>
                ) : null}
              </>
            ) : (
              <div className="grid h-full min-h-[320px] place-items-center text-sm text-muted">
                Preview appears after you select a valid vertical MP4.
              </div>
            )}
          </section>
        </div>

        {busy ? (
          <section className="mt-8 rounded-3xl border border-border bg-surface p-6">
            <p className="text-sm font-medium">{stageMessage || "Working"}</p>
            <ol className="mt-4 space-y-2">
              {STAGES.map((item, index) => {
                const active = item.id === stage;
                const complete = stageIndex >= 0 && index < stageIndex;
                return (
                  <li
                    key={item.id}
                    className={`flex items-center justify-between rounded-xl px-3 py-2 text-sm ${
                      active ? "bg-accent/15 text-foreground" : "text-muted"
                    }`}
                  >
                    <span>
                      {complete ? "✓ " : active ? "→ " : ""}
                      {item.label}
                    </span>
                    {active && frameProgress ? (
                      <span className="font-mono text-xs">
                        {frameProgress.completed}/{frameProgress.total} frames
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ol>
            <p className="mt-3 text-xs text-muted">
              Progress is stage-based. Frame counts are actual Roboflow requests, not estimates.
            </p>
          </section>
        ) : null}

        <p className="mt-6 text-xs text-muted">
          Typical Short: 24–36 adaptive Roboflow frames plus one Gemini 2.5 Flash request with full
          audio. JPEG batches stay under Vercel Hobby&apos;s 4.5MB limit. Unchanged files reuse
          cache. Object boxes come only from Roboflow.
        </p>
      </main>
    </div>
  );
}
