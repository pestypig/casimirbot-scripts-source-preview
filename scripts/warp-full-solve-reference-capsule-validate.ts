import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const DATE_STAMP = new Date().toISOString().slice(0, 10);
const BOUNDARY_STATEMENT =
  'This campaign defines falsifiable reduced-order full-solve gates and reproducible evidence requirements; it is not a physical warp feasibility claim.';
const DEFAULT_CAPSULE_PATH = path.join(
  'artifacts',
  'research',
  'full-solve',
  'full-solve-reference-capsule-latest.json',
);
const DEFAULT_OUT_JSON = path.join(
  'artifacts',
  'research',
  'full-solve',
  `full-solve-reference-capsule-validate-${DATE_STAMP}.json`,
);
const DEFAULT_OUT_MD = path.join(
  'docs',
  'audits',
  'research',
  `warp-full-solve-reference-capsule-validate-${DATE_STAMP}.md`,
);

type ValidationIssue = {
  code: string;
  severity: 'error' | 'warn';
  path: string | null;
  detail: string;
};

type CanonicalCounts = {
  PASS: number;
  FAIL: number;
  UNKNOWN: number;
  NOT_READY: number;
  NOT_APPLICABLE: number;
};

const REQUIRED_LANES = ['casimir_sign_control', 'q_spoiling', 'nanogap', 'timing', 'sem_ellipsometry'];
const REQUIRED_ENERGETICS_KEYS = [
  'negative_energy_branch_policy',
  'qei_worldline_requirement',
  'stress_source_contract',
  'assumption_domain_disclosure',
  'physical_feasibility_boundary',
];

const readArgValue = (name: string, argv = process.argv.slice(2)): string | undefined => {
  const index = argv.findIndex((value) => value === name || value.startsWith(`${name}=`));
  if (index < 0) return undefined;
  if (argv[index].includes('=')) return argv[index].split('=', 2)[1];
  return argv[index + 1];
};

const asText = (value: unknown): string | null => {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return null;
};

const asNumber = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const parseCounts = (value: unknown): CanonicalCounts => {
  const source = (value ?? {}) as Record<string, unknown>;
  return {
    PASS: asNumber(source.PASS) ?? 0,
    FAIL: asNumber(source.FAIL) ?? 0,
    UNKNOWN: asNumber(source.UNKNOWN) ?? 0,
    NOT_READY: asNumber(source.NOT_READY) ?? 0,
    NOT_APPLICABLE: asNumber(source.NOT_APPLICABLE) ?? 0,
  };
};

const countsEqual = (left: CanonicalCounts, right: CanonicalCounts): boolean =>
  left.PASS === right.PASS &&
  left.FAIL === right.FAIL &&
  left.UNKNOWN === right.UNKNOWN &&
  left.NOT_READY === right.NOT_READY &&
  left.NOT_APPLICABLE === right.NOT_APPLICABLE;

const sortedKeysObject = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map((entry) => sortedKeysObject(entry));
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      out[key] = sortedKeysObject(source[key]);
    }
    return out;
  }
  return value;
};

const computeChecksum = (payload: Record<string, unknown>): string => {
  const copy: Record<string, unknown> = JSON.parse(JSON.stringify(payload));
  delete copy.generated_at;
  delete copy.checksum;
  const canonical = JSON.stringify(sortedKeysObject(copy));
  return crypto.createHash('sha256').update(canonical).digest('hex');
};

const parseSummaryCounts = (payload: any) => {
  const summary = payload?.summary ?? {};
  return {
    scenarioCount: asNumber(summary.scenarioCount) ?? 0,
    congruent: asNumber(summary.congruent) ?? 0,
    incongruent: asNumber(summary.incongruent) ?? 0,
    unknown: asNumber(summary.unknown) ?? 0,
  };
};

const normalizePath = (value: string) => value.replace(/\\/g, '/');

const resolvePathFromRoot = (filePath: string, cwd: string): string =>
  path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);

const sanitizeReasonCounts = (value: unknown): Record<string, number> => {
  if (!value || typeof value !== 'object') return {};
  const counts: Record<string, number> = {};
  for (const [key, rawCount] of Object.entries(value as Record<string, unknown>)) {
    const count = Number(rawCount);
    if (Number.isFinite(count) && count > 0) counts[key] = count;
  }
  return counts;
};

