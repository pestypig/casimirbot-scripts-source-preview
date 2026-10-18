export type EquationBenchmarkExpectation = {
  primaryTopic?: string;
  requiredSections?: string[];
  preferredEquationPatterns?: string[];
  preferredSourcePaths?: string[];
  forbiddenEquationPatterns?: string[];
  forbiddenSourcePaths?: string[];
  requiredMechanismPatterns?: string[];
  forbiddenMechanismPatterns?: string[];
  requireConsensusFrame?: boolean;
  minMechanismChars?: number;
  requireTentative?: boolean;
  passThreshold?: number;
};

export type EquationBenchmarkCase = {
  id: string;
  label: string;
  question: string;
  expect?: EquationBenchmarkExpectation;
};

export type EquationBenchmarkCaseFile = {
  version: string;
  description?: string;
  cases: EquationBenchmarkCase[];
};

export type ParsedEquationAnswer = {
  primaryTopic: string | null;
  primaryEquationMode: "verified" | "tentative" | "general_reference" | null;
  primaryEquationBlock: string;
  mechanismBlock: string;
  sectionsPresent: string[];
  sourcePaths: string[];
  equationAnchors: string[];
  hasArtifactLeak: boolean;
};

export type EquationBenchmarkEvaluation = {
  pass: boolean;
  score: number;
  failures: string[];
  warnings: string[];
  details: {
    sectionScore: number;
    topicScore: number;
    equationScore: number;
    sourceScore: number;
    mechanismScore: number;
    mechanismPatternScore: number;
    cleanlinessPenalty: number;
    threshold: number;
  };
};

const SECTION_HEADERS = [
  "Primary Topic",
  "Primary Equation",
  "Mechanism Explanation",
  "Related Cross-Topic Evidence",
  "Rejected Candidates",
];

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const normalizeWhitespace = (value: string): string =>
  value
    .replace(/\r/g, "")
    .replace(/\t/g, " ")
    .replace(/[ ]{2,}/g, " ");

const toUniqueLower = (values: string[]): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const normalized = value.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
};

const safeRegex = (pattern: string): RegExp | null => {
  try {
    return new RegExp(pattern, "i");
  } catch {
    return null;
  }
};

const buildHeaderRegex = (header: string): RegExp =>
  new RegExp(`\\b${escapeRegExp(header)}(?:\\s*\\([^)]*\\))?\\s*:`, "i");

const extractBlock = (text: string, startHeader: string, endHeaders: string[]): string => {
  const normalized = normalizeWhitespace(text);
  const startRe = new RegExp(
    `\\b${escapeRegExp(startHeader)}(?:\\s*\\([^)]*\\))?\\s*:\\s*`,
    "i",
  );
  const startMatch = startRe.exec(normalized);
  if (!startMatch || startMatch.index < 0) return "";
  const startIndex = startMatch.index + startMatch[0].length;
  const tail = normalized.slice(startIndex);
  let endIndex = tail.length;
  for (const header of endHeaders) {
    const re = new RegExp(`\\n\\s*${escapeRegExp(header)}(?:\\s*\\([^)]*\\))?\\s*:`, "i");
    const match = re.exec(tail);
    if (match && match.index >= 0) {
      endIndex = Math.min(endIndex, match.index);
    }
  }
  return tail.slice(0, endIndex).trim();
};

