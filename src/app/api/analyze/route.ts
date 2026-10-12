export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  return Response.json(
    {
      message:
        "This endpoint no longer accepts MP4 uploads. The browser extracts JPEG frames and complete audio, then calls /api/roboflow and /api/gemini in payloads under 4MB.",
    },
    { status: 410 },
  );
}
