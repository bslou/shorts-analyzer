import { spawn } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

async function readKey() {
  const file = await readFile(path.join(root, ".env.local"), "utf8");
  for (const line of file.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const name = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (name === "ROBOFLOW_API_KEY") return value;
  }
  return process.env.ROBOFLOW_API_KEY;
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} failed: ${stderr.slice(-1000)}`));
    });
  });
}

function parseWorkflowDetections(payload) {
  const outputs = payload.outputs;
  const first = Array.isArray(outputs) ? outputs[0] : outputs;
  const node = first?.predictions;
  const list = Array.isArray(node?.predictions) ? node.predictions : Array.isArray(node) ? node : [];
  return {
    imageWidth: node?.image?.width,
    imageHeight: node?.image?.height,
    detections: list.map((item) => ({
      class: item.class,
      confidence: item.confidence,
      x: item.x,
      y: item.y,
      width: item.width,
      height: item.height,
    })),
  };
}

function assertParser() {
  const sample = {
    outputs: [
      {
        predictions: {
          image: { width: 640, height: 1138 },
          predictions: [
            { class: "person", confidence: 0.91, x: 320, y: 500, width: 120, height: 400 },
          ],
        },
      },
    ],
  };
  const parsed = parseWorkflowDetections(sample);
  if (parsed.detections.length !== 1) throw new Error("Parser missed detections");
  if (parsed.detections[0].class !== "person") throw new Error("Parser missed class");
  if (parsed.imageWidth !== 640) throw new Error("Parser missed image size");
  console.log("parser: ok");
}

async function main() {
  assertParser();
  const apiKey = await readKey();
  if (!apiKey) {
    throw new Error("ROBOFLOW_API_KEY missing in .env.local");
  }

  const work = path.join(os.tmpdir(), `rf-test-${Date.now()}`);
  await mkdir(work, { recursive: true });
  const video = path.join(work, "short.mp4");
  const frame = path.join(work, "frame.jpg");

  try {
    await run("ffmpeg", [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=1080x1920:d=6",
      "-pix_fmt",
      "yuv420p",
      video,
    ]);
    await run("ffmpeg", ["-y", "-ss", "1", "-i", video, "-frames:v", "1", "-q:v", "6", frame]);

    const published =
      "https://serverless.roboflow.com/benjamin-sloutsky-s-workspace/workflows/shorts-visual-timeline-1791839058578";
    const endpoint =
      "https://serverless.roboflow.com/infer/workflows/benjamin-sloutsky-s-workspace/shorts-visual-timeline-1791839058578";
    console.log({
      published,
      apiEndpoint: endpoint,
      workspace: "benjamin-sloutsky-s-workspace",
      workflowId: "shorts-visual-timeline-1791839058578",
    });
    const url = new URL(endpoint);
    url.searchParams.set("api_key", apiKey);
    const jpeg = await readFile(frame);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        api_key: apiKey,
        inputs: {
          image: { type: "base64", value: jpeg.toString("base64") },
        },
      }),
    });
    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      console.error({ httpStatus: response.status, endpoint, body: text.slice(0, 500) });
      throw new Error(`Non-JSON response ${response.status}: ${text.slice(0, 300)}`);
    }
    if (!response.ok) {
      console.error({ httpStatus: response.status, endpoint, body: json });
      throw new Error(
        `Workflow HTTP ${response.status} at ${endpoint}: ${json.message || json.error || json.detail || text.slice(0, 300)}`,
      );
    }
    if (!Array.isArray(json.outputs)) {
      throw new Error(`Expected outputs array, got keys: ${Object.keys(json).join(",")}`);
    }
    const parsed = parseWorkflowDetections(json);
    console.log(
      JSON.stringify({
        status: response.status,
        outputCount: json.outputs.length,
        detectionCount: parsed.detections.length,
        image: { width: parsed.imageWidth, height: parsed.imageHeight },
        classes: [...new Set(parsed.detections.map((item) => item.class))],
      }),
    );
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