const reasonCountsEqual = (left: Record<string, number>, right: Record<string, number>): boolean => {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length) return false;
  for (let index = 0; index < leftKeys.length; index += 1) {
    if (leftKeys[index] !== rightKeys[index]) return false;
    if (left[leftKeys[index]] !== right[rightKeys[index]]) return false;
  }
  return true;
};

const renderMarkdown = (payload: {
  capsulePath: string;
  pass: boolean;
  summary: {
    errorCount: number;
    warningCount: number;
    issueCount: number;
  };
  issues: ValidationIssue[];
}) => {
  const issueRows =
    payload.issues.length === 0
      ? '| none | none | n/a | none |\n'
      : payload.issues
          .map((issue) => `| ${issue.code} | ${issue.severity} | ${issue.path ?? 'n/a'} | ${issue.detail} |`)
          .join('\n');

  return `# Full-Solve Reference Capsule Validation (${DATE_STAMP})

"${BOUNDARY_STATEMENT}"

## Inputs
- capsule: \`${normalizePath(payload.capsulePath)}\`

## Result
- pass: \`${payload.pass}\`
- errors: \`${payload.summary.errorCount}\`
- warnings: \`${payload.summary.warningCount}\`
- total_issues: \`${payload.summary.issueCount}\`

## Issues
| code | severity | path | detail |
|---|---|---|---|
${issueRows}
`;
};

