import { adaptiveFrameTarget } from "./cost";

export function lastSafeTimestamp(duration: number, frameRate: number) {
  const fps = Number.isFinite(frameRate) && frameRate > 1 ? frameRate : 30;
  const framePeriod = 1 / fps;
  const pad = Math.max(framePeriod * 2, 0.12);
  return Number(Math.max(0, duration - pad).toFixed(3));
}

function add(set: Set<number>, value: number, lastSafe: number) {
  if (!Number.isFinite(value) || value < 0) return;
  set.add(Number(Math.min(Math.max(value, 0), lastSafe).toFixed(3)));
}

export function planSampleTimestamps(options: {
  duration: number;
  intervalSeconds: number;
  hookSeconds: number;
  hookIntervalSeconds: number;
  minFrames: number;
  maxFrames: number;
  frameRate?: number;
  extraTimestamps?: number[];
  endSeconds?: number;
}) {
  const duration = Math.max(options.duration, 0);
  const lastSafe = lastSafeTimestamp(duration, options.frameRate ?? 30);
  const extras = options.extraTimestamps ?? [];
  const target = adaptiveFrameTarget(duration, options.minFrames, options.maxFrames, extras.length);
  const hookEnd = Math.min(options.hookSeconds, lastSafe);
  const endWindow = Math.min(options.endSeconds ?? 2.5, lastSafe);
  const timestamps = new Set<number>();

  add(timestamps, 0, lastSafe);
  add(timestamps, lastSafe, lastSafe);
  for (let t = 0; t <= hookEnd + 1e-6; t += options.hookIntervalSeconds) {
    add(timestamps, t, lastSafe);
  }
  for (let t = lastSafe; t >= Math.max(hookEnd, lastSafe - endWindow) - 1e-6; t -= 1) {
    add(timestamps, t, lastSafe);
  }
  for (const extra of extras) add(timestamps, extra, lastSafe);

  const bodyStart = hookEnd > 0 ? hookEnd : 0;
  for (let t = bodyStart; t < lastSafe; t += options.intervalSeconds) {
    add(timestamps, t, lastSafe);
  }

  let sorted = [...timestamps].sort((a, b) => a - b);
  if (sorted.length < target) {
    const needed = target - sorted.length;
    for (let i = 1; i <= needed; i += 1) {
      add(timestamps, (i * lastSafe) / (needed + 1), lastSafe);
    }
    sorted = [...timestamps].sort((a, b) => a - b);
  }

  if (sorted.length <= target) return sorted;

  const keep = new Set<number>();
  add(keep, 0, lastSafe);
  add(keep, lastSafe, lastSafe);
  for (const t of sorted) {
    if (t <= hookEnd || t >= lastSafe - endWindow) keep.add(t);
  }
  const rest = sorted.filter((t) => !keep.has(t));
  const remaining = Math.max(target - keep.size, 0);
  if (remaining > 0 && rest.length) {
    if (rest.length <= remaining) {
      rest.forEach((t) => keep.add(t));
    } else {
      for (let i = 0; i < remaining; i += 1) {
        const index = Math.round((i * (rest.length - 1)) / Math.max(remaining - 1, 1));
        keep.add(rest[index]);
      }
    }
  }

  return [...keep].sort((a, b) => a - b).slice(0, options.maxFrames);
}
