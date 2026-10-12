# Shorts Analyzer

Local Next.js app. Computer vision uses the published Roboflow Workflow **Shorts Visual Timeline**.

## Roboflow Workflow

- Published URL: `https://serverless.roboflow.com/benjamin-sloutsky-s-workspace/workflows/shorts-visual-timeline-1791839058578`
- API path: **POST** `https://serverless.roboflow.com/infer/workflows/benjamin-sloutsky-s-workspace/shorts-visual-timeline-1791839058578?api_key=...`
- JSON body:

```json
{
  "inputs": {
    "image": { "type": "base64", "value": "BASE64_JPEG" }
  }
}
```

- Detections are read from `outputs[0].predictions.predictions`
- Boxes use center `x`,`y` plus `width`,`height` in pixels of the submitted JPEG

Sampling is adaptive: opening, FFmpeg transitions, and ending are prioritized, targeting 24–36 frames on a typical 30–60s Short (`ROBOFLOW_MIN_FRAMES` / `ROBOFLOW_MAX_FRAMES`). Results are cached under `.cache/roboflow/` and `.cache/gemini/`. Failed Roboflow calls are not retried. Editorial review is **one** Gemini 2.5 Flash request with representative frames plus the complete audio track.

Soft budget: `ANALYSIS_SOFT_BUDGET_USD` (default $0.05). If the estimated cost is higher, the app asks for approval instead of lowering quality. Target list-price band is about $0.01–$0.03 per Short.

Set `GEMINI_API_KEY` and optionally `GEMINI_MODEL` (default `gemini-2.5-flash`). The app will not silently switch to Pro or Flash-Lite.

## Setup

```bash
cp .env.example .env.local
# set ROBOFLOW_API_KEY
npm install
npm run dev
```

Test the workflow (one JPEG, uses your key once):

```bash
npm run test:roboflow
```
