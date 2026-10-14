"use client";

import {
  AUDIO_SAMPLE_RATE,
  GEMINI_AUDIO_MIME_BASES,
  GEMINI_AUDIO_RECORDER_TYPES,
  JPEG_MAX_WIDTH,
} from "./constants";
import { lastSafeTimestamp, planSampleTimestamps } from "./sample-plan";
import type { AudioInsights, SceneCut, VideoMetadata } from "./types";

export type ExtractedJpeg = {
  timestamp: number;
  width: number;
  height: number;
  base64: string;
  dataUrl: string;
  bytes: number;
};

function even(value: number) {
  return Math.max(2, Math.round(value / 2) * 2);
}

function waitForVideoFrame(video: HTMLVideoElement) {
  return new Promise<void>((resolve) => {
    const timer = window.setTimeout(() => resolve(), 90);
    const done = () => {
      window.clearTimeout(timer);
      resolve();
    };
    const rvfc = (
      video as HTMLVideoElement & {
        requestVideoFrameCallback?: (cb: () => void) => number;
      }
    ).requestVideoFrameCallback;
    if (typeof rvfc === "function") {
      rvfc.call(video, () => done());
      return;
    }
    requestAnimationFrame(() => done());
  });
}

async function seekVideo(video: HTMLVideoElement, timestamp: number, quick = false) {
  const target = Math.min(Math.max(timestamp, 0), Math.max(video.duration - 0.05, 0));
  const attempts = quick ? 1 : 2;
  const timeoutMs = quick ? 350 : 700;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        video.removeEventListener("seeked", finish);
        resolve();
      };
      const timer = window.setTimeout(finish, timeoutMs);
      video.addEventListener("seeked", finish);
      if (Math.abs(video.currentTime - target) < 0.04 && video.readyState >= 2) {
        finish();
        return;
      }
      try {
        video.currentTime = target;
      } catch {
        finish();
      }
    });
    await waitForVideoFrame(video);
    if (Math.abs(video.currentTime - target) <= 0.12 && video.readyState >= 2) return;
  }
  if (Math.abs(video.currentTime - target) > 0.2) {
    throw new Error(`Could not seek to ${timestamp.toFixed(2)}s (at ${video.currentTime.toFixed(2)}s).`);
  }
}

function canvasToJpeg(
  video: HTMLVideoElement,
  maxWidth: number,
  quality: number,
): Promise<{ blob: Blob; width: number; height: number }> {
  const scale = Math.min(1, maxWidth / video.videoWidth);
  const width = even(video.videoWidth * scale);
  const height = even(video.videoHeight * scale);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Could not create a 2D canvas for frame extraction.");
  ctx.drawImage(video, 0, 0, width, height);
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error("Canvas failed to encode a JPEG frame."));
          return;
        }
        resolve({ blob, width, height });
      },
      "image/jpeg",
      quality,
    );
  });
}

async function blobToBase64(blob: Blob) {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export async function detectBrowserSceneCuts(
  video: HTMLVideoElement,
  duration: number,
): Promise<SceneCut[]> {
  const step = 1;
  const cuts: SceneCut[] = [];
  const sampleW = 48;
  const sampleH = 86;
  const canvas = document.createElement("canvas");
  canvas.width = sampleW;
  canvas.height = sampleH;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return [];
  let previous: Uint8ClampedArray | null = null;
  for (let t = 0; t < duration - 0.05; t += step) {
    try {
      await seekVideo(video, t, true);
    } catch {
      continue;
    }
    ctx.drawImage(video, 0, 0, sampleW, sampleH);
    const pixels = ctx.getImageData(0, 0, sampleW, sampleH).data;
    if (previous) {
      let acc = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        const lum = pixels[i] * 0.299 + pixels[i + 1] * 0.587 + pixels[i + 2] * 0.114;
        const prevLum = previous[i] * 0.299 + previous[i + 1] * 0.587 + previous[i + 2] * 0.114;
        acc += Math.abs(lum - prevLum);
      }
      const mad = acc / (sampleW * sampleH);
      if (mad >= 28) cuts.push({ timestamp: Number(t.toFixed(3)), score: Number((mad / 80).toFixed(3)) });
    }
    previous = pixels;
  }
  return cuts;
}

