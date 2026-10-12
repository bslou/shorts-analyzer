import { readFile } from "node:fs/promises";
import { getRoboflowConfig } from "./config";
import { stripDataUrl } from "./payload";
import type { Detection, FrameDetections } from "./types";

type WorkflowPrediction = {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  confidence?: number;
  class?: string;
  class_name?: string;
  class_id?: number;
};

type WorkflowResponse = {
  outputs?: unknown;
  predictions?: unknown;
  message?: string;
  error?: string;
  detail?: string;
};

export class QuotaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuotaError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function extractPredictionList(payload: unknown): WorkflowPrediction[] {
  if (Array.isArray(payload)) {
    const first = payload[0];
    if (isRecord(first) && "predictions" in first) {
      return extractPredictionList(first.predictions);
    }
    return payload as WorkflowPrediction[];
  }
  if (!isRecord(payload)) return [];
  if (Array.isArray(payload.predictions)) {
    return payload.predictions as WorkflowPrediction[];
  }
  if (isRecord(payload.predictions)) {
    return extractPredictionList(payload.predictions);
  }
  return [];
}

export function parseWorkflowDetections(payload: unknown): {
  detections: Detection[];
  imageWidth?: number;
  imageHeight?: number;
} {
  const root = isRecord(payload) ? payload : {};
  const outputs = root.outputs;
  const firstOutput = Array.isArray(outputs) ? outputs[0] : outputs;
  const predictionsNode = isRecord(firstOutput) ? firstOutput.predictions : undefined;
  const list = extractPredictionList(predictionsNode ?? root.predictions ?? payload);

  let imageWidth: number | undefined;
  let imageHeight: number | undefined;
  if (isRecord(predictionsNode) && isRecord(predictionsNode.image)) {
    imageWidth = asNumber(predictionsNode.image.width);
    imageHeight = asNumber(predictionsNode.image.height);
  } else if (isRecord(root.image)) {
    imageWidth = asNumber(root.image.width);
    imageHeight = asNumber(root.image.height);
  }

  const detections: Detection[] = [];
  for (const item of list) {
    const cls = item.class || item.class_name;
    const x = asNumber(item.x);
    const y = asNumber(item.y);
    const width = asNumber(item.width);
    const height = asNumber(item.height);
    const confidence = asNumber(item.confidence);
    if (!cls || x === undefined || y === undefined || width === undefined || height === undefined) {
      continue;
    }
    detections.push({
      class: cls,
      classId: item.class_id,
      confidence: confidence ?? 0,
      boundingBox: { x, y, width, height },
    });
  }

  return { detections, imageWidth, imageHeight };
}

export async function inferFrame(
  framePath: string,
  frameSize: { width: number; height: number },
): Promise<{
  detections: Detection[];
  imageWidth: number;
  imageHeight: number;
  inferenceId?: string;
}> {
  const config = getRoboflowConfig();
  if (!config.apiKey) {
    throw new Error(
      "ROBOFLOW_API_KEY is not set. Add it to .env.local. Get a key from https://app.roboflow.com/settings/api",
    );
  }

  const bytes = await readFile(framePath);
  return inferFrameFromBase64(bytes.toString("base64"), frameSize);
}

export async function inferFrameFromBase64(
  imageBase64: string,
  frameSize: { width: number; height: number },
): Promise<{
  detections: Detection[];
  imageWidth: number;
  imageHeight: number;
  inferenceId?: string;
}> {
  const config = getRoboflowConfig();
  if (!config.apiKey) {
    throw new Error(
      "ROBOFLOW_API_KEY is not set. Add it to .env.local. Get a key from https://app.roboflow.com/settings/api",
    );
  }

  const url = new URL(config.endpoint);
  url.searchParams.set("api_key", config.apiKey);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      api_key: config.apiKey,
      inputs: {
        image: {
          type: "base64",
          value: stripDataUrl(imageBase64),
        },
      },
    }),
  });

  const text = await response.text();
  let parsed: WorkflowResponse = {};
  try {
    parsed = JSON.parse(text) as WorkflowResponse;
  } catch {
    throw new Error(
      `Roboflow Workflow returned a non-JSON response (${response.status}): ${text.slice(0, 400)}`,
    );
  }

  if (response.status === 402 || response.status === 429) {
    throw new QuotaError(
      `Roboflow free-tier or rate limit reached (HTTP ${response.status}). The app will not retry. ${parsed.message || parsed.error || parsed.detail || ""}`.trim(),
    );
  }

  if (!response.ok) {
    const body = parsed.message || parsed.error || parsed.detail || text.slice(0, 500);
    throw new Error(
      `Roboflow Workflow HTTP ${response.status} at ${config.endpoint}. ${body}`,
    );
  }

  const parsedDetections = parseWorkflowDetections(parsed);
  return {
    detections: parsedDetections.detections,
    imageWidth: parsedDetections.imageWidth || frameSize.width,
    imageHeight: parsedDetections.imageHeight || frameSize.height,
  };
}

export async function inferFrames(
  frames: { timestamp: number; path: string; width: number; height: number }[],
  onProgress?: (completed: number, total: number) => void,
): Promise<FrameDetections[]> {
  const results: FrameDetections[] = new Array(frames.length);
  const concurrency = 2;
  let next = 0;
  let completed = 0;
  let fatal: Error | null = null;

  async function worker() {
    while (next < frames.length && !fatal) {
      const index = next++;
      const frame = frames[index];
      try {
        const inference = await inferFrame(frame.path, {
          width: frame.width,
          height: frame.height,
        });
        results[index] = {
          timestamp: frame.timestamp,
          imageWidth: inference.imageWidth,
          imageHeight: inference.imageHeight,
          inferenceId: inference.inferenceId,
          detections: inference.detections,
        };
      } catch (error) {
        if (error instanceof QuotaError) {
          fatal = error;
          return;
        }
        throw error;
      }
      completed += 1;
      onProgress?.(completed, frames.length);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, frames.length) }, () => worker()));
  if (fatal) throw fatal;
  return results;
}
