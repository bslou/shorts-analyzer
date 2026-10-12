import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FrameDetections } from "./types";

function cacheDir() {
  return path.join(process.cwd(), ".cache", "roboflow");
}

export function cacheKey(parts: {
  fileBytes: Buffer;
  modelId: string;
  confidence: number;
  timestamps: number[];
}) {
  const hash = createHash("sha256");
  hash.update(parts.fileBytes);
  hash.update(parts.modelId);
  hash.update(String(parts.confidence));
  hash.update(parts.timestamps.map((t) => t.toFixed(3)).join(","));
  return hash.digest("hex");
}

export async function readInferenceCache(key: string): Promise<FrameDetections[] | null> {
  try {
    const raw = await readFile(path.join(cacheDir(), `${key}.json`), "utf8");
    const parsed = JSON.parse(raw) as FrameDetections[];
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function writeInferenceCache(key: string, frames: FrameDetections[]) {
  const dir = cacheDir();
  await mkdir(dir, { recursive: true });
  const slim = frames.map((frame) => ({
    timestamp: frame.timestamp,
    imageWidth: frame.imageWidth,
    imageHeight: frame.imageHeight,
    inferenceId: frame.inferenceId,
    detections: frame.detections,
  }));
  await writeFile(path.join(dir, `${key}.json`), JSON.stringify(slim));
}

function geminiCacheDir() {
  return path.join(process.cwd(), ".cache", "gemini");
}

export function geminiCacheKey(parts: {
  fileBytes: Buffer;
  geminiModel: string;
  workflowId: string;
  caption: string;
  detectionDigest: string;
}) {
  const hash = createHash("sha256");
  hash.update(parts.fileBytes);
  hash.update(parts.geminiModel);
  hash.update(parts.workflowId);
  hash.update(parts.caption);
  hash.update(parts.detectionDigest);
  return hash.digest("hex");
}

export async function readGeminiCache<T>(key: string): Promise<T | null> {
  try {
    const raw = await readFile(path.join(geminiCacheDir(), `${key}.json`), "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function writeGeminiCache(key: string, value: unknown) {
  const dir = geminiCacheDir();
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${key}.json`), JSON.stringify(value));
}
