function nearestFrameIndex(frames: { timestamp: number }[], target: number) {
  let best = 0;
  let bestDist = Infinity;
  frames.forEach((frame, index) => {
    const dist = Math.abs(frame.timestamp - target);
    if (dist < bestDist) {
      best = index;
      bestDist = dist;
    }
  });
  return best;
}

export function pickGeminiFrames<T extends { timestamp: number }>(
  frames: T[],
  maxFrames: number,
  extraTimestamps: number[] = [],
) {
  if (frames.length <= maxFrames) return frames;
  const wanted = new Set<number>();
  wanted.add(0);
  wanted.add(frames.length - 1);
  for (let i = 0; i < frames.length && frames[i].timestamp <= 5; i += 1) {
    if (wanted.size < Math.min(4, maxFrames)) wanted.add(i);
  }
  for (const timestamp of extraTimestamps) {
    if (wanted.size >= maxFrames) break;
    wanted.add(nearestFrameIndex(frames, timestamp));
  }
  const evenCount = maxFrames;
  for (let i = 0; i < evenCount && wanted.size < maxFrames; i += 1) {
    const index = Math.round((i * (frames.length - 1)) / Math.max(evenCount - 1, 1));
    wanted.add(index);
  }
  return [...wanted]
    .sort((a, b) => a - b)
    .slice(0, maxFrames)
    .map((index) => frames[index]);
}
