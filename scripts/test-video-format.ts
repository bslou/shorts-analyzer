import {
  buildGeminiStory,
  isReusableGeminiCache,
  normalizeFormatLabel,
  parseVideoFormat,
} from "../src/lib/video-format.ts";

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const known = parseVideoFormat({
  format: { label: "Reaction", secondary: ["Commentary"], explanation: "Creator reacts to a clip." },
});
assertEqual(known.label, "reaction", "known reaction");
assertEqual(known.secondary[0], "commentary", "secondary commentary");
assertEqual(known.parseFailure, null, "known parseFailure");

const street = parseVideoFormat({ format: { label: "Street Interview" } });
assertEqual(street.label, "street_interview", "street interview");
assertEqual(street.parseFailure, null, "street parseFailure");

const demo = parseVideoFormat({ format: "Product Demo" });
assertEqual(demo.label, "product_demo", "string format field");

const unfamiliar = parseVideoFormat({
  format: { label: "mini-documentary", secondary: ["behind the scenes"] },
});
assertEqual(unfamiliar.label, "mini_documentary", "unfamiliar mini documentary");
assertEqual(unfamiliar.secondary.includes("behind_the_scenes"), true, "unfamiliar secondary");
assert(unfamiliar.label !== "other", "unfamiliar must not become other");

const explicitOther = parseVideoFormat({
  format: { label: "other", explanation: "Cannot tell from the evidence." },
});
assertEqual(explicitOther.label, "other", "explicit other");
assertEqual(explicitOther.parseFailure, null, "explicit other is not a parse failure");

const missing = parseVideoFormat({});
assertEqual(missing.label, "unclassified", "missing label");
assertEqual(missing.parseFailure, "missing", "missing reason");
assert(missing.label !== "other", "missing must not become other");

const empty = parseVideoFormat({ format: { label: "   " } });
assertEqual(empty.parseFailure, "empty", "empty label");
assertEqual(empty.label, "unclassified", "empty unclassified");

const malformed = parseVideoFormat({ format: { label: 12 } });
assertEqual(malformed.parseFailure, "malformed", "numeric label");
assertEqual(malformed.label, "unclassified", "malformed unclassified");

const placeholder = normalizeFormatLabel("snake_case_format");
assertEqual(placeholder.ok, false, "schema placeholder rejected");

const finalShape = {
  format: { label: street.label, secondary: street.secondary, explanation: street.explanation || "ok" },
};
assertEqual(finalShape.format.label, "street_interview", "label reaches response shape");

function section(score: number, explanation: string) {
  return { score, uncertain: false, explanation, recommendations: [] };
}

const complete = {
  format: { label: "street_interview", secondary: [], explanation: "Host asks strangers questions." },
  narrative: {
    premise: "Street interviews about cooking.",
    opening: "A question in the first second.",
    retention: "Answers keep changing.",
    ending: "A funny last line.",
  },
  transcript: { text: "What's your favorite pasta?", language: "en", segments: [] },
  idea: { ...section(8, "Clear interview premise."), premise: "Ask strangers about pasta." },
  hook: section(7, "Question lands immediately."),
  pacing: section(7, "Answers are short."),
  storytelling: section(6, "Each person is a beat."),
  outcome: section(8, "Last answer is the payoff."),
  visuals: section(7, "Handheld street framing."),
  strengths: [{ text: "Strong first question", timestamp: 0.4 }],
  weaknesses: [{ text: "Two answers ramble", timestamp: 12 }],
  recommendations: [{ text: "Cut the ramble", why: "Keeps payoff closer", timestamp: 12 }],
  missingEvidence: [],
};

const built = buildGeminiStory(complete);
assertEqual(built.format.label, "street_interview", "complete format");
assertEqual(built.transcript?.text.includes("pasta") ?? false, true, "transcript kept");
assertEqual(built.recommendations.length, 1, "recommendations kept");

const documentary = buildGeminiStory({
  ...complete,
  format: { label: "mini_documentary", secondary: [], explanation: "Archival clips plus narration." },
});
assertEqual(documentary.format.label, "mini_documentary", "unfamiliar format survives");

let missingThrew = false;
try {
  buildGeminiStory({ narrative: complete.narrative });
} catch {
  missingThrew = true;
}
assert(missingThrew, "missing format must throw");

let scoresThrew = false;
try {
  buildGeminiStory({
    format: complete.format,
    narrative: complete.narrative,
    idea: { uncertain: true, explanation: "", recommendations: [], score: null },
    hook: complete.hook,
    pacing: complete.pacing,
    storytelling: complete.storytelling,
    outcome: complete.outcome,
    visuals: complete.visuals,
    strengths: [],
    weaknesses: [],
    recommendations: [],
    missingEvidence: [],
  });
} catch {
  scoresThrew = true;
}
assert(scoresThrew, "empty idea explanation must throw");

assertEqual(
  isReusableGeminiCache({
    editorial: { format: { label: "unclassified" }, idea: section(null as unknown as number, "Language analysis was skipped because Gemini is unavailable.") },
    geminiUsage: { requests: 1 },
  }),
  false,
  "unclassified cache rejected",
);

assertEqual(
  isReusableGeminiCache({
    editorial: {
      format: { label: "street_interview" },
      idea: { ...section(8, "Clear interview premise."), premise: "Ask strangers about pasta." },
      hook: section(7, "Question lands immediately."),
      pacing: section(7, "Answers are short."),
      storytelling: section(6, "Each person is a beat."),
      outcome: section(8, "Last answer is the payoff."),
      visuals: section(7, "Handheld street framing."),
    },
    geminiUsage: { requests: 1 },
  }),
  true,
  "complete cache accepted",
);

console.log("test-video-format: ok");
