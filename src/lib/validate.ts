import { MAX_DURATION_SECONDS, MAX_UPLOAD_BYTES } from "./constants";
import type { VideoMetadata } from "./types";

export function validateUpload(file: File) {
  const name = file.name.toLowerCase();
  const isMp4 = file.type === "video/mp4" || name.endsWith(".mp4");
  if (!isMp4) {
    throw new Error("Unsupported file type. Upload an MP4 video.");
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error("File is too large. Keep uploads under 100 MB for this MVP.");
  }
}

export function validateMetadata(meta: VideoMetadata) {
  if (meta.duration > MAX_DURATION_SECONDS + 0.5) {
    throw new Error(
      `Video is ${meta.duration.toFixed(1)}s. Maximum duration is ${MAX_DURATION_SECONDS} seconds.`,
    );
  }
  if (meta.height <= meta.width) {
    throw new Error(
      `Video is ${meta.width}×${meta.height}. Upload a vertical (9:16) Short — height must be greater than width.`,
    );
  }
}
