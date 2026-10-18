import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { build as bundle } from 'esbuild';
import { root, ledger, inventory, hash } from './build-local-kit.mjs';

// All children are serial. Candidate consumers have no NODE_PATH, workspace
// mappings, launchers, provider environment or inherited npm credential config.
const runDir = fs.mkdtempSync(path.join(root, '.tmp/c10-proof-'));
const consumer = fs.mkdtempSync(path.join(os.tmpdir(), 'casimirbot-c10-consumer-'));
const npmCli = process.env.C10_NPM_CLI ?? path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
const mitCandidate = process.argv[2] === '--mit-candidate';
if (process.argv[2] && !mitCandidate) throw new Error('usage: node scripts/c10/verify-local-kit.mjs [--mit-candidate]');
const emptyConfig = path.join(consumer, 'empty.npmrc');
fs.writeFileSync(emptyConfig, '');
const emptyGlobalConfig = path.join(consumer, 'empty-global.npmrc');
fs.writeFileSync(emptyGlobalConfig, '');
const env = Object.fromEntries(['SystemRoot', 'WINDIR', 'ComSpec', 'PATH', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
Object.assign(env, { NPM_CONFIG_USERCONFIG: emptyConfig, NPM_CONFIG_GLOBALCONFIG: emptyGlobalConfig,
  NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org/', NPM_CONFIG_UPDATE_NOTIFIER: 'false' });
const commands = [];
function run(executable, args, cwd = root, extraEnv = {}) {
  const output = execFileSync(executable, args, { cwd, env: { ...env, ...extraEnv }, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 180000, windowsHide: true });
  commands.push({ executable, args, cwd, status: 'PASS' });
  return output;
}
const packs = [];
for (const iteration of ['a', 'b']) {
  const dir = path.join(runDir, iteration);
  const result = JSON.parse(run(process.execPath, ['scripts/c10/build-local-kit.mjs', dir, ...(mitCandidate ? ['--mit-candidate'] : [])]));
  const manifest = JSON.parse(fs.readFileSync(path.join(result.packageDir, 'package.json')));
  assert.equal(manifest.private, true, 'review candidate must remain unpublished');
  assert.equal(manifest.license, mitCandidate ? 'MIT' : 'UNLICENSED');
  const license = fs.readFileSync(path.join(result.packageDir, 'LICENSE'), 'utf8');
  if (mitCandidate) assert.equal(license, fs.readFileSync(path.join(root, 'packages/create-casimir-verifier/LICENSE'), 'utf8'));
  else assert.match(license, /No public license grant/);
  const notices = fs.readFileSync(path.join(result.packageDir, 'THIRD_PARTY_NOTICES.txt'), 'utf8');
  assert.match(notices, /Runtime dependency: zod/);
  assert.match(notices, /Permission is hereby granted/);
  const provenance = JSON.parse(fs.readFileSync(path.join(result.packageDir, 'provenance.json'), 'utf8'));
  const packagedSources = Object.keys(inventory(path.join(result.packageDir, 'src'))).sort();
  assert.deepEqual(packagedSources, Object.keys(provenance.generatedSource).sort(), 'selected source inventory differs');
  for (const [file, expectedHash] of Object.entries(provenance.generatedSource))
    assert.equal(hash(fs.readFileSync(path.join(result.packageDir, 'src', file))), expectedHash, `selected source differs:${file}`);
  const packed = JSON.parse(run(process.execPath, [npmCli, 'pack', '--ignore-scripts', '--json', '--pack-destination', dir], result.packageDir))[0];
  const archive = path.join(dir, packed.filename);
  assert.deepEqual(packed.files.map(file => file.path).sort(), Object.keys(inventory(result.packageDir)).sort());
  packs.push({ ...result, archive, archiveHash: hash(fs.readFileSync(archive)), inventory: inventory(result.packageDir) });
}
assert.deepEqual(packs[0].inventory, packs[1].inventory, 'two clean builds differ');
assert.equal(packs[0].archiveHash, packs[1].archiveHash, 'two npm archives differ');
console.log('PASS: identical package inventories and archive hashes');

const compiler = JSON.parse(fs.readFileSync(path.join(root, 'node_modules/typescript/package.json'))).version;
const nodeTypes = JSON.parse(fs.readFileSync(path.join(root, 'node_modules/@types/node/package.json'))).version;
fs.writeFileSync(path.join(consumer, 'package.json'), JSON.stringify({ name: 'c10-external-consumer', version: '1.0.0', private: true, type: 'module' }));
run(process.execPath, [npmCli, 'install', '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-offline', packs[0].archive, `typescript@${compiler}`, `@types/node@${nodeTypes}`], consumer);
const installed = path.join(consumer, 'node_modules/@casimirbot/environment-connector-kit');
assert.deepEqual(inventory(installed), packs[0].inventory, 'installed files differ from packaged files');
const sourceRebuild = path.join(consumer, 'source-rebuild');
fs.cpSync(installed, sourceRebuild, { recursive: true });
fs.rmSync(path.join(sourceRebuild, 'dist'), { recursive: true });
run(process.execPath, [npmCli, 'run', 'build'], sourceRebuild);
assert.deepEqual(inventory(path.join(sourceRebuild, 'dist')), inventory(path.join(installed, 'dist')), 'packaged TypeScript source does not reproduce compiled output');
console.log('PASS: packaged npm run build reproduces identical JavaScript and declarations');
for (const file of ['consumer-types.ts', 'consumer-smoke.mjs'])
  fs.copyFileSync(path.join(root, 'scripts/c10', file), path.join(consumer, file));
fs.writeFileSync(path.join(consumer, 'tsconfig.json'), JSON.stringify({
  compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, noEmit: true, skipLibCheck: false, types: ['node'] },
  files: ['consumer-types.ts'],
}));
run(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'], consumer);
const smoke = JSON.parse(run(process.execPath, ['consumer-smoke.mjs'], consumer));
console.log(`PASS: external TypeScript compilation and ${smoke.checks.length} runtime checks`);

// Validate declaration exports with the external compiler, including types.
const requireExternal = createRequire(path.join(consumer, 'package.json'));
const ts = requireExternal('typescript');
const contractDts = path.join(installed, 'dist/connectors/environment/contract/v1/index.d.ts');
const externalProgram = ts.createProgram([contractDts], { types: [], moduleResolution: ts.ModuleResolutionKind.NodeNext, module: ts.ModuleKind.NodeNext });
const checker = externalProgram.getTypeChecker();
const source = externalProgram.getSourceFile(contractDts);
const symbols = checker.getExportsOfModule(checker.getSymbolAtLocation(source));
assert.deepEqual(symbols.map(symbol => symbol.name).sort(), ledger().filter(row => row.candidate === 'include').map(row => row.symbol).sort());
const runtimeExports = symbols.filter(symbol => checker.getAliasedSymbol(symbol).flags & ts.SymbolFlags.Value).map(symbol => symbol.name).sort();
assert.deepEqual(smoke.runtimeExports, runtimeExports);

const canonicalFile = path.join(runDir, 'canonical.cjs');
await bundle({ entryPoints: [path.join(root, 'connectors/environment/contract/v1/index.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: canonicalFile, external: ['zod'], logLevel: 'silent' });
const canonical = createRequire(import.meta.url)(canonicalFile);
let comparisons = 0;
for (const [name, expected] of Object.entries(smoke.behavior)) {
  const actual = smoke.values.map(value => {
    const parsed = canonical[name].safeParse(value);
    return parsed.success ? { success: true, data: parsed.data } : { success: false, issues: parsed.error.issues };
  });
  assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected, `canonical schema mismatch:${name}`);
  comparisons += actual.length;
}
console.log(`PASS: ${comparisons} canonical schema behavior comparisons`);

// Use an installed JDK supplied by the caller; no automatic download or system
// Java changes. Failing this prerequisite leaves verification incomplete.
const javac = process.env.C10_JAVAC ?? 'javac';
const javaVersion = run(javac, ['-version'], consumer).trim();
assert.match(javaVersion, /javac 21\./, 'JDK 21 required for the selected proof');
run(javac, ['--release', '21', '-d', 'java-out', path.join(installed, 'java/com/casimirbot/helix/environment/HelixConnectorClient.java')], consumer);
console.log('PASS: external Java 21 compilation');
const endpointReport = path.join(runDir, 'endpoint-tests.json');
run(process.execPath, [path.join(root, 'node_modules/vitest/vitest.mjs'), 'run',
  'tests/c10-local-package-endpoint.spec.ts', '--pool=forks', '--maxWorkers=1', '--no-file-parallelism',
  '--reporter=json', '--outputFile', endpointReport], root, { C10_INSTALLED_PACKAGE: installed });
const endpointTests = JSON.parse(fs.readFileSync(endpointReport));
assert.equal(endpointTests.numPassedTests, 22);
assert.equal(endpointTests.numPendingTests, 0);
assert.equal(endpointTests.success, true);
console.log('PASS: 22 real-service pairing/probe checks against external SDK, no skipped cases');
const report = {
  status: 'PASS', scope: mitCandidate ? 'unpublished MIT source-release candidate and external consumer only' : 'private local assembly and external consumer only',
  runDir, consumer, packages: packs, tools: { node: process.version, typescript: compiler, nodeTypes, java: javaVersion },
  selectedExports: symbols.map(symbol => symbol.name).sort(), runtimeExports: smoke.runtimeExports,
  checks: smoke.checks, schemaCount: Object.keys(smoke.behavior).length, schemaComparisons: comparisons,
  commands, endpointReport, endpointPassed: endpointTests.numPassedTests,
  verifierInputs: Object.fromEntries(['scripts/c10/verify-local-kit.mjs', 'scripts/c10/consumer-smoke.mjs', 'scripts/c10/consumer-types.ts', 'tests/c10-local-package-endpoint.spec.ts'].map(file => [file, hash(fs.readFileSync(path.join(root, file)))])),
  consumerLockHash: hash(fs.readFileSync(path.join(consumer, 'package-lock.json'))),
  limitations: ['Fixture transport is not a real pairing/authorization endpoint.', 'No independent human developer, public rights, catalog, installed or release acceptance.'],
};
fs.writeFileSync(path.join(runDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ report: path.join(runDir, 'report.json'), archiveHash: packs[0].archiveHash, consumer }, null, 2));
