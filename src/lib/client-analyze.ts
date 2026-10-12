"use client";

import { MAX_VERCEL_JSON_BYTES } from "./constants";
import { adaptiveFrameTarget, estimateAnalysisCost, toBudgetEvent } from "./cost";
import { pickGeminiFrames } from "./pick-frames";
import { httpErrorMessage, jsonByteLength } from "./payload";
import { preprocessVideo, type ExtractedJpeg } from "./browser-preprocess";
import type { AnalysisResult, BudgetEstimate, FrameDetections, ProgressEvent } from "./types";

export type AnalyzerStatus = {
  roboflowConfigured: boolean;
  geminiConfigured: boolean;
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
};

async function postJson<T>(url: string, body: unknown, label: string): Promise<T> {
  const bytes = jsonByteLength(body);
  console.info(`[shorts-analyzer] ${label} JSON ${(bytes / 1000).toFixed(1)}KB`);
  if (bytes > MAX_VERCEL_JSON_BYTES) {
    throw new Error(
      `${label} is ${(bytes / 1_000_000).toFixed(2)}MB JSON, over Vercel Hobby's 4.5MB body limit.`,
    );
  }
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { message: text };
  }
  if (!response.ok) {
    const record = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    if (response.status === 402 && record.code === "budget") {
      const error = new Error(String(record.message || "Over soft budget")) as Error & {
        code?: "budget";
        estimate?: BudgetEstimate;
      };
      error.code = "budget";
      error.estimate = record.estimate as BudgetEstimate | undefined;
      throw error;
    }
    const message =
      typeof record.message === "string" && record.message.trim()
        ? record.message
        : httpErrorMessage(response.status, text);
    throw new Error(message);
  }
  return parsed as T;
}

function packRoboflowBatches(frames: ExtractedJpeg[]) {
  const batches: ExtractedJpeg[][] = [];
  let current: ExtractedJpeg[] = [];
  let size = 160;
  for (const frame of frames) {
    const item = frame.base64.length + 140;
    if (current.length && (current.length >= 5 || size + item > MAX_VERCEL_JSON_BYTES)) {
      batches.push(current);
      current = [];
      size = 160;
    }
    current.push(frame);
    size += item;
  }
  if (current.length) batches.push(current);
  return batches;
}

function loadVideoElement(url: string) {
  return new Promise<HTMLVideoElement>((resolve, reject) => {
    const video = document.createElement("video");
    video.preload = "auto";
    video.muted = true;
    video.playsInline = true;
    video.crossOrigin = "anonymous";
    video.src = url;
    const onReady = () => {
      video.removeEventListener("loadeddata", onReady);
      video.removeEventListener("error", onError);
      resolve(video);
    };
    const onError = () => {
      video.removeEventListener("loadeddata", onReady);
      video.removeEventListener("error", onError);
      reject(new Error("Could not decode the video in the browser for frame extraction."));
    };
    video.addEventListener("loadeddata", onReady);
    video.addEventListener("error", onError);
    video.style.cssText = "position:fixed;left:-99999px;width:16px;height:16px;opacity:0;pointer-events:none";
    document.body.appendChild(video);
    video.load();
  });
}

