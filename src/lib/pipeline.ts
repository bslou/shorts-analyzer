import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getBudgetConfig, getGeminiConfig, getRoboflowConfig } from "./config";
import { estimateAnalysisCost, toBudgetEvent, usdFromTokens } from "./cost";
import {
  analyzeAudioLevels,
  detectSceneCuts,
  extractAudio,
  extractFramesAtTimestamps,
  probeVideo,
} from "./ffmpeg";
import {
  cacheKey,
  geminiCacheKey,
  readGeminiCache,
  readInferenceCache,
  writeGeminiCache,
  writeInferenceCache,
} from "./inference-cache";
import { inferFrames } from "./roboflow";
import { planSampleTimestamps } from "./sample-plan";
import { analyzeStory } from "./story-analysis";
import { cleanupJobDir, createJobDir } from "./temp";
import type { AnalysisResult, FrameDetections, ProgressEvent } from "./types";
import { emptyUsage, logUsage } from "./usage";
import { validateMetadata, validateUpload } from "./validate";
import { computeVisualStats } from "./visual-stats";

async function attachFrameImages(
  detections: FrameDetections[],
  frameFiles: { timestamp: number; path: string; width: number; height: number }[],
): Promise<FrameDetections[]> {
  return Promise.all(
    detections.map(async (frame, index) => {
      const file = frameFiles[index];
      const jpeg = file ? await readFile(file.path) : null;
      return {
        ...frame,
        imageWidth: frame.imageWidth || file?.width || 0,
        imageHeight: frame.imageHeight || file?.height || 0,
        frameImage: jpeg ? `data:image/jpeg;base64,${jpeg.toString("base64")}` : frame.frameImage,
      };
    }),
  );
}

function detectionDigest(frames: FrameDetections[]) {
  const hash = createHash("sha256");
  for (const frame of frames) {
    hash.update(String(frame.timestamp));
    for (const detection of frame.detections) {
      hash.update(detection.class);
      hash.update(detection.confidence.toFixed(3));
    }
  }
  return hash.digest("hex");
}

