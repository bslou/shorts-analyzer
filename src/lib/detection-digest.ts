import { createHash } from "node:crypto";
import type { FrameDetections } from "./types";

export function detectionDigest(frames: FrameDetections[]) {
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
