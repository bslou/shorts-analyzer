import { spawn } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { lastSafeTimestamp } from "./sample-plan";
import type { SceneCut, VideoMetadata } from "./types";

export type ExtractedFrame = {
  timestamp: number;
  path: string;
  width: number;
  height: number;
};

function quoteArg(value: string) {
  return /[\s"']/.test(value) ? JSON.stringify(value) : value;
}

function commandLine(command: string, args: string[]) {
  return [command, ...args.map(quoteArg)].join(" ");
}

function run(
  command: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      reject(
        new Error(
          `${command} failed to start. Install FFmpeg and ensure it is on PATH. ${error.message}`,
        ),
      );
    });
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

async function runOrThrow(command: string, args: string[]) {
  const result = await run(command, args);
  if (result.code !== 0) {
    throw new Error(`${command} exited with code ${result.code}: ${result.stderr.slice(-2000)}`);
  }
  return result;
}

async function jpegExists(filePath: string) {
  try {
    const info = await stat(filePath);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

type FfprobeStream = {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  duration?: string;
  nb_frames?: string;
};

type FfprobeJson = {
  format?: { duration?: string };
  streams?: FfprobeStream[];
};

function parseFrameRate(value?: string) {
  if (!value || value === "0/0") return 0;
  const [num, den] = value.split("/").map(Number);
  if (!den) return num || 0;
  return num / den;
}

export async function probeVideo(filePath: string, fileName: string): Promise<VideoMetadata> {
  const { stdout } = await runOrThrow("ffprobe", [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    filePath,
  ]);

  const probe = JSON.parse(stdout) as FfprobeJson;
  const videoStream = probe.streams?.find((stream) => stream.codec_type === "video");
  const audioStream = probe.streams?.find((stream) => stream.codec_type === "audio");
  const containerDuration = Number(probe.format?.duration ?? 0);
  const streamDuration = Number(videoStream?.duration ?? 0);
  const frameRate =
    parseFrameRate(videoStream?.avg_frame_rate) || parseFrameRate(videoStream?.r_frame_rate);
  const frameCount = Number(videoStream?.nb_frames ?? 0);
  const countedDuration =
    frameCount > 0 && frameRate > 0 ? (frameCount - 1) / frameRate : 0;
  // Container duration often follows audio and is past the last video frame.
  const duration = [countedDuration, streamDuration, containerDuration].find(
    (value) => Number.isFinite(value) && value > 0,
  );
  const width = videoStream?.width ?? 0;
  const height = videoStream?.height ?? 0;

  if (!videoStream || !width || !height || !duration) {
    throw new Error("Could not read video metadata. Upload a valid MP4 file.");
  }

  return {
    duration,
    width,
    height,
    frameRate,
    hasAudio: Boolean(audioStream),
    codec: videoStream.codec_name,
    fileName,
  };
}

export async function probeImage(filePath: string) {
  const exists = await jpegExists(filePath);
  if (!exists) {
    throw new Error(`ffprobe skipped missing or empty JPEG: ${filePath}`);
  }
  const { stdout } = await runOrThrow("ffprobe", [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_streams",
    filePath,
  ]);
  const probe = JSON.parse(stdout) as FfprobeJson;
  const stream = probe.streams?.find((item) => item.codec_type === "video");
  return { width: stream?.width ?? 0, height: stream?.height ?? 0 };
}

function jpegEncodeArgs(output: string) {
  return [
    "-an",
    "-frames:v",
    "1",
    "-vf",
    "scale='min(640\\,iw)':-2,format=yuvj420p",
    "-pix_fmt",
    "yuvj420p",
    "-threads",
    "1",
    "-q:v",
    "3",
    "-update",
    "1",
    output,
  ];
}

async function extractOneJpeg(videoPath: string, output: string, timestamp: number) {
  const seek = timestamp.toFixed(3);
  const attempts: string[][] = [
    ["-y", "-ss", seek, "-i", videoPath, ...jpegEncodeArgs(output)],
    ["-y", "-i", videoPath, "-ss", seek, ...jpegEncodeArgs(output)],
  ];

  let last = { code: 1, stderr: "", command: "" };
  for (const args of attempts) {
    const result = await run("ffmpeg", args);
    last = { code: result.code, stderr: result.stderr, command: commandLine("ffmpeg", args) };
    if (result.code === 0 && (await jpegExists(output))) {
      return { ok: true as const, command: last.command, code: result.code, stderr: result.stderr };
    }
    console.warn("[ffmpeg] frame extract failed", {
      timestamp,
      output,
      exitCode: result.code,
      command: last.command,
      stderr: result.stderr.slice(-800),
    });
  }
  return { ok: false as const, ...last };
}

export async function extractFramesAtTimestamps(
  videoPath: string,
  outputDir: string,
  timestamps: number[],
  options?: {
    duration?: number;
    frameRate?: number;
    onWarning?: (message: string) => void;
  },
) {
  const framesDir = path.join(outputDir, "frames");
  await mkdir(framesDir, { recursive: true });

  const lastSafe =
    options?.duration !== undefined
      ? lastSafeTimestamp(options.duration, options.frameRate ?? 30)
      : undefined;
  const seeks = timestamps.map((timestamp) =>
    lastSafe === undefined ? timestamp : Math.min(timestamp, lastSafe),
  );

  const frames: ExtractedFrame[] = [];
  const warnings: string[] = [];

  for (const timestamp of seeks) {
    const index = frames.length;
    const output = path.join(framesDir, `frame_${String(index).padStart(4, "0")}.jpg`);
    const extracted = await extractOneJpeg(videoPath, output, timestamp);
    if (!extracted.ok) {
      const message = `Skipped frame at ${timestamp.toFixed(3)}s (FFmpeg exit ${extracted.code}). Command: ${extracted.command}`;
      warnings.push(message);
      options?.onWarning?.(message);
      continue;
    }
    const size = await probeImage(output);
    if (!size.width || !size.height) {
      const message = `Skipped unreadable JPEG at ${timestamp.toFixed(3)}s: ${output}`;
      warnings.push(message);
      options?.onWarning?.(message);
      continue;
    }
    frames.push({ timestamp, path: output, width: size.width, height: size.height });
  }

  if (frames.length === 0) {
    throw new Error("FFmpeg did not produce any readable JPEG frames.");
  }
  if (frames.length < Math.min(3, seeks.length)) {
    throw new Error(
      `Only ${frames.length} JPEG frame(s) could be extracted from ${seeks.length} sample(s). ${warnings.join(" ")}`,
    );
  }

  return { frames, warnings };
}

export async function extractAudio(videoPath: string, outputDir: string) {
  const audioPath = path.join(outputDir, "audio.mp3");
  await runOrThrow("ffmpeg", [
    "-y",
    "-i",
    videoPath,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-b:a",
    "24k",
    audioPath,
  ]);
  return audioPath;
}

export async function detectSceneCuts(videoPath: string): Promise<SceneCut[]> {
  try {
    const { stderr, code } = await run("ffmpeg", [
      "-i",
      videoPath,
      "-vf",
      "select='gt(scene,0.35)',showinfo",
      "-fps_mode",
      "vfr",
      "-f",
      "null",
      "-",
    ]);
    if (code !== 0) return [];

    const cuts: SceneCut[] = [];
    const timeRegex = /pts_time:([0-9.]+)/g;
    let match: RegExpExecArray | null;
    while ((match = timeRegex.exec(stderr))) {
      cuts.push({ timestamp: Number(match[1]), score: 0.35 });
    }
    return cuts;
  } catch {
    return [];
  }
}

export async function analyzeAudioLevels(audioPath: string, duration: number) {
  const { stderr } = await runOrThrow("ffmpeg", [
    "-i",
    audioPath,
    "-af",
    "volumedetect,silencedetect=noise=-35dB:d=0.6",
    "-f",
    "null",
    "-",
  ]);

  const meanMatch = stderr.match(/mean_volume:\s*(-?[0-9.]+) dB/);
  const maxMatch = stderr.match(/max_volume:\s*(-?[0-9.]+) dB/);
  const silenceRanges: { start: number; end: number }[] = [];
  let silenceStart: number | null = null;

  for (const line of stderr.split("\n")) {
    const start = line.match(/silence_start:\s*([0-9.]+)/);
    const end = line.match(/silence_end:\s*([0-9.]+)/);
    if (start) silenceStart = Number(start[1]);
    if (end && silenceStart !== null) {
      silenceRanges.push({ start: silenceStart, end: Number(end[1]) });
      silenceStart = null;
    }
  }

  const meanVolumeDb = meanMatch ? Number(meanMatch[1]) : null;
  const maxVolumeDb = maxMatch ? Number(maxMatch[1]) : null;
  const notes = [
    meanVolumeDb !== null
      ? `Mean volume is ${meanVolumeDb.toFixed(1)} dB.`
      : "Could not measure mean volume.",
    silenceRanges.length
      ? `Detected ${silenceRanges.length} silence span(s) longer than 0.6s.`
      : "No long silence spans were detected at -35 dB.",
    "These measurements describe loudness and silence, not whether music is entertaining.",
  ].join(" ");

  return {
    implemented: true as const,
    hasAudio: true,
    meanVolumeDb,
    maxVolumeDb,
    silenceRanges: silenceRanges.filter((range) => range.end <= duration + 1),
    notes,
  };
}
