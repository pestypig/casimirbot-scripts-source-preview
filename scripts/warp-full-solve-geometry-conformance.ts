import fs from 'node:fs';
import path from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const DATE_STAMP = new Date().toISOString().slice(0, 10);
const DEFAULT_OUT_PATH = path.join(
  'artifacts',
  'research',
  'full-solve',
  `geometry-conformance-${DATE_STAMP}.json`,
);
const BOUNDARY_STATEMENT =
  'This campaign defines falsifiable reduced-order full-solve gates and reproducible evidence requirements; it is not a physical warp feasibility claim.';

type GeometryCheck = {
  id: string;
  label: string;
  testFile: string;
  implementationRefs: string[];
};

const CHECKS: GeometryCheck[] = [
  {
    id: 'metric_form_alignment',
    label: 'Metric form alignment',
    testFile: 'tests/theory-checks.spec.ts',
    implementationRefs: ['client/src/physics/alcubierre.ts:77', 'docs/alcubierre-alignment.md:16'],
  },
  {
    id: 'shift_mapping',
    label: 'Shift mapping',
    testFile: 'tests/warp-metric-adapter.spec.ts',
    implementationRefs: ['client/src/physics/alcubierre.ts:70', 'modules/warp/natario-warp.ts:81'],
  },
  {
    id: 'york_time_sign_parity',
    label: 'York-time sign/parity',
    testFile: 'tests/york-time.spec.ts',
    implementationRefs: ['client/src/physics/alcubierre.ts:91', 'tests/york-time.spec.ts:71'],
  },
  {
    id: 'natario_control_behavior',
    label: 'Natario control behavior',
    testFile: 'tests/warpfield-cross-validation.spec.ts',
    implementationRefs: ['modules/warp/natario-warp.ts:447', 'tests/warpfield-cross-validation.spec.ts:168'],
  },
  {
    id: 'metric_derived_t00_path',
    label: 'Metric-derived T00 path',
    testFile: 'tests/natario-metric-t00.spec.ts',
    implementationRefs: ['modules/warp/natario-warp.ts:635', 'tests/natario-metric-t00.spec.ts:20'],
  },
];

type RunResult = {
  status: 'pass' | 'fail';
  exitCode: number;
  durationMs: number;
  command: string;
};

const readArgValue = (name: string, argv = process.argv.slice(2)): string | undefined => {
  const index = argv.findIndex((value) => value === name || value.startsWith(`${name}=`));
  if (index < 0) return undefined;
  if (argv[index].includes('=')) return argv[index].split('=', 2)[1];
  return argv[index + 1];
};

const runVitestFile = (testFile: string): RunResult => {
  const npmCli = process.env.npm_execpath;
  const command = npmCli ? process.execPath : process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const args = npmCli ? [npmCli, 'run', 'test', '--', testFile] : ['run', 'test', '--', testFile];
  const commandLabel = `npm run test -- ${testFile}`;
  const started = Date.now();
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: false,
  });
  const exitCode = typeof result.status === 'number' ? result.status : 1;
  return {
    status: exitCode === 0 ? 'pass' : 'fail',
    exitCode,
    durationMs: Date.now() - started,
    command: commandLabel,
  };
};

export const runGeometryConformance = (options: { outPath?: string } = {}) => {
  const outPath = options.outPath ?? DEFAULT_OUT_PATH;
  const commitHash = execSync('git rev-parse HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

  const checks = CHECKS.map((check) => {
    const run = runVitestFile(check.testFile);
    return {
      ...check,
      ...run,
    };
  });

  const failCount = checks.filter((check) => check.status === 'fail').length;
  const passCount = checks.length - failCount;
  const payload = {
    artifactType: 'warp_geometry_conformance/v1',
    generatedOn: DATE_STAMP,
    generatedAt: new Date().toISOString(),
    commitHash,
    boundaryStatement: BOUNDARY_STATEMENT,
    summary: {
      checkCount: checks.length,
      passCount,
      failCount,
      allPass: failCount === 0,
    },
    checks,
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);

  return {
    ok: failCount === 0,
    outPath,
    summary: payload.summary,
  };
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = runGeometryConformance({
    outPath: readArgValue('--out') ?? DEFAULT_OUT_PATH,
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exit(1);
}
