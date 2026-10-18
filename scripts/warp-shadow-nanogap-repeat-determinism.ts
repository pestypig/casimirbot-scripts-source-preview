import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DATE_STAMP = new Date().toISOString().slice(0, 10);
const DEFAULT_PASS1_PATH = path.join(
  'artifacts',
  'research',
  'full-solve',
  `shadow-injection-run-ng-primary-recovery-${DATE_STAMP}.json`,
);
const DEFAULT_PASS1_REPEAT_PATH = path.join(
  'artifacts',
  'research',
  'full-solve',
  `shadow-injection-run-ng-primary-recovery-${DATE_STAMP}-repeat.json`,
);
const DEFAULT_PASS2_PATH = path.join(
  'artifacts',
  'research',
  'full-solve',
  `shadow-injection-run-ng-primary-typed-${DATE_STAMP}.json`,
);
const DEFAULT_PASS2_REPEAT_PATH = path.join(
  'artifacts',
  'research',
  'full-solve',
  `shadow-injection-run-ng-primary-typed-${DATE_STAMP}-repeat.json`,
);
const DEFAULT_REPORTABLE_PATH = path.join(
  'artifacts',
  'research',
  'full-solve',
  `shadow-injection-run-ng-primary-reportable-${DATE_STAMP}.json`,
);
const DEFAULT_REPORTABLE_REPEAT_PATH = path.join(
  'artifacts',
  'research',
  'full-solve',
  `shadow-injection-run-ng-primary-reportable-${DATE_STAMP}-repeat.json`,
);
const DEFAULT_REPORTABLE_REFERENCE_PATH = path.join(
  'artifacts',
  'research',
  'full-solve',
  `shadow-injection-run-ng-primary-reportable-reference-${DATE_STAMP}.json`,
);
const DEFAULT_REPORTABLE_REFERENCE_REPEAT_PATH = path.join(
  'artifacts',
  'research',
  'full-solve',
  `shadow-injection-run-ng-primary-reportable-reference-${DATE_STAMP}-repeat.json`,
);
const DEFAULT_COMPAT_PATH = path.join('artifacts', 'research', 'full-solve', `ng-compat-check-${DATE_STAMP}.json`);
const DEFAULT_COMPAT_REPEAT_PATH = path.join(
  'artifacts',
  'research',
  'full-solve',
  `ng-compat-check-${DATE_STAMP}-repeat.json`,
);
const DEFAULT_COMPAT_REPORTABLE_PATH = path.join(
  'artifacts',
  'research',
  'full-solve',
  `ng-compat-check-reportable-${DATE_STAMP}.json`,
);
const DEFAULT_COMPAT_REPORTABLE_REPEAT_PATH = path.join(
  'artifacts',
  'research',
  'full-solve',
  `ng-compat-check-reportable-${DATE_STAMP}-repeat.json`,
);
const DEFAULT_OUT_PATH = path.join('artifacts', 'research', 'full-solve', `ng-repeat-determinism-${DATE_STAMP}.json`);

const readArgValue = (name: string, argv = process.argv.slice(2)): string | undefined => {
  const index = argv.findIndex((value) => value === name || value.startsWith(`${name}=`));
  if (index < 0) return undefined;
  if (argv[index].includes('=')) return argv[index].split('=', 2)[1];
  return argv[index + 1];
};

const readJson = (filePath: string): any => JSON.parse(fs.readFileSync(filePath, 'utf8'));
const stable = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

const resultClassifications = (payload: any): Record<string, string> =>
  Object.fromEntries((payload.results ?? []).map((row: any) => [String(row.id), String(row.classification)]));

const reasonCounts = (payload: any): Record<string, number> => payload.summary?.reasonCounts ?? {};

const evaluateRunPair = (current: any, repeat: any) => ({
  summaryStable: stable(current.summary ?? null, repeat.summary ?? null),
  winnerStable: stable(current.winnerScenarioId ?? null, repeat.winnerScenarioId ?? null),
  failureEnvelopeStable: stable(current.failureEnvelope ?? null, repeat.failureEnvelope ?? null),
  resultClassificationsStable: stable(resultClassifications(current), resultClassifications(repeat)),
  winnerScenarioId: current.winnerScenarioId ?? null,
  summary: current.summary ?? null,
});

const evaluateCompatPair = (current: any, repeat: any) => ({
  summaryStable: stable(current.summary ?? null, repeat.summary ?? null),
  reasonCountsStable: stable(reasonCounts(current), reasonCounts(repeat)),
  summary: current.summary ?? null,
});

