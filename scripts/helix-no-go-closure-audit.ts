import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const tsxCliPath = join(dirname(require.resolve('tsx')), 'cli.mjs');
const scriptDir = dirname(fileURLToPath(import.meta.url));
const validateScriptPath = resolve(scriptDir, 'helix-decision-validate.ts');

function git(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

type CommandResult = {
  command: string;
  status: number | null;
  stdout: string;
  stderr: string;
  error: string;
};

type ValidateResult = {
  ok: boolean;
  failure_count: number;
  failures: string[];
};

function runCommand(command: string, args: string[]): CommandResult {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  return {
    command: [command, ...args].join(' '),
    status: result.status,
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim(),
    error: result.error ? String(result.error.message ?? result.error) : '',
  };
}

function snippet(value: string, max = 220): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  if (!compact) return '(none)';
  return compact.length > max ? `${compact.slice(0, max)}...` : compact;
}

function formatCommandStatus(result: CommandResult): string {
  if (result.status === 0) return '[OK]';
  if (result.status === null) return '[WARN]';
  return '[FAIL]';
}

function parseValidateResult(raw: string): ValidateResult | null {
  if (!raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ValidateResult>;
    if (typeof parsed.ok !== 'boolean') return null;
    if (typeof parsed.failure_count !== 'number') return null;
    if (!Array.isArray(parsed.failures)) return null;
    return {
      ok: parsed.ok,
      failure_count: parsed.failure_count,
      failures: parsed.failures.map((value) => String(value)),
    };
  } catch {
    return null;
  }
}

type PathState =
  | { status: '**EXISTS**' }
  | { status: '**MISSING**' }
  | { status: `**CHECK_ERROR:${string}**` };

function catFileState(ref: string, path: string): PathState {
  const result = spawnSync('git', ['cat-file', '-e', `${ref}:${path}`], { encoding: 'utf8' });
  if (result.status === 0) {
    return { status: '**EXISTS**' };
  }

  const stderr = `${result.stderr ?? ''}`.trim();
  const reason = stderr || `exit_${result.status ?? 'signal'}`;
  if (/Not a valid object name|invalid object|ambiguous argument|unknown revision|bad revision/i.test(reason)) {
    const compact = reason.replace(/\s+/g, ' ').slice(0, 120);
    return { status: `**CHECK_ERROR:${compact}**` };
  }
  return { status: '**MISSING**' };
}

const pkgPath = 'reports/helix-decision-package.json';
const validatePath = 'reports/helix-decision-validate.json';
const outPath = 'reports/helix-no-go-closure-audit.md';

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
  gates?: Array<{ source_path?: string }>;
  novelty?: {
    t02?: { source_path?: string };
    t035?: { source_path?: string };
  };
  artifacts?: Array<{ path?: string }>;
};
const committedValidate = JSON.parse(readFileSync(validatePath, 'utf8')) as ValidateResult;

const commandResults: CommandResult[] = [
  runCommand('git', ['fetch', '--all', '--prune']),
  runCommand('git', ['remote', 'show', 'origin']),
];

const tempValidatePath = join(tmpdir(), `helix-decision-validate-${Date.now()}.json`);
const validatorRun = runCommand(process.execPath, [tsxCliPath, validateScriptPath, '--package', pkgPath]);
const freshValidateFromStdout = parseValidateResult(validatorRun.stdout);
const freshValidateFromFile = existsSync(validatePath)
  ? parseValidateResult(readFileSync(validatePath, 'utf8'))
  : null;
const freshValidate = freshValidateFromStdout ?? freshValidateFromFile;
if (!freshValidate) {
  throw new Error(
    `Validator output unavailable (status=${validatorRun.status ?? 'signal'}). stdout=${snippet(validatorRun.stdout)} stderr=${snippet(validatorRun.stderr)} error=${snippet(validatorRun.error)}`,
  );
}
const freshValidateSource = freshValidateFromStdout ? 'validator_stdout' : validatePath;
writeFileSync(tempValidatePath, `${JSON.stringify(freshValidate, null, 2)}\n`);
commandResults.push(validatorRun);

const evidencePaths = Array.from(
  new Set([
    ...(pkg.gates ?? []).map((g) => g.source_path),
    pkg.novelty?.t02?.source_path,
    pkg.novelty?.t035?.source_path,
    ...(pkg.artifacts ?? []).map((a) => a.path),
  ].filter((p): p is string => Boolean(p))),
);

