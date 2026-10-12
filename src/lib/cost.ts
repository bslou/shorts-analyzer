import type { BudgetEstimate, CostLine } from "./types";

export type CostEstimate = {
  roboflowFrames: number;
  geminiFrames: number;
  roboflow: CostLine;
  gemini: CostLine;
  totalUsd: number;
  softBudgetUsd: number;
  overBudget: boolean;
  notes: string[];
};

export function toBudgetEvent(estimate: CostEstimate): BudgetEstimate {
  return {
    roboflowUsd: estimate.roboflow.usd,
    geminiUsd: estimate.gemini.usd,
    totalUsd: estimate.totalUsd,
    softBudgetUsd: estimate.softBudgetUsd,
    roboflowFrames: estimate.roboflowFrames,
    geminiFrames: estimate.geminiFrames,
    notes: estimate.notes,
  };
}

export function adaptiveFrameTarget(
  duration: number,
  minFrames: number,
  maxFrames: number,
  transitionCount = 0,
) {
  const span = Math.min(Math.max(duration, 20), 70);
  const t = (span - 25) / 35;
  const base = 24 + t * 12;
  const extra = Math.min(4, Math.floor(Math.max(0, transitionCount) / 4));
  return Math.round(Math.min(maxFrames, Math.max(minFrames, base + extra)));
}

export function estimateGeminiTokens(frameCount: number, hasAudio: boolean) {
  const input = 2500 + frameCount * 1400 + (hasAudio ? 1800 : 0);
  const output = 2200;
  return { input, output };
}

export function usdFromTokens(
  inputTokens: number,
  outputTokens: number,
  inputUsdPerMillion: number,
  outputUsdPerMillion: number,
) {
  return Number(
    ((inputTokens / 1_000_000) * inputUsdPerMillion + (outputTokens / 1_000_000) * outputUsdPerMillion).toFixed(6),
  );
}

export function estimateAnalysisCost(input: {
  roboflowFramesToBill: number;
  geminiWillBill: boolean;
  geminiFrames: number;
  hasAudio: boolean;
  roboflowUsdPerImage: number;
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  softBudgetUsd: number;
  geminiModel: string;
}): CostEstimate {
  const roboflowUsd = Number((input.roboflowFramesToBill * input.roboflowUsdPerImage).toFixed(6));
  const tokens = estimateGeminiTokens(input.geminiFrames, input.hasAudio);
  const geminiUsd = input.geminiWillBill
    ? usdFromTokens(tokens.input, tokens.output, input.inputUsdPerMillion, input.outputUsdPerMillion)
    : 0;
  const totalUsd = Number((roboflowUsd + geminiUsd).toFixed(6));
  const notes = [
    input.roboflowFramesToBill
      ? `Roboflow: ${input.roboflowFramesToBill} Workflow calls, estimate at $${input.roboflowUsdPerImage} per image.`
      : "Roboflow: cache hit — no new calls.",
    input.geminiWillBill
      ? `Gemini ${input.geminiModel}: one request, ~${tokens.input} input / ${tokens.output} output tokens (estimate until the API returns usage).`
      : "Gemini: cache hit — no new call.",
    "Estimates use configured list prices. Actual Gemini $ uses returned token counts when the request completes.",
  ];
  return {
    roboflowFrames: input.roboflowFramesToBill,
    geminiFrames: input.geminiFrames,
    roboflow: {
      usd: roboflowUsd,
      source: input.roboflowFramesToBill ? "estimate" : "cached",
      label: input.roboflowFramesToBill ? "estimate" : "cache hit",
    },
    gemini: {
      usd: geminiUsd,
      source: input.geminiWillBill ? "estimate" : "cached",
      label: input.geminiWillBill ? "estimate" : "cache hit",
    },
    totalUsd,
    softBudgetUsd: input.softBudgetUsd,
    overBudget: totalUsd > input.softBudgetUsd + 1e-9,
    notes,
  };
}
