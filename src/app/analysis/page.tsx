"use client";

import Link from "next/link";
import { AnalysisDashboard } from "@/components/AnalysisDashboard";
import { AppHeader } from "@/components/AppHeader";
import { useStoredAnalysis } from "@/lib/session";

export default function AnalysisPage() {
  const { result, videoUrl, ready } = useStoredAnalysis();

  return (
    <div className="min-h-screen">
      <AppHeader />
      {!ready ? (
        <main className="mx-auto max-w-xl px-5 py-16 text-center text-sm text-muted">
          Loading session…
        </main>
      ) : !result ? (
        <main className="mx-auto max-w-xl px-5 py-16 text-center">
          <h1 className="text-2xl font-semibold">No analysis yet</h1>
          <p className="mt-3 text-sm text-muted">
            Upload a Short on the home page. Results are kept in this browser session only.
          </p>
          <Link
            href="/"
            className="mt-6 inline-flex rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-black"
          >
            Go to upload
          </Link>
        </main>
      ) : (
        <AnalysisDashboard result={result} videoUrl={videoUrl} />
      )}
    </div>
  );
}
