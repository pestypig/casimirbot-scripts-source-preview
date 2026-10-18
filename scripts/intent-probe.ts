import { matchHelixAskIntent } from "../server/services/helix-ask/intent-directory";

const DEFAULT_CASES = [
  "Could warp bubble progress violate mission ethos, and how is that prevented?",
  "How does Helix Ask choose report mode vs hybrid explain mode for warp ethos prompts?",
  "Where are relation packet fields built for warp ethos answers in debug payload?",
  "How do I update ethos docs without changing warp code?",
  "Explain report mode mismatch in warp ideology routing",
];

const questions = process.argv.slice(2);
const cases = questions.length > 0 ? questions : DEFAULT_CASES;

for (const question of cases) {
  const out = matchHelixAskIntent({
    question,
    hasRepoHints: false,
    hasFilePathHints: false,
  });
  process.stdout.write(
    `${JSON.stringify({
      question,
      id: out.id,
      strategy: out.strategy,
      domain: out.domain,
      reason: out.reason,
    })}\n`,
  );
}