export async function extractJpegAtTimestamp(
  video: HTMLVideoElement,
  timestamp: number,
  options?: { maxWidth?: number; quality?: number },
): Promise<ExtractedJpeg> {
  await seekVideo(video, timestamp);
  await waitForVideoFrame(video);
  const maxWidth = options?.maxWidth ?? JPEG_MAX_WIDTH;
  let quality = options?.quality ?? 0.85;
  let encoded = await canvasToJpeg(video, maxWidth, quality);
  while (!options?.quality && encoded.blob.size > 220_000 && quality > 0.62) {
    quality -= 0.08;
    encoded = await canvasToJpeg(video, maxWidth, quality);
  }
  const base64 = await blobToBase64(encoded.blob);
  return {
    timestamp: Number(timestamp.toFixed(3)),
    width: encoded.width,
    height: encoded.height,
    base64,
    dataUrl: `data:image/jpeg;base64,${base64}`,
    bytes: encoded.blob.size,
  };
}

function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Could not re-encode a Gemini JPEG."));
    image.src = src;
  });
}

/** Re-encode one Gemini JPEG. Does not mutate the original Roboflow frame. */
export async function recompressJpeg(
  frame: ExtractedJpeg,
  maxWidth: number,
  quality: number,
): Promise<ExtractedJpeg> {
  const image = await loadImage(frame.dataUrl);
  const scale = Math.min(1, maxWidth / Math.max(image.width, 1));
  const width = even(image.width * scale);
  const height = even(image.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not create a 2D canvas to shrink a Gemini JPEG.");
  ctx.drawImage(image, 0, 0, width, height);
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (encoded) => {
        if (!encoded) {
          reject(new Error("Canvas failed to re-encode a Gemini JPEG."));
          return;
        }
        resolve(encoded);
      },
      "image/jpeg",
      quality,
    );
  });
  if (blob.size >= frame.bytes && width >= frame.width) return frame;
  const base64 = await blobToBase64(blob);
  return {
    timestamp: frame.timestamp,
    width,
    height,
    base64,
    dataUrl: `data:image/jpeg;base64,${base64}`,
    bytes: blob.size,
  };
}

export function geminiCompatibleAudioMime(mimeType: string) {
  const base = mimeType.split(";")[0].trim().toLowerCase();
  if ((GEMINI_AUDIO_MIME_BASES as readonly string[]).includes(base)) return base;
  throw new Error(
    `Encoded audio MIME "${base || mimeType}" is not Gemini-compatible. Complete audio was not sent.`,
  );
}

export function supportedCompressedAudioType() {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") {
    return null;
  }
  return GEMINI_AUDIO_RECORDER_TYPES.find((type) => MediaRecorder.isTypeSupported(type)) || null;
}

function mixMono(buffer: AudioBuffer) {
  const length = buffer.length;
  const mixed = new Float32Array(length);
  const channels = buffer.numberOfChannels;
  for (let c = 0; c < channels; c += 1) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < length; i += 1) mixed[i] += data[i] / channels;
  }
  return mixed;
}

async function resampleMono(samples: Float32Array, fromRate: number, toRate: number) {
  if (fromRate === toRate) return samples;
  const duration = samples.length / fromRate;
  const offline = new OfflineAudioContext(1, Math.ceil(duration * toRate), toRate);
  const buffer = offline.createBuffer(1, samples.length, fromRate);
  buffer.getChannelData(0).set(samples);
  const source = offline.createBufferSource();
  source.buffer = buffer;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0).slice();
}

function encodeWav(samples: Float32Array, sampleRate: number) {
  const dataBytes = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const writeString = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i));
  };
  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, dataBytes, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
  return new Blob([buffer], { type: "audio/wav" });
}

