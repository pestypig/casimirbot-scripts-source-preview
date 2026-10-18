import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

// Offline candidate evidence only: deliberately not clean-installed Windows QA.
const candidate = path.resolve(process.argv[2] ?? '.codex-build/solar-runtime-candidate-v1');
const manifest = JSON.parse(await readFile(path.join(candidate, 'candidate-manifest.json'), 'utf8'));
if (manifest.schemaVersion !== 'solar-runtime-candidate/1' ||
    manifest.entry !== 'solar-exporter/solar-exporter.exe' ||
    manifest.scienceRunAllowed !== false) throw new Error('Unexpected candidate contract');
for (const item of manifest.files) {
  const target = path.resolve(candidate, item.path);
  if (!target.startsWith(candidate + path.sep) || !/^[a-f0-9]{64}$/.test(item.sha256)) {
    throw new Error('Invalid candidate hash entry');
  }
  const hash = createHash('sha256').update(await readFile(target)).digest('hex');
  if (hash !== item.sha256) throw new Error(`Candidate integrity mismatch: ${item.path}`);
}
const workspace = await mkdtemp(path.join(os.tmpdir(), 'casimir-solar-native-smoke-'));
const env = { ...process.env, PATH: '', MPLCONFIGDIR: path.join(workspace, 'matplotlib') };
delete env.PYTHONHOME;
delete env.PYTHONPATH;
const executable = path.join(candidate, manifest.entry);
const options = { cwd: workspace, env, windowsHide: true, timeout: 60000, maxBuffer: 1024 * 1024 };
const evidence = {
  schemaVersion: 'solar-runtime-offline-smoke/1',
  testedAt: new Date().toISOString(),
  executable, workspace, systemPythonOnPath: false,
  candidateManifestSha256: createHash('sha256').update(await readFile(path.join(candidate, 'candidate-manifest.json'))).digest('hex'),
  checkedFileCount: manifest.files.length,
  cleanWindowsVerified: false, publicReleaseReady: false, scienceRunAllowed: false,
};
try {
  const probe = await promisify(execFile)(executable, ['--runtime-check'], options);
  evidence.capability = JSON.parse(probe.stdout);
  evidence.probeStderr = probe.stderr;
  if (evidence.capability.available !== true || evidence.capability.scienceRunAllowed !== false) {
    throw new Error('Native capability probe is unavailable');
  }
  const help = await promisify(execFile)(executable, ['--help'], options);
  evidence.helpPassed = help.stdout.includes('--images-only') && help.stdout.includes('--out-dir');
  evidence.helpStderr = help.stderr;
  if (!evidence.helpPassed) throw new Error('Frozen exporter CLI contract missing');
  evidence.passed = true;
} catch (error) {
  evidence.passed = false;
  evidence.error = String(error);
  evidence.stderr = error.stderr ?? null;
  process.exitCode = 1;
}
const report = path.join(workspace, 'offline-smoke.json');
await writeFile(report, JSON.stringify(evidence, null, 2));
console.log(JSON.stringify({ passed: evidence.passed, report, cleanWindowsVerified: false }));
