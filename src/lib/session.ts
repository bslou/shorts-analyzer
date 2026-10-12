"use client";

import { useEffect, useState } from "react";
import { loadVideoBlob, persistVideoBlob } from "./session-video";
import type { AnalysisResult } from "./types";

const RESULT_KEY = "shorts-analyzer-result";
const FINGERPRINT_KEY = "shorts-analyzer-fingerprint";
const CACHE_KEY = "shorts-analyzer-by-fingerprint";

let videoObjectUrl: string | null = null;
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
  if (videoUrl) replaceObjectUrl(videoUrl);
  sessionStorage.setItem(RESULT_KEY, JSON.stringify(result));
  if (fingerprint) {
    sessionStorage.setItem(FINGERPRINT_KEY, fingerprint);
    const cache = readFingerprintCache();
    cache[fingerprint] = result;
    try {
      sessionStorage.setItem(CACHE_KEY, JSON.stringify(cache));
    } catch {
      sessionStorage.setItem(CACHE_KEY, JSON.stringify({ [fingerprint]: result }));
    }
  }
  emit();
}

function readFingerprintCache(): Record<string, AnalysisResult> {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, AnalysisResult>) : {};
  } catch {
    return {};
  }
}

export function getCachedAnalysis(fingerprint: string): AnalysisResult | null {
  return readFingerprintCache()[fingerprint] ?? null;
}

function readResult(): AnalysisResult | null {
  if (typeof sessionStorage === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(RESULT_KEY);
    return raw ? (JSON.parse(raw) as AnalysisResult) : null;
  } catch {
    return null;
  }
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

    async function hydrateVideo() {
      if (videoObjectUrl) return videoObjectUrl;
      try {
        const stored = await loadVideoBlob();
        if (!stored || cancelled) return null;
        const file = new File([stored.blob], stored.name, { type: stored.type || "video/mp4" });
        const url = URL.createObjectURL(file);
        replaceObjectUrl(url);
        return url;
      } catch {
        return null;
      }
    }

    const update = () => {
      setState({
        result: readResult(),
        videoUrl: videoObjectUrl,
        ready: true,
      });
    };

    listeners.add(update);
    void hydrateVideo().then((url) => {
      if (cancelled) return;
      if (url) replaceObjectUrl(url);
      update();
    });

    return () => {
      cancelled = true;
      listeners.delete(update);
    };
  }, []);

  return state;
}