function audioInsightsFromPcm(samples: Float32Array, sampleRate: number, duration: number): AudioInsights {
  let sumSq = 0;
  let peak = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const v = Math.abs(samples[i]);
    sumSq += samples[i] * samples[i];
    if (v > peak) peak = v;
  }
  const rms = Math.sqrt(sumSq / Math.max(samples.length, 1));
  const meanVolumeDb = 20 * Math.log10(Math.max(rms, 1e-8));
  const maxVolumeDb = 20 * Math.log10(Math.max(peak, 1e-8));
  const window = Math.round(sampleRate * 0.05);
  const silenceRanges: { start: number; end: number }[] = [];
  let silenceStart: number | null = null;
  const threshold = Math.pow(10, -35 / 20);
  for (let i = 0; i < samples.length; i += window) {
    let local = 0;
    const end = Math.min(samples.length, i + window);
    for (let j = i; j < end; j += 1) local += samples[j] * samples[j];
    const localRms = Math.sqrt(local / Math.max(end - i, 1));
    const t = i / sampleRate;
    if (localRms < threshold) {
      if (silenceStart === null) silenceStart = t;
    } else if (silenceStart !== null) {
      if (t - silenceStart >= 0.6) silenceRanges.push({ start: silenceStart, end: t });
      silenceStart = null;
    }
  }
  if (silenceStart !== null && duration - silenceStart >= 0.6) {
    silenceRanges.push({ start: silenceStart, end: duration });
  }
  return {
    implemented: true,
    hasAudio: true,
    meanVolumeDb,
    maxVolumeDb,
    silenceRanges: silenceRanges.filter((range) => range.end <= duration + 1),
    notes: [
      `Mean volume is ${meanVolumeDb.toFixed(1)} dB.`,
      silenceRanges.length
        ? `Detected ${silenceRanges.length} silence span(s) longer than 0.6s.`
        : "No long silence spans were detected at -35 dB.",
      "These measurements describe loudness and silence, not whether music is entertaining.",
    ].join(" "),
  };
}

export async function encodeCompressedAudio(samples: Float32Array, sampleRate: number) {
  const mimeType = supportedCompressedAudioType();
  if (!mimeType) {
    throw new Error(
      "This browser cannot encode Gemini-compatible compressed audio (MediaRecorder Opus/WebM/MP4).",
    );
  }
  const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new AudioCtx({ sampleRate });
  await ctx.resume();
  const buffer = ctx.createBuffer(1, samples.length, sampleRate);
  buffer.getChannelData(0).set(samples);
  const dest = ctx.createMediaStreamDestination();
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(dest);
  const chunks: Blob[] = [];
  const recorder = new MediaRecorder(dest.stream, { mimeType, audioBitsPerSecond: 24_000 });
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };
  const stopped = new Promise<void>((resolve, reject) => {
    recorder.onstop = () => resolve();
    recorder.onerror = () => reject(new Error("Audio encoding failed."));
  });
  const ended = new Promise<void>((resolve) => {
    source.onended = () => resolve();
  });
  recorder.start(200);
  source.start();
  await ended;
  await new Promise((resolve) => window.setTimeout(resolve, 120));
  if (recorder.state !== "inactive") recorder.stop();
  await stopped;
  await ctx.close();
  const blob = new Blob(chunks, { type: mimeType.split(";")[0] });
  if (blob.size < 256) {
    throw new Error("Compressed audio encoding produced an empty file. Complete audio was not captured.");
  }
  return { blob, mimeType: geminiCompatibleAudioMime(blob.type || mimeType) };
}

