import { getRoboflowConfig } from "@/lib/config";
import { jpegCacheKey, readInferenceCache, writeInferenceCache } from "@/lib/inference-cache";
import { assertUnderVercelLimit } from "@/lib/payload";
import { inferFrameFromBase64, QuotaError } from "@/lib/roboflow";
import type { FrameDetections } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

type IncomingFrame = {
  timestamp: number;
  imageBase64: string;
  width: number;
  height: number;
};

export async function POST(request: Request) {
  let body: { sessionId?: string; force?: boolean; frames?: IncomingFrame[] };
  try {
    body = (await request.json()) as { sessionId?: string; force?: boolean; frames?: IncomingFrame[] };
  } catch {
    return Response.json({ message: "Invalid JSON body." }, { status: 400 });
  }

  const frames = Array.isArray(body.frames) ? body.frames : [];
  if (frames.length === 0) {
    return Response.json({ message: "No frames were provided." }, { status: 400 });
  }
  if (frames.length > 8) {
    return Response.json({ message: "Send at most 8 Roboflow frames per request." }, { status: 400 });
  }

  try {
    assertUnderVercelLimit(body, "Roboflow batch");
    const config = getRoboflowConfig();
    if (!config.apiKey) {
      return Response.json(
        { message: "ROBOFLOW_API_KEY is not set on the server." },
        { status: 500 },
      );
    }

    const results: FrameDetections[] = [];
    let cached = 0;
    let billed = 0;

    for (const frame of frames) {
      const key = jpegCacheKey(frame.imageBase64, config.endpoint);
      const hit = body.force ? null : await readInferenceCache(key);
      if (hit?.[0]) {
        cached += 1;
        results.push({
          ...hit[0],
          timestamp: frame.timestamp,
          imageWidth: hit[0].imageWidth || frame.width,
          imageHeight: hit[0].imageHeight || frame.height,
        });
        continue;
      }

      const inference = await inferFrameFromBase64(frame.imageBase64, {
        width: frame.width,
        height: frame.height,
      });
      const detected: FrameDetections = {
        timestamp: frame.timestamp,
        imageWidth: inference.imageWidth,
        imageHeight: inference.imageHeight,
        inferenceId: inference.inferenceId,
        detections: inference.detections,
      };
      billed += 1;
      await writeInferenceCache(key, [detected]);
      results.push(detected);
    }

    const payload = {
      sessionId: body.sessionId,
      frames: results,
      cached,
      billed,
    };
    assertUnderVercelLimit(payload, "Roboflow response");
    return Response.json(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Roboflow batch failed.";
    const status = error instanceof QuotaError ? 429 : 500;
    return Response.json({ message }, { status });
  }
}
