import type { Detection } from "@/lib/types";

export function BoundingBoxes({
  detections,
  imageWidth,
  imageHeight,
}: {
  detections: Detection[];
  imageWidth: number;
  imageHeight: number;
}) {
  const width = imageWidth || 1;
  const height = imageHeight || 1;

  return (
    <>
      {detections.map((detection, index) => {
        const left = ((detection.boundingBox.x - detection.boundingBox.width / 2) / width) * 100;
        const top = ((detection.boundingBox.y - detection.boundingBox.height / 2) / height) * 100;
        const boxWidth = (detection.boundingBox.width / width) * 100;
        const boxHeight = (detection.boundingBox.height / height) * 100;
        return (
          <div
            key={`${detection.class}-${index}`}
            className="absolute rounded-sm border-2 border-accent/90"
            style={{
              left: `${left}%`,
              top: `${top}%`,
              width: `${boxWidth}%`,
              height: `${boxHeight}%`,
            }}
          >
            <span className="absolute -top-5 left-0 max-w-[140px] truncate rounded bg-accent px-1 text-[10px] font-medium text-black">
              {detection.class} {(detection.confidence * 100).toFixed(0)}%
            </span>
          </div>
        );
      })}
    </>
  );
}
