import { MAX_DURATION_SECONDS, MAX_UPLOAD_BYTES } from "./constants";

export function validateClientFile(file: File) {
  const name = file.name.toLowerCase();
  const isMp4 = file.type === "video/mp4" || name.endsWith(".mp4");
  if (!isMp4) {
    throw new Error("Unsupported file type. Upload an MP4 video.");
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error("File is too large. Keep uploads under 100 MB.");
  }
}

export function readVideoMeta(file: File): Promise<{
  duration: number;
  width: number;
  height: number;
  url: string;
}> {
  validateClientFile(file);
  const url = URL.createObjectURL(file);
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.preload = "metadata";
    video.src = url;
    video.onloadedmetadata = () => {
      const duration = video.duration;
      const width = video.videoWidth;
      const height = video.videoHeight;
      if (!Number.isFinite(duration) || duration <= 0) {
        URL.revokeObjectURL(url);
        reject(new Error("Could not read video duration."));
        return;
      }
      if (duration > MAX_DURATION_SECONDS + 0.5) {
        URL.revokeObjectURL(url);
        reject(
          new Error(
            `Video is ${duration.toFixed(1)}s. Maximum duration is ${MAX_DURATION_SECONDS} seconds.`,
          ),
        );
        return;
      }
      if (height <= width) {
        URL.revokeObjectURL(url);
        reject(
          new Error(
            `Video is ${width}×${height}. Upload a vertical Short (height greater than width).`,
          ),
        );
        return;
      }
      resolve({ duration, width, height, url });
    };
    video.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not preview this file. Upload a valid MP4."));
    };
  });
}
