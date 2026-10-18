import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';

const DATE_STAMP = new Date().toISOString().slice(0, 10);
const GENERATOR_VERSION = '1.0.0';
const BOUNDARY_STATEMENT =
  'This campaign defines falsifiable reduced-order full-solve gates and reproducible evidence requirements; it is not a physical warp feasibility claim.';

const FULL_SOLVE_DIR = path.join('artifacts', 'research', 'full-solve');
const DOC_AUDIT_DIR = path.join('docs', 'audits', 'research');
const EXTERNAL_WORK_DIR = path.join(FULL_SOLVE_DIR, 'external-work');

const DEFAULT_CAPSULE_PATH = path.join(FULL_SOLVE_DIR, 'full-solve-reference-capsule-latest.json');
const DEFAULT_INTEGRITY_PATH = path.join(FULL_SOLVE_DIR, 'integrity-parity-suite-latest.json');
const DEFAULT_READINESS_PATH = path.join(FULL_SOLVE_DIR, 'promotion-readiness-suite-latest.json');
const DEFAULT_EXTERNAL_MATRIX_PATH = path.join(
  EXTERNAL_WORK_DIR,
  'external-work-comparison-matrix-latest.json',
);
const DEFAULT_SE_PUBLICATION_OVERLAY_PATH = path.join(
  FULL_SOLVE_DIR,
  'se-publication-overlay-latest.json',
);
const DEFAULT_PROOF_INDEX_PATH = path.join(
  'docs',
  'audits',
  'research',
  'warp-needle-hull-mark2-proof-anchor-index-latest.json',
);
const DEFAULT_DECISION_LEDGER_PATH = path.join(FULL_SOLVE_DIR, 'g4-decision-ledger-2026-02-26.json');

const DEFAULT_OUT_JSON = path.join(FULL_SOLVE_DIR, `state-of-record-synthesis-${DATE_STAMP}.json`);
const DEFAULT_OUT_MD = path.join(DOC_AUDIT_DIR, `warp-state-of-record-synthesis-${DATE_STAMP}.md`);
const DEFAULT_LATEST_JSON = path.join(FULL_SOLVE_DIR, 'state-of-record-synthesis-latest.json');
const DEFAULT_LATEST_MD = path.join(DOC_AUDIT_DIR, 'warp-state-of-record-synthesis-latest.md');

const readArgValue = (name: string, argv = process.argv.slice(2)): string | undefined => {
  const index = argv.findIndex((value) => value === name || value.startsWith(`${name}=`));
  if (index < 0) return undefined;
  if (argv[index].includes('=')) return argv[index].split('=', 2)[1];
  return argv[index + 1];
};

const normalizePath = (filePath: string): string => filePath.replace(/\\/g, '/');

const resolvePathFromRoot = (filePath: string): string =>
  path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);

const ensureDirForFile = (filePath: string) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
};

const readJson = (filePath: string): any => JSON.parse(fs.readFileSync(filePath, 'utf8'));

const objectWithSortedKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map((entry) => objectWithSortedKeys(entry));
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = objectWithSortedKeys(source[key]);
    return out;
  }
  return value;
};

const checksumPayload = (payload: Record<string, unknown>): string => {
  const copy: Record<string, unknown> = JSON.parse(JSON.stringify(payload));
  delete copy.generated_at;
  delete copy.checksum;
  const canonical = JSON.stringify(objectWithSortedKeys(copy));
  return crypto.createHash('sha256').update(canonical).digest('hex');
};

const asNumber = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const asText = (value: unknown): string | null => {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return null;
};

const requireJson = (label: string, filePath: string): any => {
  const resolved = resolvePathFromRoot(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`missing required ${label}: ${normalizePath(filePath)}`);
  }
  return readJson(resolved);
};