export const parseEquationAnswer = (answerText: string): ParsedEquationAnswer => {
  const text = normalizeWhitespace(answerText ?? "");
  const sectionsPresent = SECTION_HEADERS.filter((header) => buildHeaderRegex(header).test(text));
  const primaryTopicMatch = /\bPrimary Topic\s*:\s*([^\n]+)/i.exec(text);
  const primaryTopic = primaryTopicMatch?.[1]?.trim() || null;
  const modeMatch = /\bPrimary Equation\s*\(([^)]+)\)\s*:/i.exec(text);
  const modeRaw = modeMatch?.[1]?.trim().toLowerCase() ?? "";
  const primaryEquationMode =
    modeRaw === "verified"
      ? "verified"
      : modeRaw === "tentative"
        ? "tentative"
        : modeRaw === "general reference"
          ? "general_reference"
          : null;
  const primaryEquationBlock = extractBlock(text, "Primary Equation", [
    "Mechanism Explanation",
    "Related Cross-Topic Evidence",
    "Rejected Candidates",
    "Proof",
    "Sources",
  ]);
  const mechanismBlock = extractBlock(text, "Mechanism Explanation", [
    "Related Cross-Topic Evidence",
    "Rejected Candidates",
    "Proof",
    "Sources",
  ]);

  const equationAnchors = Array.from(text.matchAll(/\[([a-zA-Z0-9_./-]+):L\d+\]/g)).map(
    (match) => match[1] ?? "",
  );

  const sourcePaths = Array.from(text.matchAll(/Sources?\s*:\s*([^\n]+)/gi))
    .flatMap((match) =>
      String(match[1] ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
    )
    .map((entry) => entry.replace(/^\[|\]$/g, "").trim());

  const hasArtifactLeak =
    /(^|[\s(])(?:ts|tsx|js|jsx|md|json|yaml|yml|toml)\](?=\s|[,.!?;:]|$)/i.test(text) ||
    /(^|[\s(\[])\.(?:ts|tsx|js|jsx|md|json|yaml|yml|toml)\]?(?=\s|[,.!?;:]|$)/i.test(text) ||
    /\[\s*[a-zA-Z0-9_./-]+\s*\](?:\s+\[\s*[a-zA-Z0-9_./-]+\s*\])+/i.test(text) &&
      /(\[[a-zA-Z0-9_./-]+\])(?:\s+\1)+/i.test(text) ||
    /\bHelix Ask:\s+LLM/i.test(text);

  return {
    primaryTopic,
    primaryEquationMode,
    primaryEquationBlock,
    mechanismBlock,
    sectionsPresent,
    sourcePaths: toUniqueLower(sourcePaths),
    equationAnchors: toUniqueLower(equationAnchors),
    hasArtifactLeak,
  };
};

export const evaluateEquationBenchmarkCase = (
  answerText: string,
  expectation?: EquationBenchmarkExpectation,
): EquationBenchmarkEvaluation => {
  const parsed = parseEquationAnswer(answerText);
  const expect = expectation ?? {};
  const failures: string[] = [];
  const warnings: string[] = [];

  let sectionScore = 0;
  const requiredSections =
    expect.requiredSections && expect.requiredSections.length > 0
      ? expect.requiredSections
      : ["Primary Topic", "Primary Equation", "Mechanism Explanation"];
  for (const section of requiredSections) {
    const hasSection = parsed.sectionsPresent.some(
      (entry) => entry.toLowerCase() === section.toLowerCase(),
    );
    if (hasSection) {
      sectionScore += Math.round(30 / Math.max(1, requiredSections.length));
    } else {
      failures.push(`missing_section:${section}`);
    }
  }
  sectionScore = Math.min(30, sectionScore);

  let topicScore = 0;
  if (expect.primaryTopic) {
    if ((parsed.primaryTopic ?? "").toLowerCase() === expect.primaryTopic.toLowerCase()) {
      topicScore = 15;
    } else {
      failures.push(`topic_mismatch:expected_${expect.primaryTopic}`);
    }
  } else if (parsed.primaryTopic) {
    topicScore = 10;
  }

  let equationScore = 0;
  const equationBlock = parsed.primaryEquationBlock || "";
  if (equationBlock.length > 0) {
    equationScore += 8;
  } else {
    failures.push("primary_equation_block_missing");
  }
  if (expect.preferredEquationPatterns && expect.preferredEquationPatterns.length > 0) {
    const matched = expect.preferredEquationPatterns.some((pattern) => {
      const re = safeRegex(pattern);
      return re ? re.test(equationBlock) : false;
    });
    if (matched) {
      equationScore += 12;
    } else {
      failures.push("preferred_equation_pattern_missing");
    }
  } else if (equationBlock.length > 0) {
    equationScore += 6;
  }
  if (expect.forbiddenEquationPatterns && expect.forbiddenEquationPatterns.length > 0) {
    for (const pattern of expect.forbiddenEquationPatterns) {
      const re = safeRegex(pattern);
      if (re && re.test(equationBlock)) {
        failures.push("forbidden_equation_pattern_hit");
        equationScore -= 10;
        break;
      }
    }
  }
  equationScore = Math.max(0, Math.min(30, equationScore));

  let sourceScore = 0;
  const sourcePaths = parsed.sourcePaths;
  if (sourcePaths.length > 0) {
    sourceScore += 6;
  } else {
    warnings.push("no_sources_line_detected");
  }
  if (expect.preferredSourcePaths && expect.preferredSourcePaths.length > 0) {
    const preferred = toUniqueLower(expect.preferredSourcePaths);
    const matched = preferred.some((path) => sourcePaths.includes(path));
    if (matched) {
      sourceScore += 9;
    } else {
      failures.push("preferred_source_path_missing");
    }
  }
  if (expect.forbiddenSourcePaths && expect.forbiddenSourcePaths.length > 0) {
    const forbidden = toUniqueLower(expect.forbiddenSourcePaths);
    if (forbidden.some((path) => sourcePaths.includes(path))) {
      failures.push("forbidden_source_path_hit");
      sourceScore -= 8;
    }
  }
  sourceScore = Math.max(0, Math.min(15, sourceScore));

  let mechanismScore = 0;
  let mechanismPatternScore = 0;
  const mechanismChars = parsed.mechanismBlock.length;
  const minMechanismChars = Math.max(0, expect.minMechanismChars ?? 120);
  if (mechanismChars >= minMechanismChars) {
    mechanismScore = 6;
  } else {
    failures.push("mechanism_too_short");
  }
  const mechanismBlock = parsed.mechanismBlock;
  const requiredMechanismPatterns =
    expect.requiredMechanismPatterns && expect.requiredMechanismPatterns.length > 0
      ? expect.requiredMechanismPatterns
      : [];
  if (requiredMechanismPatterns.length > 0) {
    const missing = requiredMechanismPatterns.filter((pattern) => {
      const re = safeRegex(pattern);
      return re ? !re.test(mechanismBlock) : true;
    });
    if (missing.length > 0) {
      failures.push("required_mechanism_pattern_missing");
    } else {
      mechanismPatternScore += 2;
    }
  }
  if (expect.requireConsensusFrame) {
    const consensusPatterns = [/general-reference baseline:/i, /repo-grounded support:/i, /challenge status:/i];
    const hasConsensusFrame = consensusPatterns.every((re) => re.test(mechanismBlock));
    if (!hasConsensusFrame) {
      failures.push("consensus_frame_missing");
    } else {
      mechanismPatternScore += 2;
    }
  }
  if (expect.forbiddenMechanismPatterns && expect.forbiddenMechanismPatterns.length > 0) {
    for (const pattern of expect.forbiddenMechanismPatterns) {
      const re = safeRegex(pattern);
      if (re && re.test(mechanismBlock)) {
        failures.push("forbidden_mechanism_pattern_hit");
        mechanismPatternScore -= 2;
        break;
      }
    }
  }
  mechanismPatternScore = Math.max(0, Math.min(4, mechanismPatternScore));
  mechanismScore = Math.max(0, Math.min(10, mechanismScore + mechanismPatternScore));

  if (typeof expect.requireTentative === "boolean") {
    const tentative = parsed.primaryEquationMode === "tentative";
    if (tentative !== expect.requireTentative) {
      failures.push(
        expect.requireTentative
          ? "expected_tentative_primary_equation"
          : "expected_non_tentative_primary_equation",
      );
    }
  }

  const cleanlinessPenalty = parsed.hasArtifactLeak ? 12 : 0;
  if (parsed.hasArtifactLeak) {
    failures.push("artifact_leak_detected");
  }

  const rawScore = sectionScore + topicScore + equationScore + sourceScore + mechanismScore;
  const score = Math.max(0, Math.min(100, rawScore - cleanlinessPenalty));
  const threshold = Math.max(0, Math.min(100, expect.passThreshold ?? 70));
  const pass = failures.length === 0 && score >= threshold;

  return {
    pass,
    score,
    failures,
    warnings,
    details: {
      sectionScore,
      topicScore,
      equationScore,
      sourceScore,
      mechanismScore,
      mechanismPatternScore,
      cleanlinessPenalty,
      threshold,
    },
  };
};