export const validateFullSolveReferenceCapsule = (options: {
  capsulePath?: string;
  outJsonPath?: string;
  outMdPath?: string;
}) => {
  const capsulePath = options.capsulePath ?? DEFAULT_CAPSULE_PATH;
  const outJsonPath = options.outJsonPath ?? DEFAULT_OUT_JSON;
  const outMdPath = options.outMdPath ?? DEFAULT_OUT_MD;
  const cwd = process.cwd();
  const issues: ValidationIssue[] = [];

  const addIssue = (issue: ValidationIssue) => {
    issues.push(issue);
  };

  const capsuleResolved = resolvePathFromRoot(capsulePath, cwd);
  if (!fs.existsSync(capsuleResolved)) {
    addIssue({
      code: 'capsule_missing',
      severity: 'error',
      path: normalizePath(capsulePath),
      detail: 'Capsule file does not exist.',
    });
  }

  const capsule = fs.existsSync(capsuleResolved)
    ? (JSON.parse(fs.readFileSync(capsuleResolved, 'utf8')) as Record<string, unknown>)
    : ({} as Record<string, unknown>);

  const artifactType = asText(capsule.artifact_type) ?? asText(capsule.artifactType);
  if (artifactType !== 'full_solve_reference_capsule/v1') {
    addIssue({
      code: 'artifact_type_invalid',
      severity: 'error',
      path: normalizePath(capsulePath),
      detail: `Expected full_solve_reference_capsule/v1, got ${String(artifactType)}.`,
    });
  }

  const boundaryStatement = asText(capsule.boundary_statement);
  if (boundaryStatement !== BOUNDARY_STATEMENT) {
    addIssue({
      code: 'boundary_statement_mismatch',
      severity: 'error',
      path: normalizePath(capsulePath),
      detail: 'Boundary statement is missing or does not match required verbatim text.',
    });
  }

  const commitPin = asText(capsule.commit_pin);
  if (!commitPin) {
    addIssue({
      code: 'missing_commit_pin',
      severity: 'error',
      path: normalizePath(capsulePath),
      detail: 'commit_pin is required.',
    });
  }

  const generatorVersion = asText(capsule.generator_version);
  if (!generatorVersion) {
    addIssue({
      code: 'missing_generator_version',
      severity: 'error',
      path: normalizePath(capsulePath),
      detail: 'generator_version is required.',
    });
  }

  const checksumExpected = asText(capsule.checksum);
  if (!checksumExpected) {
    addIssue({
      code: 'missing_checksum',
      severity: 'error',
      path: normalizePath(capsulePath),
      detail: 'checksum is required.',
    });
  } else {
    const checksumComputed = computeChecksum(capsule);
    if (checksumComputed !== checksumExpected) {
      addIssue({
        code: 'checksum_mismatch',
        severity: 'error',
        path: normalizePath(capsulePath),
        detail: `checksum mismatch: expected ${checksumExpected}, computed ${checksumComputed}.`,
      });
    }
  }

  const canonicalState = (capsule.canonical_state ?? {}) as Record<string, unknown>;
  if (!asText(canonicalState.decision)) {
    addIssue({
      code: 'missing_canonical_decision',
      severity: 'error',
      path: normalizePath(capsulePath),
      detail: 'canonical_state.decision is required.',
    });
  }

  const precedence = (canonicalState.precedence ?? {}) as Record<string, unknown>;
  const precedenceAuthority = asText(precedence.authority);
  if (precedenceAuthority !== 'canonical_report') {
    addIssue({
      code: 'precedence_authority_invalid',
      severity: 'error',
      path: normalizePath(capsulePath),
      detail: `Expected precedence authority canonical_report, got ${String(precedenceAuthority)}.`,
    });
  }

  const sourcePaths = (canonicalState.source_paths ?? {}) as Record<string, unknown>;
  const ledgerPath = asText(sourcePaths.decision_ledger);
  if (!ledgerPath) {
    addIssue({
      code: 'missing_decision_ledger_path',
      severity: 'error',
      path: normalizePath(capsulePath),
      detail: 'canonical_state.source_paths.decision_ledger is required.',
    });
  } else {
    const resolvedLedgerPath = resolvePathFromRoot(ledgerPath, cwd);
    if (!fs.existsSync(resolvedLedgerPath)) {
      addIssue({
        code: 'decision_ledger_not_found',
        severity: 'error',
        path: normalizePath(ledgerPath),
        detail: 'Decision ledger file does not exist.',
      });
    } else {
      const ledgerPayload = JSON.parse(fs.readFileSync(resolvedLedgerPath, 'utf8')) as Record<string, any>;
      const ledgerDecision = asText(ledgerPayload?.canonical?.decision);
      const ledgerCounts = parseCounts(ledgerPayload?.canonical?.counts);
      const capsuleDecision = asText(canonicalState.decision);
      const capsuleCounts = parseCounts(canonicalState.counts);
      if (ledgerDecision && capsuleDecision && ledgerDecision !== capsuleDecision) {
        addIssue({
          code: 'canonical_precedence_override_violation',
          severity: 'error',
          path: normalizePath(ledgerPath),
          detail: `Capsule decision ${capsuleDecision} does not match decision ledger ${ledgerDecision}.`,
        });
      }
      if (!countsEqual(capsuleCounts, ledgerCounts)) {
        addIssue({
          code: 'canonical_count_precedence_violation',
          severity: 'error',
          path: normalizePath(ledgerPath),
          detail: 'Capsule canonical counts do not match decision ledger canonical counts.',
        });
      }
    }
  }

  const sourceCommits = (canonicalState.source_commits ?? {}) as Record<string, unknown>;
  for (const [sourceName, sourceCommitValue] of Object.entries(sourceCommits)) {
    const sourceCommit = asText(sourceCommitValue);
    if (!sourceCommit || !commitPin) continue;
    if (sourceCommit !== commitPin) {
      addIssue({
        code: `source_commit_mismatch:${sourceName}`,
        severity: 'error',
        path: normalizePath(capsulePath),
        detail: `source commit ${sourceCommit} does not match capsule commit pin ${commitPin}.`,
      });
    }
  }

  const certification = (capsule.certification ?? {}) as Record<string, unknown>;
  const latestTrace = (certification.latest_trace ?? {}) as Record<string, unknown>;
  const certificateHash = asText(latestTrace.certificateHash);
  const integrityOk = latestTrace.integrityOk === true;
  if (!asText(latestTrace.traceId) || !asText(latestTrace.runId) || !asText(latestTrace.status) || !certificateHash) {
    addIssue({
      code: 'missing_certification_fields',
      severity: 'error',
      path: normalizePath(capsulePath),
      detail: 'certification.latest_trace requires traceId, runId, status, and certificateHash.',
    });
  }
  if (!integrityOk) {
    addIssue({
      code: 'certificate_integrity_not_ok',
      severity: 'error',
      path: normalizePath(capsulePath),
      detail: 'certification.latest_trace.integrityOk must be true.',
    });
  }

  const geometry = (capsule.geometry_conformance ?? {}) as Record<string, unknown>;
  const geometryPath = asText(geometry.path);
  const geometryChecks = Array.isArray(geometry.checks) ? geometry.checks : [];
  if (!geometryPath || geometryChecks.length === 0) {
    addIssue({
      code: 'geometry_block_missing',
      severity: 'error',
      path: normalizePath(capsulePath),
      detail: 'geometry_conformance.path and geometry_conformance.checks are required.',
    });
  } else {
    const resolvedGeometryPath = resolvePathFromRoot(geometryPath, cwd);
    if (!fs.existsSync(resolvedGeometryPath)) {
      addIssue({
        code: 'geometry_artifact_missing',
        severity: 'error',
        path: normalizePath(geometryPath),
        detail: 'Referenced geometry artifact does not exist.',
      });
    } else {
      const geometryPayload = JSON.parse(fs.readFileSync(resolvedGeometryPath, 'utf8')) as Record<string, any>;
      const artifactChecks = Array.isArray(geometryPayload.checks) ? geometryPayload.checks : [];
      if (artifactChecks.length !== geometryChecks.length) {
        addIssue({
          code: 'geometry_check_count_mismatch',
          severity: 'error',
          path: normalizePath(geometryPath),
          detail: `Capsule geometry checks (${geometryChecks.length}) do not match artifact checks (${artifactChecks.length}).`,
        });
      }
    }
  }

  const energetics = (capsule.energetics_qei_conformance ?? {}) as Record<string, unknown>;
  const energeticsSignature = (energetics.signature ?? {}) as Record<string, any>;
  if (Object.keys(energeticsSignature).length === 0) {
    addIssue({
      code: 'missing_energetics_qei_signature',
      severity: 'error',
      path: normalizePath(capsulePath),
      detail: 'energetics_qei_conformance.signature is required.',
    });
  } else {
    for (const key of REQUIRED_ENERGETICS_KEYS) {
      const entry = energeticsSignature[key];
      const status = asText(entry?.status);
      if (!status || !['pass', 'fail', 'unknown'].includes(status.toLowerCase())) {
        addIssue({
          code: `invalid_energetics_signature_status:${key}`,
          severity: 'error',
          path: normalizePath(capsulePath),
          detail: `energetics_qei_conformance.signature.${key}.status must be pass|fail|unknown.`,
        });
      }
    }
  }

  const grObservables = (capsule.gr_observables ?? {}) as Record<string, any>;
  const grObservableSpecs = [
    {
      key: 'mercury_perihelion',
      numericFields: ['predicted_arcsec_per_century', 'observed_arcsec_per_century', 'residual_arcsec_per_century'],
    },
    {
      key: 'lensing_deflection',
      numericFields: ['predicted_limb_arcsec', 'historical_observed_arcsec', 'historical_residual_arcsec', 'modern_gamma_measured', 'modern_gamma_residual'],
    },
    {
      key: 'frame_dragging',
      numericFields: ['gpb_predicted_mas_per_year', 'gpb_observed_mas_per_year', 'gpb_residual_mas_per_year', 'lageos_observed_ratio', 'lageos_residual_ratio'],
    },
    {
      key: 'shapiro_delay',
      numericFields: ['gamma_minus_one_measured', 'gamma_estimated', 'gamma_residual'],
    },
  ] as const;
  const sourceSnapshotPaths = (grObservables.source_snapshot_paths ?? {}) as Record<string, unknown>;
  for (const spec of grObservableSpecs) {
    const entry = (grObservables[spec.key] ?? {}) as Record<string, unknown>;
    if (Object.keys(entry).length === 0) {
      addIssue({
        code: `missing_gr_observable:${spec.key}`,
        severity: 'error',
        path: normalizePath(capsulePath),
        detail: `gr_observables.${spec.key} is required.`,
      });
      continue;
    }
    const status = asText(entry.status)?.toLowerCase();
    if (!status || !['pass', 'fail', 'unknown'].includes(status)) {
      addIssue({
        code: `invalid_gr_observable_status:${spec.key}`,
        severity: 'error',
        path: normalizePath(capsulePath),
        detail: `gr_observables.${spec.key}.status must be pass|fail|unknown.`,
      });
    }
    if (status !== 'unknown') {
      const missingNumeric = spec.numericFields.filter((field) => asNumber(entry[field]) == null);
      if (missingNumeric.length > 0) {
        addIssue({
          code: `invalid_gr_observable_numeric_fields:${spec.key}`,
          severity: 'error',
          path: normalizePath(capsulePath),
          detail: `Missing numeric fields for ${spec.key}: ${missingNumeric.join(', ')}.`,
        });
      }
    }
    const snapshotPath =
      asText(sourceSnapshotPaths[spec.key]) ??
      (spec.key === 'mercury_perihelion' ? asText(grObservables.source_snapshot_path) : null);
    if (!snapshotPath) {
      addIssue({
        code: `missing_gr_observable_snapshot_path:${spec.key}`,
        severity: 'warn',
        path: normalizePath(capsulePath),
        detail: `gr_observables.source_snapshot_paths.${spec.key} is not declared.`,
      });
      continue;
    }
    const resolvedSnapshotPath = resolvePathFromRoot(snapshotPath, cwd);
    if (!fs.existsSync(resolvedSnapshotPath)) {
      addIssue({
        code: `gr_observable_snapshot_missing:${spec.key}`,
        severity: 'error',
        path: normalizePath(snapshotPath),
        detail: `Referenced GR observable snapshot for ${spec.key} does not exist.`,
      });
    }
  }

  const evidenceLanes = (capsule.evidence_lanes ?? {}) as Record<string, any>;
  for (const lane of REQUIRED_LANES) {
    const lanePayload = evidenceLanes[lane];
    if (!lanePayload) {
      addIssue({
        code: `missing_lane:${lane}`,
        severity: 'error',
        path: normalizePath(capsulePath),
        detail: `Missing required lane summary ${lane}.`,
      });
      continue;
    }

    if (lanePayload.dependency_mode !== 'reference_only' || lanePayload.canonical_blocking !== false) {
      addIssue({
        code: `lane_policy_violation:${lane}`,
        severity: 'error',
        path: normalizePath(capsulePath),
        detail: 'Lane policy must remain reference_only with canonical_blocking=false.',
      });
    }

    for (const mode of ['typed', 'reportable', 'reportable_reference']) {
      const modePayload = lanePayload[mode] as Record<string, unknown> | undefined;
      if (!modePayload) continue;
      const modePath = asText(modePayload.path);
      if (!modePath) continue;
      const resolvedModePath = resolvePathFromRoot(modePath, cwd);
      if (!fs.existsSync(resolvedModePath)) {
        addIssue({
          code: `lane_summary_missing_artifact:${lane}:${mode}`,
          severity: 'error',
          path: normalizePath(modePath),
          detail: 'Lane summary references a missing artifact.',
        });
        continue;
      }
      const modeArtifact = JSON.parse(fs.readFileSync(resolvedModePath, 'utf8')) as Record<string, unknown>;
      const expected = parseSummaryCounts({ summary: modePayload.summary ?? {} });
      const actual = parseSummaryCounts(modeArtifact);
      const summaryMismatch =
        expected.scenarioCount !== actual.scenarioCount ||
        expected.congruent !== actual.congruent ||
        expected.incongruent !== actual.incongruent ||
        expected.unknown !== actual.unknown;
      if (summaryMismatch) {
        addIssue({
          code: `lane_summary_mismatch:${lane}:${mode}`,
          severity: 'error',
          path: normalizePath(modePath),
          detail: `Expected s/c/i/u=${expected.scenarioCount}/${expected.congruent}/${expected.incongruent}/${expected.unknown}, got ${actual.scenarioCount}/${actual.congruent}/${actual.incongruent}/${actual.unknown}.`,
        });
      }
    }
  }

  const qcdLane = evidenceLanes.qcd_analog as Record<string, any> | undefined;
  if (!qcdLane?.replay?.path) {
    addIssue({
      code: 'missing_lane:qcd_analog',
      severity: 'error',
      path: normalizePath(capsulePath),
      detail: 'Missing qcd_analog replay path in evidence lanes.',
    });
  }

  const externalComparison = (capsule.external_work_comparison ?? {}) as Record<string, any>;
  const externalPath = asText(externalComparison.path);
  if (!externalPath) {
    addIssue({
      code: 'missing_external_work_comparison_path',
      severity: 'error',
      path: normalizePath(capsulePath),
      detail: 'external_work_comparison.path is required.',
    });
  } else {
    const resolvedExternalPath = resolvePathFromRoot(externalPath, cwd);
    if (!fs.existsSync(resolvedExternalPath)) {
      addIssue({
        code: 'external_work_comparison_missing_artifact',
        severity: 'error',
        path: normalizePath(externalPath),
        detail: 'Referenced external work comparison matrix artifact does not exist.',
      });
    } else {
      const externalPayload = JSON.parse(fs.readFileSync(resolvedExternalPath, 'utf8')) as Record<string, any>;
      const expectedCounts = (externalComparison.summary_counts ?? {}) as Record<string, unknown>;
      const actualCounts = (externalPayload.summary_counts ?? {}) as Record<string, unknown>;
      const countKeys = ['total', 'compatible', 'partial', 'inconclusive'];
      for (const key of countKeys) {
        if (asNumber(expectedCounts[key]) !== asNumber(actualCounts[key])) {
          addIssue({
            code: `external_work_summary_mismatch:${key}`,
            severity: 'error',
            path: normalizePath(externalPath),
            detail: `Capsule summary_counts.${key} does not match matrix artifact.`,
          });
        }
      }
      const expectedWorks = Array.isArray(externalComparison.works) ? externalComparison.works.length : 0;
      const actualWorks = Array.isArray(externalPayload.works) ? externalPayload.works.length : 0;
      if (expectedWorks !== actualWorks) {
        addIssue({
          code: 'external_work_count_mismatch',
          severity: 'error',
          path: normalizePath(externalPath),
          detail: `Capsule external work count (${expectedWorks}) does not match matrix count (${actualWorks}).`,
        });
      }

      const expectedReducedReasonCounts = sanitizeReasonCounts(externalComparison.reduced_reason_counts);
      const actualReducedReasonCounts = sanitizeReasonCounts(externalPayload.reduced_reason_counts);
      if (!reasonCountsEqual(expectedReducedReasonCounts, actualReducedReasonCounts)) {
        addIssue({
          code: 'external_work_reduced_reason_mismatch',
          severity: 'error',
          path: normalizePath(externalPath),
          detail: 'Capsule reduced_reason_counts does not match matrix artifact reduced_reason_counts.',
        });
      }
    }
  }

  const pathsBlock = (capsule.paths ?? {}) as Record<string, unknown>;
  const latestPath = asText(pathsBlock.latest_json) ?? path.join(path.dirname(capsuleResolved), 'full-solve-reference-capsule-latest.json');
  const latestResolved = resolvePathFromRoot(latestPath, cwd);
  if (!fs.existsSync(latestResolved)) {
    addIssue({
      code: 'latest_alias_missing',
      severity: 'error',
      path: normalizePath(latestPath),
      detail: 'Latest JSON alias file does not exist.',
    });
  } else {
    const latestPayload = JSON.parse(fs.readFileSync(latestResolved, 'utf8')) as Record<string, unknown>;
    const latestChecksum = asText(latestPayload.checksum);
    const datedDir = path.dirname(latestResolved);
    const datedCandidates = fs
      .readdirSync(datedDir)
      .filter((entry) => /^full-solve-reference-capsule-\d{4}-\d{2}-\d{2}\.json$/.test(entry))
      .sort();
    const newestDated = datedCandidates.length > 0 ? path.join(datedDir, datedCandidates[datedCandidates.length - 1]) : null;

    if (!newestDated) {
      addIssue({
        code: 'dated_capsule_missing',
        severity: 'error',
        path: normalizePath(datedDir),
        detail: 'No dated capsule JSON files found.',
      });
    } else {
      const newestPayload = JSON.parse(fs.readFileSync(newestDated, 'utf8')) as Record<string, unknown>;
      const newestChecksum = asText(newestPayload.checksum);
      if (!latestChecksum || !newestChecksum || latestChecksum !== newestChecksum) {
        addIssue({
          code: 'latest_alias_not_newest',
          severity: 'error',
          path: normalizePath(latestPath),
          detail: `Latest alias checksum ${String(latestChecksum)} does not match newest dated checksum ${String(newestChecksum)}.`,
        });
      }
    }
  }

  const errorCount = issues.filter((issue) => issue.severity === 'error').length;
  const warningCount = issues.length - errorCount;
  const payload = {
    generatedOn: DATE_STAMP,
    capsulePath: normalizePath(capsulePath),
    pass: errorCount === 0,
    summary: {
      issueCount: issues.length,
      errorCount,
      warningCount,
    },
    issues,
  };

  fs.mkdirSync(path.dirname(outJsonPath), { recursive: true });
  fs.mkdirSync(path.dirname(outMdPath), { recursive: true });
  fs.writeFileSync(outJsonPath, `${JSON.stringify(payload, null, 2)}\n`);
  fs.writeFileSync(
    outMdPath,
    `${renderMarkdown({
      capsulePath: normalizePath(capsulePath),
      pass: payload.pass,
      summary: payload.summary,
      issues,
    })}\n`,
  );

  return {
    ok: payload.pass,
    outJsonPath,
    outMdPath,
    summary: payload.summary,
  };
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = validateFullSolveReferenceCapsule({
    capsulePath: readArgValue('--capsule') ?? DEFAULT_CAPSULE_PATH,
    outJsonPath: readArgValue('--out') ?? DEFAULT_OUT_JSON,
    outMdPath: readArgValue('--out-md') ?? DEFAULT_OUT_MD,
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exit(1);
}
