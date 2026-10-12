import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export async function createJobDir() {
  return mkdtemp(path.join(tmpdir(), "shorts-analyzer-"));
}

export async function cleanupJobDir(dir: string | undefined) {
  if (!dir) return;
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
}
