import type { AnalysisResult, Detection, FrameDetections, VisualChange } from "./types";

export function nearestFrame(result: AnalysisResult, time: number): FrameDetections | null {
  if (result.frames.length === 0) return null;
  return result.frames.reduce((best, frame) =>
    Math.abs(frame.timestamp - time) < Math.abs(best.timestamp - time) ? frame : best,
  );
}

export function summarizeDetections(detections: Detection[], limit = 4) {
  const ranked = [...detections].sort((a, b) => b.confidence - a.confidence).slice(0, limit);
  return ranked.map((detection) => ({
    class: detection.class,
    confidence: detection.confidence,
  }));
}

export function compositionShiftsNear(result: AnalysisResult, time: number, window = 4): VisualChange[] {
  return result.visualStats.visualChanges.filter(
    (change) => Math.abs(change.timestamp - time) <= window || Math.abs(change.previousTimestamp - time) <= window,
  );
}

export function detectionsForNote(result: AnalysisResult, timestamp?: number) {
  if (timestamp === undefined) return null;
  const frame = nearestFrame(result, timestamp);
  if (!frame) return null;
  return {
    timestamp: frame.timestamp,
    detections: summarizeDetections(frame.detections),
    shifts: compositionShiftsNear(result, timestamp),
  };
}

export function detectionsInWindow(result: AnalysisResult, start: number, end: number) {
  const frames = result.frames.filter((frame) => frame.timestamp >= start && frame.timestamp <= end);
  const classes = new Set<string>();
  for (const frame of frames) {
    for (const detection of frame.detections) classes.add(detection.class);
  }
  return {
    frameCount: frames.length,
    classes: [...classes].sort(),
    shifts: result.visualStats.visualChanges.filter(
      (change) => change.timestamp >= start && change.timestamp <= end,
    ),
  };
}