const getHeadCommit = (): string =>
  execSync('git rev-parse HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

const mdTableRow = (cells: Array<string | number | boolean>) => `| ${cells.join(' | ')} |`;

const buildMarkdown = (payload: Record<string, any>): string => {
  const canonical = payload.canonical;
  const geometry = payload.geometry;
  const gr = payload.gr_observables;
  const readiness = payload.readiness;
  const sePublicationOverlay = payload.se_publication_overlay;
  const cert = payload.certification;
  const external = payload.external_work;
  const blockers = payload.blockers as Array<Record<string, any>>;
  const lanes = readiness.lanes as Array<Record<string, any>>;

  const lines: string[] = [];
  lines.push(`# State-of-Record Synthesis (${payload.generated_on})`);
  lines.push('');
  lines.push(`"${BOUNDARY_STATEMENT}"`);
  lines.push('');
  lines.push('## Result');
  lines.push(`- artifact_type: \`${payload.artifact_type}\``);
  lines.push(`- commit_pin: \`${payload.commit_pin ?? 'UNKNOWN'}\``);
  lines.push(`- head_commit: \`${payload.head_commit}\``);
  lines.push(`- stale_against_head: \`${String(payload.stale_against_head)}\``);
  lines.push(`- overall_status: \`${payload.overall_status}\``);
  lines.push(`- checksum: \`${payload.checksum}\``);
  lines.push('');
  lines.push('## Canonical');
  lines.push(`- decision: \`${canonical.decision}\``);
  lines.push(
    `- counts: \`PASS=${canonical.counts.PASS}, FAIL=${canonical.counts.FAIL}, UNKNOWN=${canonical.counts.UNKNOWN}, NOT_READY=${canonical.counts.NOT_READY}, NOT_APPLICABLE=${canonical.counts.NOT_APPLICABLE}\``,
  );
  lines.push(`- source: \`${canonical.source_path}\``);
  lines.push('');
  lines.push('## Integrity Parity');
  lines.push(`- verdict: \`${payload.integrity_parity.verdict}\``);
  lines.push(`- blocker_count: \`${payload.integrity_parity.blocker_count}\``);
  lines.push(`- source: \`${payload.integrity_parity.source_path}\``);
  lines.push('');
  lines.push('## Geometry + GR Observable Parity');
  lines.push(
    `- geometry_all_pass: \`${String(geometry.all_pass)}\` (\`${geometry.pass_count}/${geometry.check_count}\`)`,
  );
  lines.push(`- mercury: \`${gr.mercury.status}\``);
  lines.push(`- lensing: \`${gr.lensing.status}\``);
  lines.push(`- frame_dragging: \`${gr.frame_dragging.status}\``);
  lines.push(`- shapiro: \`${gr.shapiro.status}\``);
  lines.push('');
  lines.push('## Promotion Readiness');
  lines.push(`- verdict: \`${readiness.verdict}\``);
  lines.push(`- readiness_gate_pass: \`${String(readiness.gate_pass)}\``);
  lines.push(`- lane_count: \`${readiness.lane_count}\``);
  lines.push(`- reportable_ready_count: \`${readiness.reportable_ready_count}\``);
  lines.push(`- blocked_count: \`${readiness.blocked_count}\``);
  lines.push(`- source: \`${readiness.source_path}\``);
  lines.push('');
  lines.push(mdTableRow(['lane', 'reportableReady', 'congruent', 'incongruent', 'unknown', 'blockedReasons']));
  lines.push(mdTableRow(['---', '---', '---:', '---:', '---:', '---']));
  for (const lane of lanes) {
    lines.push(
      mdTableRow([
        lane.laneId ?? 'UNKNOWN',
        String(Boolean(lane.reportableReady)),
        asNumber(lane.evidenceCongruence?.congruent) ?? 0,
        asNumber(lane.evidenceCongruence?.incongruent) ?? 0,
        asNumber(lane.evidenceCongruence?.unknown) ?? 0,
        (lane.blockedReasons ?? []).join(', ') || 'none',
      ]),
    );
  }
  lines.push('');
  lines.push('## SE Publication Overlay');
  lines.push(`- available: \`${String(Boolean(sePublicationOverlay.available))}\``);
  lines.push(`- reportable_unlock: \`${String(Boolean(sePublicationOverlay.reportable_unlock))}\``);
  lines.push(
    `- run_summary: \`scenarioCount=${sePublicationOverlay.run_summary.scenarioCount}, compatible=${sePublicationOverlay.run_summary.compatible}, partial=${sePublicationOverlay.run_summary.partial}, incompatible=${sePublicationOverlay.run_summary.incompatible}, error=${sePublicationOverlay.run_summary.error}\``,
  );
  lines.push(
    `- congruence_summary: \`congruent=${sePublicationOverlay.compat_summary.congruent}, incongruent=${sePublicationOverlay.compat_summary.incongruent}, unknown=${sePublicationOverlay.compat_summary.unknown}\``,
  );
  lines.push(`- blocked_reasons: \`${(sePublicationOverlay.blocked_reasons ?? []).join(', ') || 'none'}\``);
  lines.push(`- source: \`${sePublicationOverlay.source_path}\``);
  lines.push('');
  lines.push('## External Comparison');
  lines.push(
    `- summary: \`total=${external.summary.total}, compatible=${external.summary.compatible}, partial=${external.summary.partial}, inconclusive=${external.summary.inconclusive}\``,
  );
  lines.push(`- stale_count: \`${external.stale_count}\``);
  lines.push(`- source: \`${external.source_path}\``);
  lines.push('');
  lines.push('## Certification');
  lines.push(`- verdict: \`${cert.verdict}\``);
  lines.push(`- firstFail: \`${cert.firstFail ?? 'null'}\``);
  lines.push(`- traceId: \`${cert.traceId}\``);
  lines.push(`- runId: \`${cert.runId}\``);
  lines.push(`- certificateHash: \`${cert.certificateHash}\``);
  lines.push(`- integrityOk: \`${String(cert.integrityOk)}\``);
  lines.push(`- status: \`${cert.status}\``);
  lines.push('');
  lines.push('## Blockers');
  if (blockers.length === 0) {
    lines.push(mdTableRow(['id', 'severity', 'code', 'detail']));
    lines.push(mdTableRow(['---', '---', '---', '---']));
    lines.push(mdTableRow(['none', 'n/a', 'none', 'none']));
  } else {
    lines.push(mdTableRow(['id', 'severity', 'code', 'detail']));
    lines.push(mdTableRow(['---', '---', '---', '---']));
    for (const blocker of blockers) {
      lines.push(
        mdTableRow([
          blocker.id ?? 'UNKNOWN',
          blocker.severity ?? 'UNKNOWN',
          blocker.code ?? 'UNKNOWN',
          blocker.detail ?? 'UNKNOWN',
        ]),
      );
    }
  }
  lines.push('');
  lines.push('## Anchors');
  lines.push(`- proof_index: \`${payload.anchors.proof_index}\``);
  lines.push(`- capsule: \`${payload.anchors.capsule}\``);
  lines.push(`- integrity_parity: \`${payload.anchors.integrity_parity}\``);
  lines.push(`- promotion_readiness: \`${payload.anchors.promotion_readiness}\``);
  lines.push(`- external_matrix: \`${payload.anchors.external_matrix}\``);
  return lines.join('\n');
};

const main = () => {
  const outJsonArg = readArgValue('--out-json');
  const outMdArg = readArgValue('--out-md');
  const latestJsonArg = readArgValue('--latest-json');
  const latestMdArg = readArgValue('--latest-md');

  const outJsonRel = normalizePath(outJsonArg ?? DEFAULT_OUT_JSON);
  const outMdRel = normalizePath(outMdArg ?? DEFAULT_OUT_MD);
  const latestJsonRel = normalizePath(latestJsonArg ?? DEFAULT_LATEST_JSON);
  const latestMdRel = normalizePath(latestMdArg ?? DEFAULT_LATEST_MD);

  const capsule = requireJson('capsule', DEFAULT_CAPSULE_PATH);
  const integrity = requireJson('integrity parity suite', DEFAULT_INTEGRITY_PATH);
  const readiness = requireJson('promotion readiness suite', DEFAULT_READINESS_PATH);
  const external = requireJson('external comparison matrix', DEFAULT_EXTERNAL_MATRIX_PATH);
  const proofIndex = requireJson('proof anchor index', DEFAULT_PROOF_INDEX_PATH);
  const ledger = requireJson('decision ledger', DEFAULT_DECISION_LEDGER_PATH);
  const sePublicationOverlay = fs.existsSync(resolvePathFromRoot(DEFAULT_SE_PUBLICATION_OVERLAY_PATH))
    ? readJson(resolvePathFromRoot(DEFAULT_SE_PUBLICATION_OVERLAY_PATH))
    : null;
  const headCommit = getHeadCommit();

  const commitPin =
    asText(capsule?.commit_pin) ??
    asText(integrity?.commit_pin) ??
    asText(readiness?.commit_pin) ??
    asText(ledger?.commitHash) ??
    'UNKNOWN';

  const lanes: Array<Record<string, any>> = Array.isArray(readiness?.lane_reportable_coverage?.lanes)
    ? readiness.lane_reportable_coverage.lanes
    : [];
  const readinessBlockers: Array<Record<string, any>> = Array.isArray(readiness?.blockers)
    ? readiness.blockers
    : [];

  const blockers: Array<Record<string, any>> = [];
  if (commitPin !== 'UNKNOWN' && commitPin !== headCommit) {
    blockers.push({
      id: 'BLK-SOR-001',
      severity: 'MEDIUM',
      code: 'artifact_commit_pin_stale_vs_head',
      detail: `artifact commit_pin=${commitPin} differs from current HEAD=${headCommit}`,
    });
  }
  for (const blocker of readinessBlockers) {
    blockers.push({
      id: `BLK-SOR-RDY-${String(blockers.length + 1).padStart(3, '0')}`,
      severity: 'HIGH',
      code: asText(blocker.code) ?? 'readiness_blocker',
      detail: asText(blocker.detail) ?? 'UNKNOWN',
      path: asText(blocker.path),
    });
  }

  const payload: Record<string, any> = {
    artifact_type: 'state_of_record_synthesis/v1',
    generator_version: GENERATOR_VERSION,
    generated_on: DATE_STAMP,
    generated_at: new Date().toISOString(),
    boundary_statement: BOUNDARY_STATEMENT,
    commit_pin: commitPin,
    head_commit: headCommit,
    stale_against_head: commitPin !== 'UNKNOWN' ? commitPin !== headCommit : null,
    overall_status: asText(readiness?.final_readiness_verdict) ?? 'UNKNOWN',
    canonical: {
      decision:
        asText(capsule?.canonical_state?.decision) ??
        asText(ledger?.canonical?.decision) ??
        asText(integrity?.canonical?.decision) ??
        'UNKNOWN',
      counts: capsule?.canonical_state?.counts ?? ledger?.canonical?.counts ?? integrity?.canonical?.counts ?? {},
      first_fail:
        asText(capsule?.canonical_state?.first_fail) ??
        asText(ledger?.canonical?.firstFail) ??
        asText(integrity?.canonical?.firstFail) ??
        'none',
      source_path: normalizePath(DEFAULT_DECISION_LEDGER_PATH),
    },
    integrity_parity: {
      verdict: asText(integrity?.final_parity_verdict) ?? 'UNKNOWN',
      blocker_count: asNumber(integrity?.blocker_count) ?? 0,
      source_path: normalizePath(DEFAULT_INTEGRITY_PATH),
    },
    geometry: {
      all_pass:
        typeof capsule?.geometry_conformance?.summary?.allPass === 'boolean'
          ? capsule.geometry_conformance.summary.allPass
          : null,
      pass_count: asNumber(capsule?.geometry_conformance?.summary?.passCount) ?? 0,
      check_count: asNumber(capsule?.geometry_conformance?.summary?.checkCount) ?? 0,
      source_path: asText(capsule?.geometry_conformance?.path) ?? null,
    },
    gr_observables: {
      mercury: {
        status: asText(capsule?.gr_observables?.mercury_perihelion?.status) ?? 'UNKNOWN',
        residual_arcsec_per_century:
          asNumber(capsule?.gr_observables?.mercury_perihelion?.residual_arcsec_per_century) ?? null,
      },
      lensing: {
        status: asText(capsule?.gr_observables?.lensing_deflection?.status) ?? 'UNKNOWN',
        historical_residual_arcsec:
          asNumber(capsule?.gr_observables?.lensing_deflection?.historical_residual_arcsec) ?? null,
        gamma_residual: asNumber(capsule?.gr_observables?.lensing_deflection?.modern_gamma_residual) ?? null,
      },
      frame_dragging: {
        status: asText(capsule?.gr_observables?.frame_dragging?.status) ?? 'UNKNOWN',
        gpb_residual_mas_per_year:
          asNumber(capsule?.gr_observables?.frame_dragging?.gpb_residual_mas_per_year) ?? null,
        lageos_residual_ratio:
          asNumber(capsule?.gr_observables?.frame_dragging?.lageos_residual_ratio) ?? null,
      },
      shapiro: {
        status: asText(capsule?.gr_observables?.shapiro_delay?.status) ?? 'UNKNOWN',
        gamma_residual: asNumber(capsule?.gr_observables?.shapiro_delay?.gamma_residual) ?? null,
      },
      source_paths: capsule?.gr_observables?.source_snapshot_paths ?? {},
    },
    readiness: {
      verdict: asText(readiness?.final_readiness_verdict) ?? 'UNKNOWN',
      gate_pass: Boolean(readiness?.readiness_gate_pass),
      lane_count: asNumber(readiness?.lane_reportable_coverage?.lane_count) ?? lanes.length,
      reportable_ready_count:
        asNumber(readiness?.lane_reportable_coverage?.reportable_ready_count) ??
        lanes.filter((lane) => Boolean(lane?.reportableReady)).length,
      blocked_count:
        asNumber(readiness?.lane_reportable_coverage?.blocked_count) ??
        lanes.filter((lane) => !Boolean(lane?.reportableReady)).length,
      lanes,
      source_path: normalizePath(DEFAULT_READINESS_PATH),
    },
    se_publication_overlay: {
      available: Boolean(sePublicationOverlay),
      reportable_unlock: Boolean(sePublicationOverlay?.policy?.reportableUnlock),
      run_summary: {
        scenarioCount: asNumber(sePublicationOverlay?.run?.summary?.scenarioCount) ?? 0,
        compatible: asNumber(sePublicationOverlay?.run?.summary?.compatible) ?? 0,
        partial: asNumber(sePublicationOverlay?.run?.summary?.partial) ?? 0,
        incompatible: asNumber(sePublicationOverlay?.run?.summary?.incompatible) ?? 0,
        error: asNumber(sePublicationOverlay?.run?.summary?.error) ?? 0,
      },
      compat_summary: {
        scenarioCount: asNumber(sePublicationOverlay?.compat?.summary?.scenarioCount) ?? 0,
        congruent: asNumber(sePublicationOverlay?.compat?.summary?.congruent) ?? 0,
        incongruent: asNumber(sePublicationOverlay?.compat?.summary?.incongruent) ?? 0,
        unknown: asNumber(sePublicationOverlay?.compat?.summary?.unknown) ?? 0,
      },
      blocked_reasons: Array.isArray(sePublicationOverlay?.policy?.blockedReasons)
        ? sePublicationOverlay.policy.blockedReasons
            .map((value: unknown) => String(value ?? '').trim())
            .filter((value: string) => value.length > 0)
        : [],
      source_path: normalizePath(DEFAULT_SE_PUBLICATION_OVERLAY_PATH),
    },
    external_work: {
      summary: external?.summary_counts ?? {},
      stale_count: asNumber(external?.stale_flags?.stale_count) ?? 0,
      source_path: normalizePath(DEFAULT_EXTERNAL_MATRIX_PATH),
    },
    certification: {
      verdict: asText(integrity?.casimir?.verdict) ?? 'UNKNOWN',
      firstFail: asText(integrity?.casimir?.firstFail),
      traceId: asText(integrity?.casimir?.traceId),
      runId: asText(integrity?.casimir?.runId),
      certificateHash: asText(integrity?.casimir?.certificateHash),
      integrityOk: Boolean(integrity?.casimir?.integrityOk),
      status: asText(integrity?.casimir?.status),
    },
    blockers,
    blocker_count: blockers.length,
    anchors: {
      proof_index: normalizePath(DEFAULT_PROOF_INDEX_PATH),
      capsule: normalizePath(DEFAULT_CAPSULE_PATH),
      integrity_parity: normalizePath(DEFAULT_INTEGRITY_PATH),
      promotion_readiness: normalizePath(DEFAULT_READINESS_PATH),
      external_matrix: normalizePath(DEFAULT_EXTERNAL_MATRIX_PATH),
    },
    paths: {
      dated_json: outJsonRel,
      latest_json: latestJsonRel,
      dated_md: outMdRel,
      latest_md: latestMdRel,
    },
    source_artifacts: {
      proof_index_alias: asText(proofIndex?.alias) ?? null,
      proof_index_artifact_type: asText(proofIndex?.artifact_type) ?? null,
      capsule_artifact_type: asText(capsule?.artifact_type ?? capsule?.artifactType) ?? null,
      integrity_artifact_type: asText(integrity?.artifact_type) ?? null,
      readiness_artifact_type: asText(readiness?.artifact_type) ?? null,
      external_matrix_artifact_type: asText(external?.artifact_type) ?? null,
    },
  };

  payload.normalized_checksum = checksumPayload(payload);
  payload.checksum = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');

  const markdown = buildMarkdown(payload);

  const outJsonAbs = resolvePathFromRoot(outJsonRel);
  const outMdAbs = resolvePathFromRoot(outMdRel);
  const latestJsonAbs = resolvePathFromRoot(latestJsonRel);
  const latestMdAbs = resolvePathFromRoot(latestMdRel);

  ensureDirForFile(outJsonAbs);
  ensureDirForFile(outMdAbs);
  ensureDirForFile(latestJsonAbs);
  ensureDirForFile(latestMdAbs);

  fs.writeFileSync(outJsonAbs, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.writeFileSync(outMdAbs, `${markdown}\n`, 'utf8');
  fs.copyFileSync(outJsonAbs, latestJsonAbs);
  fs.copyFileSync(outMdAbs, latestMdAbs);

  console.log(
    JSON.stringify(
      {
        ok: true,
        out_json: normalizePath(outJsonRel),
        out_md: normalizePath(outMdRel),
        latest_json: normalizePath(latestJsonRel),
        latest_md: normalizePath(latestMdRel),
        overall_status: payload.overall_status,
        blocker_count: payload.blocker_count,
        commit_pin: payload.commit_pin,
        head_commit: payload.head_commit,
      },
      null,
      2,
    ),
  );
};

main();
