import {
  GEMINI_AUDIO_MIME_BASES,
  GEMINI_JPEG_SHRINK_STEPS,
  GEMINI_MIN_FRAMES,
  GEMINI_PAYLOAD_BUDGET_BYTES,
  MAX_VERCEL_JSON_BYTES,
} from "../src/lib/constants.ts";
import { pickGeminiFrames } from "../src/lib/pick-frames.ts";

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

assert(GEMINI_PAYLOAD_BUDGET_BYTES === 3_500_000, "3.5MB Gemini budget");
assert(GEMINI_PAYLOAD_BUDGET_BYTES < MAX_VERCEL_JSON_BYTES, "budget under Hobby safety cap");
assert(GEMINI_MIN_FRAMES >= 6, "keep a usable Gemini set");
assert(GEMINI_JPEG_SHRINK_STEPS[0].maxWidth < 640, "first shrink is below Roboflow width");
assert(GEMINI_AUDIO_MIME_BASES.includes("audio/webm"), "webm allowed");
assert(GEMINI_AUDIO_MIME_BASES.includes("audio/mp4"), "mp4 allowed");
assert(GEMINI_AUDIO_MIME_BASES.includes("audio/wav"), "wav fallback allowed");

const frames = Array.from({ length: 12 }, (_, i) => ({ timestamp: i * 3 }));
const extras = [0, 5, 33];
const picked = pickGeminiFrames(frames, 8, extras);
assertEqual(picked[0].timestamp, 0, "keeps opening");
assertEqual(picked.at(-1)?.timestamp, 33, "keeps ending");
assert(picked.length <= 8, "respects max");

const reduced = pickGeminiFrames(frames, GEMINI_MIN_FRAMES, extras);
assertEqual(reduced[0].timestamp, 0, "min set keeps opening");
assertEqual(reduced.at(-1)?.timestamp, 33, "min set keeps ending");
assertEqual(reduced.length, GEMINI_MIN_FRAMES, "min count");

const jsonBytes = new TextEncoder().encode(
  JSON.stringify({
    audio: { mimeType: "audio/webm", data: "a".repeat(80_000) },
    geminiFrames: picked.map((frame) => ({ imageBase64: "b".repeat(20_000), timestamp: frame.timestamp })),
  }),
).length;
assert(jsonBytes < GEMINI_PAYLOAD_BUDGET_BYTES, "compressed-audio-sized stub fits 3.5MB");

console.log("test-gemini-payload: ok");
