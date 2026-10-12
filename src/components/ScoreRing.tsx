"use client";

import { useId } from "react";

export function ScoreRing({
  score,
  size = 92,
  label,
  uncertain = false,
}: {
  score: number | null;
  size?: number;
  label?: string;
  uncertain?: boolean;
}) {
  const rawId = useId().replace(/:/g, "");
  const gradientId = `score-${rawId}`;
  const radius = 34;
  const circumference = 2 * Math.PI * radius;
  const missing = uncertain || score === null;
  const clamped = missing ? 0 : Math.max(0, Math.min(10, score));
  const offset = circumference - (clamped / 10) * circumference;

  return (
    <div className="flex flex-col items-center gap-2">
      <svg width={size} height={size} viewBox="0 0 88 88">
        <circle cx="44" cy="44" r={radius} stroke="#1f1f2c" strokeWidth="8" fill="none" />
        <circle
          cx="44"
          cy="44"
          r={radius}
          stroke={`url(#${gradientId})`}
          strokeWidth="8"
          fill="none"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          transform="rotate(-90 44 44)"
        />
        <defs>
          <linearGradient id={gradientId} x1="0" x2="1" y1="0" y2="1">
            <stop offset="0%" stopColor="#8b7dff" />
            <stop offset="100%" stopColor="#5b8cff" />
          </linearGradient>
        </defs>
        <text x="44" y="48" textAnchor="middle" fill="white" fontSize="18" fontWeight="700">
          {missing ? "?" : clamped.toFixed(1)}
        </text>
      </svg>
      {label ? <p className="text-[10px] uppercase tracking-[0.14em] text-muted">{label}</p> : null}
    </div>
  );
}