export async function* runAnalysis(
  file: File,
  caption: string | undefined,
  options: { force: boolean; approveOverBudget?: boolean },
): AsyncGenerator<ProgressEvent> {
  let jobDir: string | undefined;
  const warnings: string[] = [];
  const usage = emptyUsage();

  try {
    yield { type: "stage", stage: "validating", message: "Validating upload" };
    validateUpload(file);

    jobDir = await createJobDir();
    const videoBytes = Buffer.from(await file.arrayBuffer());
    const videoPath = path.join(jobDir, "input.mp4");
    await writeFile(videoPath, videoBytes);

    const video = await probeVideo(videoPath, file.name);
    validateMetadata(video);

    const config = getRoboflowConfig();
    const gemini = getGeminiConfig();
    const budget = getBudgetConfig();
    if (!config.apiKey) {
      throw new Error(
        "ROBOFLOW_API_KEY is not set. Add it to .env.local. Create a key at https://app.roboflow.com/settings/api",
      );
    }

    yield { type: "stage", stage: "extracting_frames", message: "Measuring scene changes" };
    const sceneCuts = await detectSceneCuts(videoPath);

    const timestamps = planSampleTimestamps({
      duration: video.duration,
      intervalSeconds: config.intervalSeconds,
      hookSeconds: config.hookSeconds,
      hookIntervalSeconds: config.hookIntervalSeconds,
      minFrames: config.minFrames,
      maxFrames: config.maxFrames,
      frameRate: video.frameRate,
      extraTimestamps: sceneCuts.map((cut) => cut.timestamp),
    });

    yield {
      type: "stage",
      stage: "extracting_frames",
      message: `Extracting ${timestamps.length} JPEG frames (adaptive ${config.minFrames}–${config.maxFrames}, opening + transitions + ending)`,
    };

    const extracted = await extractFramesAtTimestamps(videoPath, jobDir, timestamps, {
      duration: video.duration,
      frameRate: video.frameRate,
      onWarning: (message) => warnings.push(message),
    });
    const frameFiles = extracted.frames;
    warnings.push(...extracted.warnings.filter((item) => !warnings.includes(item)));
    if (frameFiles.length === 0) {
      throw new Error("FFmpeg did not produce any frames from the video.");
    }

    let audioPath: string | undefined;
    let audio = null;
    if (video.hasAudio) {
      yield { type: "stage", stage: "transcribing", message: "Extracting audio for Gemini" };
      try {
        audioPath = await extractAudio(videoPath, jobDir);
        audio = await analyzeAudioLevels(audioPath, video.duration);
      } catch (error) {
        warnings.push(
          `Audio extraction failed: ${error instanceof Error ? error.message : "unknown error"}. Speech will not be analyzed.`,
        );
        audioPath = undefined;
      }
    } else {
      warnings.push("This file has no audio track. Format and hook comments will be visual-only.");
    }

    const key = cacheKey({
      fileBytes: videoBytes,
      modelId: config.endpoint,
      confidence: 0,
      timestamps: frameFiles.map((frame) => frame.timestamp),
    });

    let detections = options.force ? null : await readInferenceCache(key);
    if (detections && detections.length === frameFiles.length) {
      usage.roboflowCachedFrames = detections.length;
      usage.notes.push("Roboflow Workflow results loaded from local cache; no new API calls.");
      yield {
        type: "stage",
        stage: "roboflow",
        message: `Using cached Roboflow Workflow results for ${detections.length} frames`,
      };
      yield {
        type: "progress",
        stage: "roboflow",
        completed: detections.length,
        total: detections.length,
      };
    } else {
      detections = null;
    }

    const geminiFrameCount = Math.min(frameFiles.length, gemini.maxFrames);
    const plannedCost = estimateAnalysisCost({
      roboflowFramesToBill: detections ? 0 : frameFiles.length,
      geminiWillBill: true,
      geminiFrames: geminiFrameCount,
      hasAudio: Boolean(audioPath),
      roboflowUsdPerImage: config.usdPerImage,
      inputUsdPerMillion: gemini.inputUsdPerMillion,
      outputUsdPerMillion: gemini.outputUsdPerMillion,
      softBudgetUsd: budget.softBudgetUsd,
      geminiModel: gemini.model,
    });

    if (!detections && plannedCost.overBudget && !options.approveOverBudget) {
      yield {
        type: "error",
        stage: "roboflow",
        code: "budget",
        message: `Estimated $${plannedCost.totalUsd.toFixed(3)} exceeds the $${budget.softBudgetUsd.toFixed(2)} soft budget. Approve to continue at full quality.`,
        estimate: toBudgetEvent(plannedCost),
      };
      return;
    }

    if (!detections) {
      yield {
        type: "stage",
        stage: "roboflow",
        message: `Calling Shorts Visual Timeline on ${frameFiles.length} frames (adaptive ${config.minFrames}–${config.maxFrames})`,
      };

      const progressQueue: ProgressEvent[] = [];
      let finished = false;
      let wake: () => void = () => undefined;
      const wait = () =>
        new Promise<void>((resolve) => {
          wake = resolve;
        });

      const inference = inferFrames(frameFiles, (completed, total) => {
        progressQueue.push({ type: "progress", stage: "roboflow", completed, total });
        wake();
      }).finally(() => {
        finished = true;
        wake();
      });

      while (true) {
        while (progressQueue.length > 0) {
          yield progressQueue.shift()!;
        }
        if (finished) break;
        await wait();
      }

      detections = await inference;
      usage.roboflowCalls = detections.length;
      await writeInferenceCache(key, detections);
    }

    usage.roboflowCreditsEstimate = Number((usage.roboflowCalls * config.creditsPerImage).toFixed(6));
    usage.roboflowUsd =
      usage.roboflowCalls === 0
        ? { usd: 0, source: "cached", label: "cache hit" }
        : {
            usd: Number((usage.roboflowCalls * config.usdPerImage).toFixed(6)),
            source: "estimate",
            label: "list-price estimate",
          };

    const visualStats = computeVisualStats(detections, config.intervalSeconds);

    type StoryCache = Awaited<ReturnType<typeof analyzeStory>>;
    const editorialKey = geminiCacheKey({
      fileBytes: videoBytes,
      geminiModel: gemini.model,
      workflowId: config.workflowId,
      caption: caption || "",
      detectionDigest: detectionDigest(detections),
    });
    let story = options.force ? null : await readGeminiCache<StoryCache>(editorialKey);
    if (story) {
      usage.notes.push("Gemini editorial review loaded from local cache; no new Gemini call.");
      yield { type: "stage", stage: "analyzing_story", message: "Using cached Gemini editorial review" };
    } else {
      const geminiOnly = estimateAnalysisCost({
        roboflowFramesToBill: 0,
        geminiWillBill: true,
        geminiFrames: geminiFrameCount,
        hasAudio: Boolean(audioPath),
        roboflowUsdPerImage: config.usdPerImage,
        inputUsdPerMillion: gemini.inputUsdPerMillion,
        outputUsdPerMillion: gemini.outputUsdPerMillion,
        softBudgetUsd: budget.softBudgetUsd,
        geminiModel: gemini.model,
      });
      const remaining = Number((usage.roboflowUsd.usd + geminiOnly.gemini.usd).toFixed(6));
      if (remaining > budget.softBudgetUsd && !options.approveOverBudget) {
        yield {
          type: "error",
          stage: "analyzing_story",
          code: "budget",
          message: `Estimated $${remaining.toFixed(3)} exceeds the $${budget.softBudgetUsd.toFixed(2)} soft budget. Approve to continue at full quality.`,
          estimate: {
            ...toBudgetEvent(geminiOnly),
            roboflowUsd: usage.roboflowUsd.usd,
            totalUsd: remaining,
          },
        };
        return;
      }
      yield {
        type: "stage",
        stage: "analyzing_story",
        message: `Gemini ${gemini.model}: one review of ${geminiFrameCount} frames plus complete audio`,
      };
      story = await analyzeStory({
        video,
        frames: detections,
        frameImages: await Promise.all(
          frameFiles.map(async (frame) => ({
            timestamp: frame.timestamp,
            data: (await readFile(frame.path)).toString("base64"),
            mimeType: "image/jpeg",
          })),
        ),
        stats: visualStats,
        sceneCuts,
        audio,
        audioInline: audioPath
          ? { mimeType: "audio/mpeg", data: (await readFile(audioPath)).toString("base64") }
          : undefined,
        caption,
        warnings,
      });
      if (story.geminiUsage.requests > 0) {
        await writeGeminiCache(editorialKey, story);
      }
    }

    usage.geminiRequests = story.geminiUsage.requests;
    usage.geminiInputTokens = story.geminiUsage.inputTokens;
    usage.geminiOutputTokens = story.geminiUsage.outputTokens;
    usage.geminiModel = gemini.model;
    usage.sampledFrames = frameFiles.length;
    usage.geminiFrames = geminiFrameCount;
    usage.softBudgetUsd = budget.softBudgetUsd;
    if (story.geminiUsage.requests > 0) {
      usage.geminiUsd = {
        usd: usdFromTokens(
          story.geminiUsage.inputTokens,
          story.geminiUsage.outputTokens,
          gemini.inputUsdPerMillion,
          gemini.outputUsdPerMillion,
        ),
        source: "actual-tokens",
        label: "from API token counts",
      };
    } else {
      usage.geminiUsd = { usd: 0, source: "cached", label: "cache hit" };
    }
    usage.totalUsd = Number((usage.roboflowUsd.usd + usage.geminiUsd.usd).toFixed(6));
    usage.overBudget = usage.totalUsd > budget.softBudgetUsd;
    usage.notes.push(
      `Roboflow ${usage.roboflowUsd.label}: $${usage.roboflowUsd.usd.toFixed(4)}. Gemini ${gemini.model} ${usage.geminiUsd.label}: $${usage.geminiUsd.usd.toFixed(4)}. Total $${usage.totalUsd.toFixed(4)} (soft budget $${budget.softBudgetUsd.toFixed(2)}).`,
    );
    usage.notes.push(
      "Gemini dollars use returned token counts when a request ran. Roboflow dollars are a list-price estimate; free-tier credits may cover Workflow calls.",
    );

    detections = await attachFrameImages(detections, frameFiles);

    yield { type: "stage", stage: "preparing_results", message: "Building dashboard" };

    const result: AnalysisResult = {
      video,
      model: {
        provider: "roboflow",
        endpoint: config.endpoint,
        modelId: config.workflowName,
      },
      frames: detections,
      visualStats,
      transcript: story.transcript,
      sceneCuts,
      visualChanges: visualStats.visualChanges,
      audio,
      ...story.editorial,
      narrative: story.narrative,
      subtitles: {
        implemented: false,
        status: "future",
        note: "On-screen subtitle OCR is not implemented.",
      },
      warnings,
      usage,
    };

    await logUsage(usage);
    yield { type: "complete", result };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Analysis failed.";
    yield { type: "error", stage: "roboflow", message };
  } finally {
    await cleanupJobDir(jobDir);
  }
}