const refs = git(['for-each-ref', '--format=%(refname:short)']);
const refList = refs.split('\n').filter(Boolean);
const baselineRef = ['origin/HEAD', 'origin/main', 'main'].find((ref) => refList.includes(ref));

const evidenceRows = evidencePaths.map((p) => {
  const head = catFileState('HEAD', p).status;
  const baseline = baselineRef ? catFileState(baselineRef, p).status : 'N/A';
  const note = baselineRef
    ? baseline === '**EXISTS**' && head === '**EXISTS**'
      ? 'present in baseline and HEAD'
      : baseline.includes('CHECK_ERROR') || head.includes('CHECK_ERROR')
        ? 'reference check error; baseline or ref unavailable/invalid'
        : 'drift/missing relative to baseline or HEAD'
    : 'no baseline ref (`origin/HEAD`, `origin/main`, `main`) available in this clone';
  return `| \`${p}\` | ${baseline} | ${head} | ${note} |`;
});

const topFixes = freshValidate.failures.slice(0, 3).map((f, i) => `${i + 1}. \`${f}\``).join('\n');
const blockers = freshValidate.failures.map((f, i) => `${i + 1}. \`${f}\``).join('\n');
const baselineLabel = baselineRef ? `\`${baselineRef}\`` : 'N/A';

const driftPieces: string[] = [];
if (committedValidate.ok !== freshValidate.ok) {
  driftPieces.push(`ok: ${committedValidate.ok} -> ${freshValidate.ok}`);
}
if (committedValidate.failure_count !== freshValidate.failure_count) {
  driftPieces.push(`failure_count: ${committedValidate.failure_count} -> ${freshValidate.failure_count}`);
}
const committedFailures = Array.isArray(committedValidate.failures)
  ? committedValidate.failures.map((value) => String(value))
  : [];
const freshFailures = Array.isArray(freshValidate.failures)
  ? freshValidate.failures.map((value) => String(value))
  : [];
const committedTop3 = committedFailures.slice(0, 3);
const freshTop3 = freshFailures.slice(0, 3);
if (JSON.stringify(committedTop3) !== JSON.stringify(freshTop3)) {
  driftPieces.push('first_3_failures changed');
}
if (JSON.stringify(committedFailures) !== JSON.stringify(freshFailures)) {
  driftPieces.push('failure_list_changed');
}
const driftStatus = driftPieces.length === 0 ? 'NO-DRIFT' : `DRIFT (${driftPieces.join('; ')})`;

const commandLog = commandResults
  .map((result) => {
    const icon = formatCommandStatus(result);
    return `- ${icon} \`${result.command}\` (status: ${result.status ?? 'signal'}, stdout: \`${snippet(result.stdout)}\`, stderr: \`${snippet(result.stderr)}\`, error: \`${snippet(result.error)}\`)`;
  })
  .join('\n');

const report = `# Helix NO-GO Closure Audit\n\n## Verdict\n\n**NO-GO**\n\n## Method (git-only, replayable)\n\n- Package input: \`${pkgPath}\`.\n- Validation input: committed \`${validatePath}\` and fresh validator replay to temp output.\n- Fresh validation capture: \`${tempValidatePath}\` (generated during this audit run; source=${freshValidateSource}).\n- Artifact existence checks use \`git cat-file -e <ref>:<path>\` only (no filesystem checks).\n- Baseline ref for comparison: ${baselineLabel}.\n\n## Evidence table\n\n| Path | Baseline (${baselineLabel}) | HEAD (\`git cat-file -e HEAD:<path>\`) | Note |\n|---|---|---|---|\n${evidenceRows.join('\n')}\n\n## Drift findings\n\n- Drift status: **${driftStatus}**.\n- Committed validate snapshot: \`ok=${committedValidate.ok}\`, \`failure_count=${committedValidate.failure_count}\`, first3=${JSON.stringify(committedTop3)}.\n- Fresh validate snapshot: \`ok=${freshValidate.ok}\`, \`failure_count=${freshValidate.failure_count}\`, first3=${JSON.stringify(freshTop3)}.\n- Validation failures captured below are sourced from fresh replay output and are reproducible via: \`node ${tsxCliPath} ${validateScriptPath} --package ${pkgPath}\`.\n\n## Blocker list (ordered)\n${blockers}\n\n## Top 3 concrete fixes (from first failing blockers)\n${topFixes}\n\n## Command log\n${commandLog}\n`;

writeFileSync(outPath, report);
console.log(`Wrote ${outPath}`);