export const buildNanogapRepeatDeterminism = (options: {
  pass1Path?: string;
  pass1RepeatPath?: string;
  pass2Path?: string;
  pass2RepeatPath?: string;
  reportablePath?: string;
  reportableRepeatPath?: string;
  reportableReferencePath?: string;
  reportableReferenceRepeatPath?: string;
  compatPath?: string;
  compatRepeatPath?: string;
  compatReportablePath?: string;
  compatReportableRepeatPath?: string;
  outPath?: string;
}) => {
  const pass1 = readJson(options.pass1Path ?? DEFAULT_PASS1_PATH);
  const pass1Repeat = readJson(options.pass1RepeatPath ?? DEFAULT_PASS1_REPEAT_PATH);
  const pass2 = readJson(options.pass2Path ?? DEFAULT_PASS2_PATH);
  const pass2Repeat = readJson(options.pass2RepeatPath ?? DEFAULT_PASS2_REPEAT_PATH);
  const reportable = readJson(options.reportablePath ?? DEFAULT_REPORTABLE_PATH);
  const reportableRepeat = readJson(options.reportableRepeatPath ?? DEFAULT_REPORTABLE_REPEAT_PATH);
  const reportableReference = readJson(options.reportableReferencePath ?? DEFAULT_REPORTABLE_REFERENCE_PATH);
  const reportableReferenceRepeat = readJson(
    options.reportableReferenceRepeatPath ?? DEFAULT_REPORTABLE_REFERENCE_REPEAT_PATH,
  );
  const compat = readJson(options.compatPath ?? DEFAULT_COMPAT_PATH);
  const compatRepeat = readJson(options.compatRepeatPath ?? DEFAULT_COMPAT_REPEAT_PATH);
  const compatReportable = readJson(options.compatReportablePath ?? DEFAULT_COMPAT_REPORTABLE_PATH);
  const compatReportableRepeat = readJson(options.compatReportableRepeatPath ?? DEFAULT_COMPAT_REPORTABLE_REPEAT_PATH);

  const pass1Eval = evaluateRunPair(pass1, pass1Repeat);
  const pass2Eval = evaluateRunPair(pass2, pass2Repeat);
  const reportableEval = evaluateRunPair(reportable, reportableRepeat);
  const reportableReferenceEval = evaluateRunPair(reportableReference, reportableReferenceRepeat);
  const compatEval = evaluateCompatPair(compat, compatRepeat);
  const compatReportableEval = evaluateCompatPair(compatReportable, compatReportableRepeat);

  const allStable = [
    pass1Eval.summaryStable,
    pass1Eval.winnerStable,
    pass1Eval.failureEnvelopeStable,
    pass1Eval.resultClassificationsStable,
    pass2Eval.summaryStable,
    pass2Eval.winnerStable,
    pass2Eval.failureEnvelopeStable,
    pass2Eval.resultClassificationsStable,
    reportableEval.summaryStable,
    reportableEval.winnerStable,
    reportableEval.failureEnvelopeStable,
    reportableEval.resultClassificationsStable,
    reportableReferenceEval.summaryStable,
    reportableReferenceEval.winnerStable,
    reportableReferenceEval.failureEnvelopeStable,
    reportableReferenceEval.resultClassificationsStable,
    compatEval.summaryStable,
    compatEval.reasonCountsStable,
    compatReportableEval.summaryStable,
    compatReportableEval.reasonCountsStable,
  ].every(Boolean);

  const payload = {
    generatedOn: new Date().toISOString(),
    pass1: pass1Eval,
    pass2: pass2Eval,
    reportable: reportableEval,
    reportableReference: reportableReferenceEval,
    compatCheck: compatEval,
    reportableCompatCheck: compatReportableEval,
    status: allStable ? 'PASS' : 'FAIL',
  };

  const outPath = options.outPath ?? DEFAULT_OUT_PATH;
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);

  return {
    ok: allStable,
    outPath,
    status: payload.status,
  };
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = buildNanogapRepeatDeterminism({
    pass1Path: readArgValue('--pass1') ?? DEFAULT_PASS1_PATH,
    pass1RepeatPath: readArgValue('--pass1-repeat') ?? DEFAULT_PASS1_REPEAT_PATH,
    pass2Path: readArgValue('--pass2') ?? DEFAULT_PASS2_PATH,
    pass2RepeatPath: readArgValue('--pass2-repeat') ?? DEFAULT_PASS2_REPEAT_PATH,
    reportablePath: readArgValue('--reportable') ?? DEFAULT_REPORTABLE_PATH,
    reportableRepeatPath: readArgValue('--reportable-repeat') ?? DEFAULT_REPORTABLE_REPEAT_PATH,
    reportableReferencePath: readArgValue('--reportable-reference') ?? DEFAULT_REPORTABLE_REFERENCE_PATH,
    reportableReferenceRepeatPath:
      readArgValue('--reportable-reference-repeat') ?? DEFAULT_REPORTABLE_REFERENCE_REPEAT_PATH,
    compatPath: readArgValue('--compat') ?? DEFAULT_COMPAT_PATH,
    compatRepeatPath: readArgValue('--compat-repeat') ?? DEFAULT_COMPAT_REPEAT_PATH,
    compatReportablePath: readArgValue('--compat-reportable') ?? DEFAULT_COMPAT_REPORTABLE_PATH,
    compatReportableRepeatPath: readArgValue('--compat-reportable-repeat') ?? DEFAULT_COMPAT_REPORTABLE_REPEAT_PATH,
    outPath: readArgValue('--out') ?? DEFAULT_OUT_PATH,
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exit(1);
}
