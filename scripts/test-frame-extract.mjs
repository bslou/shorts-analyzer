import { spawn } from "node:child_process";
import { mkdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

function lastSafeTimestamp(duration, frameRate) {
  const fps = frameRate > 1 ? frameRate : 30;
  const pad = Math.max((1 / fps) * 2, 0.12);
  return Number(Math.max(0, duration - pad).toFixed(3));
}

function planSampleTimestamps({ duration, intervalSeconds, hookSeconds, hookIntervalSeconds, maxFrames, frameRate }) {
  const lastSafe = lastSafeTimestamp(duration, frameRate);
  const timestamps = new Set();
  const hookEnd = Math.min(hookSeconds, lastSafe);
  for (let t = 0; t <= hookEnd + 1e-6; t += hookIntervalSeconds) {
    timestamps.add(Number(Math.min(t, lastSafe).toFixed(3)));
  }
  for (let t = hookEnd; t < lastSafe; t += intervalSeconds) {
    timestamps.add(Number(Math.min(t, lastSafe).toFixed(3)));
  }
  timestamps.add(lastSafe);
  const sorted = [...timestamps].sort((a, b) => a - b);
  if (sorted.length <= maxFrames) return sorted;
  const hook = sorted.filter((t) => t <= hookEnd);
  const body = sorted.filter((t) => t > hookEnd);
  const remaining = Math.max(maxFrames - hook.length, 0);
  const picked = [];
  for (let i = 0; i < remaining; i += 1) {
    const index = Math.round((i * (body.length - 1)) / Math.max(remaining - 1, 1));
    picked.push(body[index]);
  }
  return [...new Set([...hook, ...picked])].sort((a, b) => a - b).slice(0, maxFrames);
}

const SCALE = "scale='min(640\\,iw)':-2,format=yuvj420p";

async function extractJpeg(videoPath, output, timestamp, mode = "fast") {
  const seek = Number(timestamp).toFixed(3);
  const args =
    mode === "fast"
      ? ["-y", "-ss", seek, "-i", videoPath]
      : ["-y", "-i", videoPath, "-ss", seek];
  args.push(
    "-an",
    "-frames:v",
    "1",
    "-vf",
    SCALE,
    "-pix_fmt",
    "yuvj420p",
    "-threads",
    "1",
    "-q:v",
    "3",
    "-update",
    "1",
    output,
  );
  return run("ffmpeg", args);
}

async function probeVideo(filePath) {
  const result = await run("ffprobe", [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    filePath,
  ]);
  if (result.code !== 0) throw new Error(result.stderr);
  return JSON.parse(result.stdout);
}

async function main() {
  const source = process.argv[2];
  if (!source) {
    throw new Error("Pass the 35.29s 1080x1920 MP4 path as the first argument.");
  }

  const probe = await probeVideo(source);
  const stream = probe.streams.find((item) => item.codec_type === "video");
  const containerDuration = Number(probe.format.duration);
  const streamDuration = Number(stream.duration || 0);
  const [num, den] = String(stream.avg_frame_rate || "30/1").split("/").map(Number);
  const frameRate = den ? num / den : num;
  const frameCount = Number(stream.nb_frames || 0);
  const countedDuration = frameCount > 0 && frameRate > 0 ? (frameCount - 1) / frameRate : 0;
  const duration = [countedDuration, streamDuration, containerDuration].find((value) => value > 0);
  console.log({
    source,
    duration,
    width: stream.width,
    height: stream.height,
    fps: Number(frameRate.toFixed(3)),
  });

  const work = path.join(os.tmpdir(), `frame-extract-${Date.now()}`);
  await mkdir(path.join(work, "frames"), { recursive: true });

  try {
    const eof = path.join(work, "beyond-eof.jpg");
    const eofResult = await extractJpeg(source, eof, duration, "fast");
    let eofExists = false;
    try {
      eofExists = (await stat(eof)).size > 0;
    } catch {
      eofExists = false;
    }
    console.log("eof-seek-at-duration", {
      timestamp: duration,
      exitCode: eofResult.code,
      jpegWritten: eofExists,
      note: "This is the failure mode for frame_0021.jpg: FFmpeg can return 0 or 1 without a JPEG when seek is at/past the last frame.",
    });

    const timestamps = planSampleTimestamps({
      duration,
      intervalSeconds: 2,
      hookSeconds: 5,
      hookIntervalSeconds: 1,
      maxFrames: 24,
      frameRate,
    });
    console.log("plannedTimestamps", timestamps.length, timestamps.at(-1));

    const frames = [];
    for (const timestamp of timestamps) {
      const output = path.join(work, "frames", `frame_${String(frames.length).padStart(4, "0")}.jpg`);
      let result = await extractJpeg(source, output, timestamp, "fast");
      let exists = false;
      try {
        exists = (await stat(output)).size > 0;
      } catch {
        exists = false;
      }
      if (!exists) {
        result = await extractJpeg(source, output, timestamp, "accurate");
        try {
          exists = (await stat(output)).size > 0;
        } catch {
          exists = false;
        }
      }
      if (!exists) {
        throw new Error(`Missing JPEG for ${timestamp}s exit=${result.code} file=${output}`);
      }
      const image = await run("ffprobe", [
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_streams",
        output,
      ]);
      if (image.code !== 0) throw new Error(`ffprobe failed for ${output}: ${image.stderr}`);
      const jpeg = JSON.parse(image.stdout).streams[0];
      if (jpeg.codec_name !== "mjpeg" || jpeg.width > 640) {
        throw new Error(`Invalid JPEG ${output}`);
      }
      frames.push({
        timestamp,
        file: path.basename(output),
        bytes: (await stat(output)).size,
        width: jpeg.width,
        height: jpeg.height,
      });
    }

    console.log(
      JSON.stringify({
        ok: true,
        sampled: frames.length,
        first: frames[0],
        last: frames.at(-1),
      }),
    );
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
