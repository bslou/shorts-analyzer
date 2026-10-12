import type { FrameDetections, VisualChange, VisualStats } from "./types";

function classSet(frame: FrameDetections) {
  return new Set(frame.detections.map((detection) => detection.class));
}

function jaccard(a: Set<string>, b: Set<string>) {
  if (a.size === 0 && b.size === 0) return 1;
  const intersection = [...a].filter((value) => b.has(value)).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 1 : intersection / union;
}

export function computeVisualStats(
  frames: FrameDetections[],
  intervalSeconds: number,
): VisualStats {
  const classCounts: Record<string, number> = {};
  const detectionsPerFrame = frames.map((frame) => frame.detections.length);
  const uniqueClasses = new Set<string>();

  for (const frame of frames) {
    for (const detection of frame.detections) {
      uniqueClasses.add(detection.class);
      classCounts[detection.class] = (classCounts[detection.class] ?? 0) + 1;
    }
  }

  const visualChanges: VisualChange[] = [];
  let lowStart: number | null = frames[0]?.timestamp ?? null;
  let longest = { start: 0, end: 0, seconds: 0 };

  for (let i = 1; i < frames.length; i += 1) {
    const previous = classSet(frames[i - 1]);
    const current = classSet(frames[i]);
    const similarity = jaccard(previous, current);
    const added = [...current].filter((value) => !previous.has(value));
    const removed = [...previous].filter((value) => !current.has(value));
    const countDelta = Math.abs(frames[i].detections.length - frames[i - 1].detections.length);
    const personFlip =
      previous.has("person") !== current.has("person") ||
      previous.has("Person") !== current.has("Person");
    const significant =
      (similarity <= 0.35 && added.length + removed.length >= 2) ||
      (personFlip && (added.length > 0 || removed.length > 0) && similarity <= 0.6) ||
      (countDelta >= 3 && similarity <= 0.45);

    if (significant) {
      visualChanges.push({
        timestamp: frames[i].timestamp,
        previousTimestamp: frames[i - 1].timestamp,
        added,
        removed,
        similarity,
        note: "Likely visual composition change between sampled frames — not labeled as a scene cut.",
      });
      if (lowStart !== null) {
        const seconds = frames[i].timestamp - lowStart;
        if (seconds > longest.seconds) {
          longest = { start: lowStart, end: frames[i].timestamp, seconds };
        }
      }
      lowStart = frames[i].timestamp;
    }
  }

  const last = frames.at(-1)?.timestamp ?? 0;
  if (lowStart !== null) {
    const seconds = last - lowStart;
    if (seconds > longest.seconds) {
      longest = { start: lowStart, end: last, seconds };
    }
  }

  return {
    sampledFrameCount: frames.length,
    intervalSeconds,
    uniqueClasses: [...uniqueClasses].sort(),
    classCounts,
    detectionsPerFrame,
    visualChanges,
    longestLowChangeSpan: longest.seconds > 0 ? longest : null,
  };
}