export async function runBrowserAnalysis(input: {
  file: File;
  videoUrl: string;
  caption: string;
  force: boolean;
  approveOverBudget: boolean;
  status: AnalyzerStatus;
  onEvent: (event: ProgressEvent) => void;
}): Promise<AnalysisResult> {
  const sessionId = crypto.randomUUID();
  const minFrames = input.status.minRoboflowFrames ?? 24;
  const maxFrames = input.status.maxRoboflowFrames ?? 36;
  const emit = input.onEvent;

  emit({ type: "stage", stage: "validating", message: "Preparing browser preprocessing" });
  const video = await loadVideoElement(input.videoUrl);
  try {

  emit({ type: "stage", stage: "extracting_frames", message: "Extracting JPEG frames in the browser" });
  const prepared = await preprocessVideo(
    input.file,
    video,
    {
      intervalSeconds: input.status.frameIntervalSeconds ?? 2,
      hookSeconds: input.status.hookSeconds ?? 5,
      hookIntervalSeconds: input.status.hookIntervalSeconds ?? 1,
      minFrames,
      maxFrames,
    },
    (message, completed, total) => {
      const stage = /audio/i.test(message) ? "transcribing" : "extracting_frames";
      emit({ type: "stage", stage, message });
      if (completed !== undefined && total !== undefined) {
        emit({ type: "progress", stage: "extracting_frames", completed, total });
      }
    },
  );

  if (prepared.audio.hasAudio && !prepared.audio.base64) {
    throw new Error("Audio is present but encoding failed. Complete audio was not sent.");
  }

  const plannedFrames = prepared.frames.length;
  const geminiFrameCount = Math.min(plannedFrames, input.status.geminiMaxFrames ?? 12);
  const estimate = estimateAnalysisCost({
    roboflowFramesToBill: input.force ? plannedFrames : plannedFrames,
    geminiWillBill: true,
    geminiFrames: geminiFrameCount,
    hasAudio: Boolean(prepared.audio.base64),
    roboflowUsdPerImage: input.status.roboflowUsdPerImage ?? 0.0008,
    inputUsdPerMillion: input.status.geminiInputUsdPerMillion ?? 0.15,
    outputUsdPerMillion: input.status.geminiOutputUsdPerMillion ?? 0.6,
    softBudgetUsd: input.status.softBudgetUsd ?? 0.05,
    geminiModel: input.status.geminiModel ?? "gemini-2.5-flash",
  });
  if (estimate.overBudget && !input.approveOverBudget) {
    const error = new Error(
      `Estimated $${estimate.totalUsd.toFixed(3)} exceeds the $${estimate.softBudgetUsd.toFixed(2)} soft budget. Approve to continue at full quality.`,
    ) as Error & { code?: "budget"; estimate?: BudgetEstimate };
    error.code = "budget";
    error.estimate = toBudgetEvent(estimate);
    throw error;
  }

  const batches = packRoboflowBatches(prepared.frames);
  emit({
    type: "stage",
    stage: "roboflow",
    message: `Calling Shorts Visual Timeline on ${plannedFrames} frames in ${batches.length} request(s)`,
  });

  const detections: FrameDetections[] = [];
  let billed = 0;
  let cached = 0;
  for (const batch of batches) {
    const payload = {
      sessionId,
      force: input.force,
      frames: batch.map((frame) => ({
        timestamp: frame.timestamp,
        imageBase64: frame.base64,
        width: frame.width,
        height: frame.height,
      })),
    };
    const result = await postJson<{
      frames: FrameDetections[];
      cached: number;
      billed: number;
    }>("/api/roboflow", payload, "Roboflow batch");
    detections.push(...result.frames);
    billed += result.billed;
    cached += result.cached;
    emit({
      type: "progress",
      stage: "roboflow",
      completed: detections.length,
      total: plannedFrames,
    });
  }

  const extras = [
    ...prepared.sceneCuts.map((cut) => cut.timestamp),
    prepared.metadata.duration,
  ];
  const geminiJpegs = pickGeminiFrames(prepared.frames, geminiFrameCount, extras);

  emit({
    type: "stage",
    stage: "analyzing_story",
    message: `Gemini ${input.status.geminiModel ?? "gemini-2.5-flash"}: ${geminiJpegs.length} frames plus complete audio`,
  });

  const geminiBody = {
    sessionId,
    fileHash: prepared.fileHash,
    force: input.force,
    approveOverBudget: input.approveOverBudget,
    caption: input.caption,
    video: prepared.metadata,
    detections,
    geminiFrames: geminiJpegs.map((frame) => ({
      timestamp: frame.timestamp,
      imageBase64: frame.base64,
      width: frame.width,
      height: frame.height,
    })),
    audio: prepared.audio.base64
      ? { mimeType: prepared.audio.mimeType || "audio/wav", data: prepared.audio.base64 }
      : null,
    audioInsights: prepared.audio.insights,
    sceneCuts: prepared.sceneCuts,
    warnings: prepared.audio.hasAudio
      ? []
      : ["This file has no audio track. Format and hook comments will be visual-only."],
    roboflowBilled: billed,
    roboflowCached: cached,
  };

  const geminiResponse = await postJson<{ result: AnalysisResult }>("/api/gemini", geminiBody, "Gemini request");
  const byTime = new Map(prepared.frames.map((frame) => [frame.timestamp.toFixed(3), frame]));
  const result: AnalysisResult = {
    ...geminiResponse.result,
    frames: geminiResponse.result.frames.map((frame) => {
      const jpeg = byTime.get(frame.timestamp.toFixed(3));
      return {
        ...frame,
        imageWidth: frame.imageWidth || jpeg?.width || 0,
        imageHeight: frame.imageHeight || jpeg?.height || 0,
        frameImage: jpeg?.dataUrl,
      };
    }),
    usage: {
      ...geminiResponse.result.usage,
      notes: [
        ...(geminiResponse.result.usage.notes || []),
        `Browser extracted ${prepared.frames.length} JPEGs (target ${adaptiveFrameTarget(prepared.metadata.duration, minFrames, maxFrames)}). Audio ${prepared.audio.mimeType || "none"} ${prepared.audio.bytes ? `${(prepared.audio.bytes / 1000).toFixed(0)}KB` : ""}`.trim(),
      ],
    },
  };

  emit({ type: "stage", stage: "preparing_results", message: "Building dashboard" });
  emit({ type: "complete", result });
  return result;
  } finally {
    video.remove();
  }
}
