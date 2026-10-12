import { getBudgetConfig, getGeminiConfig, getRoboflowConfig } from "@/lib/config";
import { adaptiveFrameTarget, estimateAnalysisCost } from "@/lib/cost";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const config = getRoboflowConfig();
    const gemini = getGeminiConfig();
    const budget = getBudgetConfig();
    return Response.json({
      roboflowConfigured: Boolean(config.apiKey),
      geminiConfigured: Boolean(gemini.apiKey),
      modelId: config.workflowId,
      workspace: config.workspace,
      publishedUrl: config.publishedUrl,
      endpoint: config.endpoint,
      geminiModel: gemini.model,
      geminiMaxFrames: gemini.maxFrames,
      frameIntervalSeconds: config.intervalSeconds,
      minRoboflowFrames: config.minFrames,
      maxRoboflowFrames: config.maxFrames,
      softBudgetUsd: budget.softBudgetUsd,
      roboflowUsdPerImage: config.usdPerImage,
      geminiInputUsdPerMillion: gemini.inputUsdPerMillion,
      geminiOutputUsdPerMillion: gemini.outputUsdPerMillion,
      typicalFrames: adaptiveFrameTarget(35, config.minFrames, config.maxFrames),
      typicalEstimate: estimateAnalysisCost({
        roboflowFramesToBill: adaptiveFrameTarget(35, config.minFrames, config.maxFrames),
        geminiWillBill: true,
        geminiFrames: gemini.maxFrames,
        hasAudio: true,
        roboflowUsdPerImage: config.usdPerImage,
        inputUsdPerMillion: gemini.inputUsdPerMillion,
        outputUsdPerMillion: gemini.outputUsdPerMillion,
        softBudgetUsd: budget.softBudgetUsd,
        geminiModel: gemini.model,
      }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid configuration.";
    return Response.json(
      {
        roboflowConfigured: false,
        geminiConfigured: false,
        error: message,
      },
      { status: 500 },
    );
  }
}
