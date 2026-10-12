import type { AnalysisResult, SectionAnalysis } from "./types";

export const SCORE_CATEGORIES = [
  { key: "idea", label: "Idea", question: "Is the concept interesting and clear?" },
  { key: "hook", label: "Hook", question: "Does the opening give a reason to stay?" },
  { key: "pacing", label: "Pacing", question: "Does momentum hold, or do stretches drag?" },
  { key: "storytelling", label: "Storytelling", question: "Does the structure fit this format?" },
  { key: "outcome", label: "Payoff", question: "Does the ending deliver on the hook?" },
  { key: "visuals", label: "Visuals", question: "Does the picture support the content?" },
] as const;

export type ScoreCategoryKey = (typeof SCORE_CATEGORIES)[number]["key"];

export function sectionFor(result: AnalysisResult, key: ScoreCategoryKey): SectionAnalysis {
  return result[key];
}

export function scoreBreakdown(result: AnalysisResult) {
  const rows = SCORE_CATEGORIES.map((category) => {
    const section = sectionFor(result, category.key);
    const weight = result.overall.weights[category.key] ?? 0;
    const included = section.score !== null && !section.uncertain;
    return {
      ...category,
      score: section.score,
      uncertain: section.uncertain,
      weight,
      included,
      contribution: included ? (section.score as number) * weight : 0,
    };
  });
  const weightSum = rows.filter((row) => row.included).reduce((sum, row) => sum + row.weight, 0);
  const weighted = rows.reduce((sum, row) => sum + row.contribution, 0);
  const overall = weightSum > 0 ? Math.round((weighted / weightSum) * 10) / 10 : null;
  return { rows, weightSum, overall };
}
