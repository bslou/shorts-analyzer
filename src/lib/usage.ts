import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { UsageReport } from "./types";

export type { UsageReport };

export function emptyUsage(): UsageReport {
  const zero = { usd: 0, source: "cached" as const, label: "cache hit" };
  return {
    roboflowCalls: 0,
    roboflowCachedFrames: 0,
    roboflowCreditsEstimate: 0,
    roboflowUsd: { ...zero },
    geminiRequests: 0,
    geminiInputTokens: 0,
    geminiOutputTokens: 0,
    geminiUsd: { ...zero },
    totalUsd: 0,
    softBudgetUsd: 0.05,
    overBudget: false,
    geminiModel: "",
    sampledFrames: 0,
    geminiFrames: 0,
    notes: [],
  };
}

export async function logUsage(report: UsageReport) {
  const dir = path.join(process.cwd(), ".cache");
  await mkdir(dir, { recursive: true });
  const line = JSON.stringify({ at: new Date().toISOString(), ...report });
  await appendFile(path.join(dir, "usage.jsonl"), `${line}\n`);
  console.info("[api-usage]", line);
}