export async function extractCompleteAudio(file: File, duration: number): Promise<{
  hasAudio: boolean;
  mimeType?: string;
  base64?: string;
  bytes?: number;
  insights: AudioInsights | null;
}> {
  const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtx) {
    throw new Error("Web Audio is not available, so the complete audio track cannot be extracted.");
  }
  let decoded: AudioBuffer;
  try {
    const ctx = new AudioCtx();
    decoded = await ctx.decodeAudioData(await file.arrayBuffer());
    await ctx.close();
  } catch {
    return { hasAudio: false, insights: null };
  }
  if (!decoded.numberOfChannels || decoded.duration < 0.05) {
    return { hasAudio: false, insights: null };
  }
  const mixed = mixMono(decoded);
  const samples = await resampleMono(mixed, decoded.sampleRate, AUDIO_SAMPLE_RATE);
  const insights = audioInsightsFromPcm(samples, AUDIO_SAMPLE_RATE, duration);
  try {
    const compressed = await encodeCompressedAudio(samples, AUDIO_SAMPLE_RATE);
    const base64 = await blobToBase64(compressed.blob);
    return {
      hasAudio: true,
      mimeType: compressed.mimeType,
      base64,
      bytes: compressed.blob.size,
      insights,
    };
  } catch (error) {
    const wav = encodeWav(samples, AUDIO_SAMPLE_RATE);
    const base64 = await blobToBase64(wav);
    const reason = error instanceof Error ? error.message : "Compressed audio encoding failed.";
    console.info(
      `[shorts-analyzer] audio fallback WAV ${(wav.size / 1000).toFixed(0)}KB after compressed encode failed: ${reason}`,
    );
    return {
      hasAudio: true,
      mimeType: "audio/wav",
      base64,
      bytes: wav.size,
      insights,
    };
  }
}

export async function hashFile(file: File) {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function preprocessVideo(
  file: File,
  video: HTMLVideoElement,
  sampling: {
    intervalSeconds: number;
    hookSeconds: number;
    hookIntervalSeconds: number;
    minFrames: number;
    maxFrames: number;
  },
  onProgress: (message: string, completed?: number, total?: number) => void,
) {
  const duration = video.duration;
  const metadata: VideoMetadata = {
    duration,
    width: video.videoWidth,
    height: video.videoHeight,
    frameRate: 30,
    hasAudio: true,
    codec: "browser",
    fileName: file.name,
  };

  const hashPromise = hashFile(file);
  onProgress("Measuring visual transitions in the browser");
  const sceneCuts = await detectBrowserSceneCuts(video, duration);
  onProgress("Planning adaptive JPEG samples");
  const timestamps = planSampleTimestamps({
    duration,
    intervalSeconds: sampling.intervalSeconds,
    hookSeconds: sampling.hookSeconds,
    hookIntervalSeconds: sampling.hookIntervalSeconds,
    minFrames: sampling.minFrames,
    maxFrames: sampling.maxFrames,
    frameRate: metadata.frameRate,
    extraTimestamps: sceneCuts.map((cut) => cut.timestamp),
  });

  const frames: ExtractedJpeg[] = [];
  for (let i = 0; i < timestamps.length; i += 1) {
    onProgress(
      `Extracting JPEG ${i + 1}/${timestamps.length} (adaptive ${sampling.minFrames}–${sampling.maxFrames})`,
      i,
      timestamps.length,
    );
    try {
      let jpeg = await extractJpegAtTimestamp(video, timestamps[i]);
      const prev = frames.at(-1);
      if (prev && prev.base64 === jpeg.base64 && timestamps[i] - prev.timestamp > 0.2) {
        jpeg = await extractJpegAtTimestamp(video, Math.min(timestamps[i] + 0.08, duration - 0.05));
        jpeg = { ...jpeg, timestamp: Number(timestamps[i].toFixed(3)) };
      }
      frames.push(jpeg);
    } catch (error) {
      const lastSafe = lastSafeTimestamp(duration, metadata.frameRate);
      if (timestamps[i] >= lastSafe - 0.05) continue;
      throw error;
    }
  }
  if (frames.length < 3) {
    throw new Error("The browser could not extract enough JPEG frames from this video.");
  }

  onProgress("Extracting the complete audio track");
  const audio = await extractCompleteAudio(file, duration);
  metadata.hasAudio = audio.hasAudio;
  const fileHash = await hashPromise;
  return { metadata, frames, sceneCuts, audio, fileHash };
}
