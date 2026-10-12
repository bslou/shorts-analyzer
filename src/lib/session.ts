"use client";

import { useEffect, useState } from "react";
import {
  loadAnalysisRecord,
  loadVideoBlob,
  persistAnalysisRecord,
  persistVideoBlob,
  removeOversizedFingerprintCache,
  safeStorageSet,
} from "./session-idb";
import type { AnalysisResult } from "./types";

const FINGERPRINT_KEY = "shorts-analyzer-fingerprint";

let videoObjectUrl: string | null = null;
let currentResult: AnalysisResult | null = null;
const memoryByFingerprint = new Map<string, AnalysisResult>();
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function replaceObjectUrl(next: string | null) {
  if (videoObjectUrl && videoObjectUrl !== next) {
    URL.revokeObjectURL(videoObjectUrl);
  }
  videoObjectUrl = next;
}

export function fileFingerprint(file: File) {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

export async function rememberSessionVideo(file: File, fingerprint: string) {
  await persistVideoBlob(file, fingerprint);
  const url = URL.createObjectURL(file);
  replaceObjectUrl(url);
  emit();
  return url;
}

export function storeAnalysis(result: AnalysisResult, videoUrl: string, fingerprint?: string) {
  currentResult = result;
  if (fingerprint) memoryByFingerprint.set(fingerprint, result);
  if (videoUrl) replaceObjectUrl(videoUrl);
  try {
    removeOversizedFingerprintCache();
    if (fingerprint && typeof sessionStorage !== "undefined") {
      safeStorageSet(sessionStorage, FINGERPRINT_KEY, fingerprint);
    }
  } catch {
    /* QuotaExceededError must never fail a completed analysis */
  }
  void persistAnalysisRecord(result, fingerprint || "current").catch(() => undefined);
  emit();
}

export async function getCachedAnalysis(fingerprint: string): Promise<AnalysisResult | null> {
  const memory = memoryByFingerprint.get(fingerprint);
  if (memory) return memory;
  try {
    const stored = await loadAnalysisRecord(fingerprint);
    if (stored?.result) {
      const result = stored.result as AnalysisResult;
      memoryByFingerprint.set(fingerprint, result);
      return result;
    }
  } catch {
    return null;
  }
  return null;
}

export function useStoredAnalysis(): {
  result: AnalysisResult | null;
  videoUrl: string | null;
  ready: boolean;
} {
  const [state, setState] = useState<{
    result: AnalysisResult | null;
    videoUrl: string | null;
    ready: boolean;
  }>({
    result: null,
    videoUrl: null,
    ready: false,
  });

  useEffect(() => {
    let cancelled = false;
    removeOversizedFingerprintCache();

    async function hydrate() {
      if (!currentResult) {
        const fingerprint =
          typeof sessionStorage !== "undefined" ? sessionStorage.getItem(FINGERPRINT_KEY) : null;
        try {
          const stored = await loadAnalysisRecord(fingerprint || undefined);
          if (stored?.result && !cancelled) {
            currentResult = stored.result as AnalysisResult;
            if (stored.fingerprint) memoryByFingerprint.set(stored.fingerprint, currentResult);
          }
        } catch {
          /* keep memory result */
        }
      }

      if (!videoObjectUrl) {
        try {
          const stored = await loadVideoBlob();
          if (stored && !cancelled) {
            const file = new File([stored.blob], stored.name, { type: stored.type || "video/mp4" });
            replaceObjectUrl(URL.createObjectURL(file));
          }
        } catch {
          /* player can still use poster frames */
        }
      }

      if (!cancelled) {
        setState({
          result: currentResult,
          videoUrl: videoObjectUrl,
          ready: true,
        });
      }
    }

    const update = () => {
      setState({
        result: currentResult,
        videoUrl: videoObjectUrl,
        ready: true,
      });
    };

    listeners.add(update);
    void hydrate();
    return () => {
      cancelled = true;
      listeners.delete(update);
    };
  }, []);

  return state;
}
