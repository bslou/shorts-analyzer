export const MAX_DURATION_SECONDS = 180;
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
/** Stay under Vercel Hobby's 4.5MB request/response body (JSON + base64 overhead). */
export const MAX_VERCEL_JSON_BYTES = 4_000_000;
/** Client target for /api/gemini so Hobby 413s stay off the table. */
export const GEMINI_PAYLOAD_BUDGET_BYTES = 3_500_000;
export const JPEG_MAX_WIDTH = 640;
export const AUDIO_SAMPLE_RATE = 16_000;
export const GEMINI_MIN_FRAMES = 6;
export const GEMINI_JPEG_SHRINK_STEPS = [
  { maxWidth: 512, quality: 0.72 },
  { maxWidth: 448, quality: 0.62 },
  { maxWidth: 384, quality: 0.52 },
] as const;
export const GEMINI_AUDIO_RECORDER_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/mp4",
] as const;
export const GEMINI_AUDIO_MIME_BASES = [
  "audio/webm",
  "audio/ogg",
  "audio/mp4",
  "audio/mpeg",
  "audio/mp3",
  "audio/m4a",
  "audio/aac",
  "audio/opus",
  "audio/wav",
] as const;
