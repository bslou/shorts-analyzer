import { getBudgetConfig, getGeminiConfig, getRoboflowConfig } from "@/lib/config";
import { estimateAnalysisCost, toBudgetEvent, usdFromTokens } from "@/lib/cost";
import { detectionDigest } from "@/lib/detection-digest";
import { geminiCacheKey, readGeminiCache, writeGeminiCache } from "@/lib/inference-cache";
import { assertUnderVercelLimit } from "@/lib/payload";
import { QuotaError } from "@/lib/roboflow";
import { analyzeStory } from "@/lib/story-analysis";
import type { AnalysisResult, AudioInsights, FrameDetections, SceneCut, VideoMetadata } from "@/lib/types";
import { emptyUsage, logUsage } from "@/lib/usage";
import { computeVisualStats } from "@/lib/visual-stats";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

type GeminiBody = {
  sessionId?: string;
  fileHash?: string;
  force?: boolean;
  approveOverBudget?: boolean;
  caption?: string;
  video: VideoMetadata;
  detections: FrameDetections[];
  geminiFrames: { timestamp: number; imageBase64: string; width: number; height: number }[];
  audio?: { mimeType: string; data: string } | null;
  audioInsights?: AudioInsights | null;
  sceneCuts?: SceneCut[];
  warnings?: string[];
  roboflowBilled?: number;
  roboflowCached?: number;
};

export async function POST(request: Request) {
  let body: GeminiBody;
  try {
    body = (await request.json()) as GeminiBody;
  } catch {
    return Response.json({ message: "Invalid JSON body." }, { status: 400 });
  }

  try {
    assertUnderVercelLimit(
      {
        ...body,
        audio: body.audio ? { mimeType: body.audio.mimeType, data: `[${body.audio.data.length} chars]` } : null,
        geminiFrames: body.geminiFrames?.map((frame) => ({
          ...frame,
          imageBase64: `[${frame.imageBase64.length} chars]`,
        })),
      },
      "Gemini request metadata",
    );
    const bytes = new TextEncoder().encode(JSON.stringify(body)).length;
    if (bytes > 3_200_000) {
      return Response.json(
        {
          message: `Gemini request is ${(bytes / 1_000_000).toFixed(2)}MB, over the Vercel Hobby 4.5MB limit.`,
        },
        { status: 413 },
      );
    }

    if (!body.video || !Array.isArray(body.detections) || body.detections.length === 0) {
      return Response.json({ message: "Gemini request is missing Roboflow detections." }, { status: 400 });
    }
    if (!Array.isArray(body.geminiFrames) || body.geminiFrames.length === 0) {
      return Response.json({ message: "Gemini request is missing JPEG frames." }, { status: 400 });
    }

    const config = getRoboflowConfig();
    const gemini = getGeminiConfig();
    const budget = getBudgetConfig();
    const warnings = [...(body.warnings || [])];
    const usage = emptyUsage();
    const billed = body.roboflowBilled ?? 0;
    const cached = body.roboflowCached ?? 0;
    usage.roboflowCalls = billed;
    usage.roboflowCachedFrames = cached;
    usage.sampledFrames = body.detections.length;
    usage.geminiFrames = body.geminiFrames.length;
    usage.geminiModel = gemini.model;
    usage.softBudgetUsd = budget.softBudgetUsd;
    usage.roboflowCreditsEstimate = Number((billed * config.creditsPerImage).toFixed(6));
    usage.roboflowUsd =
      billed === 0
        ? { usd: 0, source: "cached", label: "cache hit" }
        : {
            usd: Number((billed * config.usdPerImage).toFixed(6)),
            source: "estimate",
            label: "list-price estimate",
          };

    const visualStats = computeVisualStats(body.detections, config.intervalSeconds);
    const sceneCuts = body.sceneCuts || [];
    const audioInline = body.audio?.data
      ? { mimeType: body.audio.mimeType || "audio/wav", data: body.audio.data }
      : undefined;

    type StoryCache = Awaited<ReturnType<typeof analyzeStory>>;
    const editorialKey = geminiCacheKey({
      fileBytes: Buffer.from(body.fileHash || body.sessionId || "session", "utf8"),
      geminiModel: gemini.model,
      workflowId: config.workflowId,
      caption: body.caption || "",
      detectionDigest: detectionDigest(body.detections),
    });

    let story = body.force ? null : await readGeminiCache<StoryCache>(editorialKey);
    if (story) {
      usage.notes.push("Gemini editorial review loaded from local cache; no new Gemini call.");
    } else {
      const geminiOnly = estimateAnalysisCost({
        roboflowFramesToBill: 0,
        geminiWillBill: true,
        geminiFrames: body.geminiFrames.length,
        hasAudio: Boolean(audioInline),
        roboflowUsdPerImage: config.usdPerImage,
        inputUsdPerMillion: gemini.inputUsdPerMillion,
        outputUsdPerMillion: gemini.outputUsdPerMillion,
        softBudgetUsd: budget.softBudgetUsd,
        geminiModel: gemini.model,
      });
      const remaining = Number((usage.roboflowUsd.usd + geminiOnly.gemini.usd).toFixed(6));
      if (remaining > budget.softBudgetUsd && !body.approveOverBudget) {
        return Response.json(
          {
            code: "budget",
            message: `Estimated $${remaining.toFixed(3)} exceeds the $${budget.softBudgetUsd.toFixed(2)} soft budget. Approve to continue at full quality.`,
            estimate: {
              ...toBudgetEvent(geminiOnly),
              roboflowUsd: usage.roboflowUsd.usd,
              totalUsd: remaining,
            },
          },
          { status: 402 },
        );
      }

      if (!gemini.apiKey) {
        warnings.push("GEMINI_API_KEY is not set. Roboflow detections are real; editorial scores are marked uncertain.");
      }

      story = await analyzeStory({
        video: body.video,
        frames: body.detections,
        frameImages: body.geminiFrames.map((frame) => ({
          timestamp: frame.timestamp,
          data: frame.imageBase64,
          mimeType: "image/jpeg",
        })),
        stats: visualStats,
        sceneCuts,
        audio: body.audioInsights || null,
        audioInline,
        caption: body.caption,
        warnings,
      });
      if (story.geminiUsage.requests > 0) {
        await writeGeminiCache(editorialKey, story);
      }
    }

    usage.geminiRequests = story.geminiUsage.requests;
    usage.geminiInputTokens = story.geminiUsage.inputTokens;
    usage.geminiOutputTokens = story.geminiUsage.outputTokens;
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

    const result: AnalysisResult = {
      video: body.video,
      model: {
        provider: "roboflow",
        endpoint: config.endpoint,
        modelId: config.workflowName,
      },
      frames: body.detections,
      visualStats,
      transcript: story.transcript,
      sceneCuts,
      visualChanges: visualStats.visualChanges,
      audio: body.audioInsights || null,
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

    await logUsage(usage).catch(() => undefined);
    assertUnderVercelLimit(result, "Gemini response");
    return Response.json({ result, sessionId: body.sessionId });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Gemini analysis failed.";
    const status = error instanceof QuotaError ? 429 : 500;
    return Response.json({ message }, { status });
  }
}
