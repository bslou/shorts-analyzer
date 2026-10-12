import { runAnalysis } from "@/lib/pipeline";
import type { ProgressEvent } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

function encode(event: ProgressEvent) {
  return `data: ${JSON.stringify(event)}\n\n`;
}

export async function POST(request: Request) {
  const form = await request.formData();
  const file = form.get("video");
  const captionValue = form.get("caption");
  const caption = typeof captionValue === "string" ? captionValue.trim() : "";
  const forceValue = form.get("force");
  const force = forceValue === "1" || forceValue === "true";
  const approveOverBudget =
    form.get("approveOverBudget") === "1" || form.get("approveOverBudget") === "true";

  if (!(file instanceof File)) {
    return Response.json({ message: "Missing video file." }, { status: 400 });
  }

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      try {
        for await (const event of runAnalysis(file, caption || undefined, { force, approveOverBudget })) {
          controller.enqueue(encoder.encode(encode(event)));
          if (event.type === "error" || event.type === "complete") break;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unexpected server error.";
        controller.enqueue(
          encoder.encode(encode({ type: "error", stage: "validating", message })),
        );
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
