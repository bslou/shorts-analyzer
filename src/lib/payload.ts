import { MAX_VERCEL_JSON_BYTES } from "./constants";

export function jsonByteLength(value: unknown) {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

export function assertUnderVercelLimit(value: unknown, label: string) {
  const bytes = jsonByteLength(value);
  if (bytes > MAX_VERCEL_JSON_BYTES) {
    throw new Error(
      `${label} is ${(bytes / 1_000_000).toFixed(2)}MB JSON, over the ${(MAX_VERCEL_JSON_BYTES / 1_000_000).toFixed(1)}MB budget for Vercel Hobby (platform limit 4.5MB).`,
    );
  }
  return bytes;
}

export function stripDataUrl(value: string) {
  const marker = "base64,";
  const index = value.indexOf(marker);
  return index >= 0 ? value.slice(index + marker.length) : value;
}

export function httpErrorMessage(status: number, body: string) {
  const trimmed = body.replace(/\s+/g, " ").trim().slice(0, 400);
  if (status === 413) {
    return `HTTP 413 Content Too Large. A request exceeded Vercel's 4.5MB body limit.${trimmed ? ` ${trimmed}` : ""}`;
  }
  if (status === 504 || status === 524) {
    return `HTTP ${status}: the function timed out.${trimmed ? ` ${trimmed}` : ""}`;
  }
  return `HTTP ${status}${trimmed ? `: ${trimmed}` : ""}`;
}
