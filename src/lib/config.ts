const PUBLISHED_WORKFLOW_URL =
  "https://serverless.roboflow.com/benjamin-sloutsky-s-workspace/workflows/shorts-visual-timeline-1791839058578";
const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";

export function resolveWorkflowEndpoint(raw: string) {
  const cleaned = raw.trim().replace(/\/$/, "");
  const infer = cleaned.match(/^(https?:\/\/[^/]+)\/infer\/workflows\/([^/]+)\/([^/?#]+)$/i);
  if (infer) {
    return {
      endpoint: `${infer[1]}/infer/workflows/${infer[2]}/${infer[3]}`,
      workspace: infer[2],
      workflowId: infer[3],
    };
  }
  const published = cleaned.match(/^(https?:\/\/[^/]+)\/([^/]+)\/workflows\/([^/?#]+)$/i);
  if (published) {
    return {
      endpoint: `${published[1]}/infer/workflows/${published[2]}/${published[3]}`,
      workspace: published[2],
      workflowId: published[3],
    };
  }
  throw new Error(
    `ROBOFLOW_WORKFLOW_URL must be the published Workflow URL. Got: ${cleaned}`,
  );
}

function numberEnv(name: string, fallback: number, min = 0) {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) && value > min ? value : fallback;
}

export function getRoboflowConfig() {
  const apiKey = process.env.ROBOFLOW_API_KEY?.trim();
  const published = process.env.ROBOFLOW_WORKFLOW_URL?.trim() || PUBLISHED_WORKFLOW_URL;
  const resolved = resolveWorkflowEndpoint(published);
  const intervalSeconds = numberEnv("ROBOFLOW_FRAME_INTERVAL_SECONDS", 2);
  const hookSeconds = numberEnv("ROBOFLOW_HOOK_SECONDS", 5);
  const hookIntervalSeconds = numberEnv("ROBOFLOW_HOOK_INTERVAL_SECONDS", 1);
  const minFrames = Math.round(numberEnv("ROBOFLOW_MIN_FRAMES", 24));
  const maxFrames = Math.round(numberEnv("ROBOFLOW_MAX_FRAMES", 36));

  return {
    apiKey,
    publishedUrl: published.replace(/\/$/, ""),
    workflowName: resolved.workflowId,
    workspace: resolved.workspace,
    workflowId: resolved.workflowId,
    endpoint: resolved.endpoint,
    intervalSeconds,
    hookSeconds,
    hookIntervalSeconds,
    minFrames: Math.min(minFrames, maxFrames),
    maxFrames,
    creditsPerImage: numberEnv("ROBOFLOW_CREDITS_PER_IMAGE", 0.000125),
    usdPerImage: numberEnv("ROBOFLOW_USD_PER_IMAGE", 0.0008),
  };
}

export function getGeminiConfig() {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  const model = process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL;
  if (/flash-lite/i.test(model) && !process.env.GEMINI_ALLOW_LITE) {
    throw new Error(
      `Refusing ${model}. Editorial analysis stays on Gemini 2.5 Flash unless GEMINI_ALLOW_LITE=1 is set.`,
    );
  }
  if (/pro|thinking|ultra|opus|o3|o1|gpt-4(?!o-mini)/i.test(model) && !process.env.GEMINI_ALLOW_EXPENSIVE) {
    throw new Error(
      `Refusing to call ${model}. Stay on Gemini 2.5 Flash unless GEMINI_ALLOW_EXPENSIVE=1 is set.`,
    );
  }
  return {
    apiKey,
    model,
    maxFrames: Math.round(numberEnv("GEMINI_MAX_FRAMES", 12)),
    maxOutputTokens: Math.max(8192, Math.round(numberEnv("GEMINI_MAX_OUTPUT_TOKENS", 16384))),
    inputUsdPerMillion: numberEnv("GEMINI_INPUT_USD_PER_MILLION", 0.15),
    outputUsdPerMillion: numberEnv("GEMINI_OUTPUT_USD_PER_MILLION", 0.6),
  };
}

export function getBudgetConfig() {
  return {
    softBudgetUsd: numberEnv("ANALYSIS_SOFT_BUDGET_USD", 0.05),
  };
}
