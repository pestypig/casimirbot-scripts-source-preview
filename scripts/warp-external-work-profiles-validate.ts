import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ALLOWED_CONFIDENCE_TIERS,
  ALLOWED_MIRROR_LANES,
  ALLOWED_SOURCE_CLASSES,
  BOUNDARY_STATEMENT,
  DEFAULT_CHAIN_CONTRACT_PATH,
  DEFAULT_CITATION_PACK_PATH,
  DEFAULT_EXTERNAL_WORK_DIR,
  DEFAULT_EXTERNAL_WORK_DOC_DIR,
  DEFAULT_PROFILE_PATH,
  DEFAULT_REGISTRY_PATH,
  EXTERNAL_WORK_SCHEMA,
  asText,
  normalizePath,
  parseChainIds,
  parseCitationSourceMeta,
  parseRegistryRows,
  readArgValue,
  resolvePathFromRoot,
} from './warp-external-work-utils.js';

const DATE_STAMP = new Date().toISOString().slice(0, 10);
const DEFAULT_OUT_JSON = path.join(
  DEFAULT_EXTERNAL_WORK_DIR,
  `external-work-profiles-validate-${DATE_STAMP}.json`,
);
const DEFAULT_OUT_MD = path.join(
  DEFAULT_EXTERNAL_WORK_DOC_DIR,
  `warp-external-work-profiles-validate-${DATE_STAMP}.md`,
);

type ValidationIssue = {
  code: string;
  severity: 'error' | 'warn';
  path: string;
  detail: string;
};

const addIssue = (
  issues: ValidationIssue[],
  code: string,
  severity: 'error' | 'warn',
  issuePath: string,
  detail: string,
) => {
  issues.push({
    code,
    severity,
    path: normalizePath(issuePath),
    detail,
  });
};

const parseScenarioPackRefs = (scenarioPackPath: string): Set<string> => {
  const payload = JSON.parse(fs.readFileSync(scenarioPackPath, 'utf8')) as {
    scenarios?: Array<{ registryRefs?: string[] }>;
  };
  const refs = new Set<string>();
  for (const scenario of payload.scenarios ?? []) {
    for (const ref of scenario.registryRefs ?? []) {
      refs.add(String(ref).trim().toUpperCase());
    }
  }
  return refs;
};

const renderMarkdown = (payload: {
  profilePath: string;
  pass: boolean;
  summary: { issueCount: number; errorCount: number; warningCount: number };
  issues: ValidationIssue[];
}) => {
  const rows =
    payload.issues.length === 0
      ? '| none | none | n/a | none |\n'
      : payload.issues
          .map((issue) => `| ${issue.code} | ${issue.severity} | ${issue.path} | ${issue.detail} |`)
          .join('\n');
  return `# External Work Profiles Validation (${DATE_STAMP})

"${BOUNDARY_STATEMENT}"

## Inputs
- profile: \`${normalizePath(payload.profilePath)}\`

## Result
- pass: \`${payload.pass}\`
- errors: \`${payload.summary.errorCount}\`
- warnings: \`${payload.summary.warningCount}\`
- total_issues: \`${payload.summary.issueCount}\`

## Issues
| code | severity | path | detail |
|---|---|---|---|
${rows}
`;
};

export const validateExternalWorkProfiles = (options: {
  profilePath?: string;
  registryPath?: string;
  chainContractPath?: string;
  citationPackPath?: string;
  outJsonPath?: string;
  outMdPath?: string;
}) => {
  const profilePath = options.profilePath ?? DEFAULT_PROFILE_PATH;
  const registryPath = options.registryPath ?? DEFAULT_REGISTRY_PATH;
  const chainContractPath = options.chainContractPath ?? DEFAULT_CHAIN_CONTRACT_PATH;
  const citationPackPath = options.citationPackPath ?? DEFAULT_CITATION_PACK_PATH;
  const outJsonPath = options.outJsonPath ?? DEFAULT_OUT_JSON;
  const outMdPath = options.outMdPath ?? DEFAULT_OUT_MD;

  const issues: ValidationIssue[] = [];
  const profileResolved = resolvePathFromRoot(profilePath);
  const registryResolved = resolvePathFromRoot(registryPath);
  const chainResolved = resolvePathFromRoot(chainContractPath);
  const citationResolved = resolvePathFromRoot(citationPackPath);

  if (!fs.existsSync(profileResolved)) {
    addIssue(issues, 'profile_missing', 'error', profilePath, 'External work profile config is missing.');
  }
  if (!fs.existsSync(registryResolved)) {
    addIssue(issues, 'registry_missing', 'error', registryPath, 'Registry file is missing.');
  }
  if (!fs.existsSync(chainResolved)) {
    addIssue(issues, 'chain_contract_missing', 'error', chainContractPath, 'Chain contract file is missing.');
  }
  if (!fs.existsSync(citationResolved)) {
    addIssue(issues, 'citation_pack_missing', 'error', citationPackPath, 'Citation pack file is missing.');
  }

  const profilePayload = fs.existsSync(profileResolved)
    ? (JSON.parse(fs.readFileSync(profileResolved, 'utf8')) as Record<string, unknown>)
    : {};
  const registryRows = fs.existsSync(registryResolved)
    ? parseRegistryRows(fs.readFileSync(registryResolved, 'utf8'))
    : [];
  const chainIds = fs.existsSync(chainResolved) ? parseChainIds(fs.readFileSync(chainResolved, 'utf8')) : new Set<string>();
  const citationMeta = fs.existsSync(citationResolved)
    ? parseCitationSourceMeta(fs.readFileSync(citationResolved, 'utf8'))
    : new Map<string, { source_id: string; source_class: string | null; confidence_tier: string | null }>();

  const schemaVersion = asText(profilePayload.schema_version);
  if (schemaVersion !== EXTERNAL_WORK_SCHEMA) {
    addIssue(
      issues,
      'schema_version_invalid',
      'error',
      profilePath,
      `Expected ${EXTERNAL_WORK_SCHEMA}, got ${String(schemaVersion)}.`,
    );
  }

  const boundary = asText(profilePayload.boundary_statement);
  if (boundary !== BOUNDARY_STATEMENT) {
    addIssue(issues, 'boundary_statement_mismatch', 'error', profilePath, 'Boundary statement mismatch.');
  }

  const defaults = (profilePayload.defaults ?? {}) as Record<string, unknown>;
  if (asText(defaults.data_policy)?.toLowerCase() !== 'snapshot_first') {
    addIssue(issues, 'defaults_data_policy_invalid', 'error', profilePath, 'defaults.data_policy must be snapshot_first.');
  }
  if (asText(defaults.comparison_depth)?.toLowerCase() !== 'dual_track') {
    addIssue(
      issues,
      'defaults_comparison_depth_invalid',
      'error',
      profilePath,
      'defaults.comparison_depth must be dual_track.',
    );
  }

  const profiles = Array.isArray(profilePayload.profiles) ? profilePayload.profiles : [];
  if (profiles.length === 0) {
    addIssue(issues, 'profiles_empty', 'error', profilePath, 'profiles[] must contain at least one profile.');
  }

  const seenWorkIds = new Set<string>();
  const registrySet = new Set(registryRows.map((row) => row.entry_id.toUpperCase()));

  for (const entry of profiles) {
    const profile = (entry ?? {}) as Record<string, unknown>;
    const workId = asText(profile.work_id);
    const title = asText(profile.title);
    const profileLabel = workId ?? '<missing-work-id>';

    if (!workId) {
      addIssue(issues, 'profile_missing_work_id', 'error', profilePath, 'Each profile requires work_id.');
      continue;
    }
    if (seenWorkIds.has(workId.toUpperCase())) {
      addIssue(issues, `duplicate_work_id:${workId}`, 'error', profilePath, 'work_id must be unique.');
    }
    seenWorkIds.add(workId.toUpperCase());

    if (!title) {
      addIssue(issues, `missing_title:${workId}`, 'error', profilePath, 'title is required.');
    }

    const commitPin = asText(profile.commit_pin);
    const commitOk = commitPin === 'latest' || /^[0-9a-f]{40}$/i.test(commitPin ?? '');
    if (!commitOk) {
      addIssue(
        issues,
        `invalid_commit_pin:${workId}`,
        'error',
        profilePath,
        'commit_pin must be latest or a 40-char git commit hash.',
      );
    }

    const posture = (profile.posture ?? {}) as Record<string, unknown>;
    if (posture.reference_only !== true || posture.canonical_blocking !== false) {
      addIssue(
        issues,
        `invalid_posture:${workId}`,
        'error',
        profilePath,
        'posture must lock reference_only=true and canonical_blocking=false.',
      );
    }

    const sourceRefs = Array.isArray(profile.source_refs) ? profile.source_refs.map(String) : [];
    if (sourceRefs.length === 0) {
      addIssue(issues, `missing_source_refs:${workId}`, 'error', profilePath, 'source_refs[] is required.');
    }
    for (const sourceRef of sourceRefs) {
      const meta = citationMeta.get(sourceRef.toUpperCase());
      if (!meta) {
        addIssue(
          issues,
          `unknown_source_ref:${workId}:${sourceRef}`,
          'error',
          citationPackPath,
          'source_refs entry not found in citation pack.',
        );
        continue;
      }
      const sourceClass = (meta.source_class ?? '').toLowerCase();
      const confidence = (meta.confidence_tier ?? '').toLowerCase();
      if (!ALLOWED_SOURCE_CLASSES.includes(sourceClass)) {
        addIssue(
          issues,
          `invalid_source_class:${workId}:${sourceRef}`,
          'error',
          citationPackPath,
          `source_class must be one of ${ALLOWED_SOURCE_CLASSES.join(', ')}.`,
        );
      }
      if (!ALLOWED_CONFIDENCE_TIERS.includes(confidence)) {
        addIssue(
          issues,
          `invalid_confidence_tier:${workId}:${sourceRef}`,
          'error',
          citationPackPath,
          `confidence_tier must be one of ${ALLOWED_CONFIDENCE_TIERS.join(', ')}.`,
        );
      }
    }

    const chainIdValues = Array.isArray(profile.chain_ids) ? profile.chain_ids.map(String) : [];
    if (chainIdValues.length === 0) {
      addIssue(issues, `missing_chain_ids:${workId}`, 'error', profilePath, 'chain_ids[] is required.');
    }
    for (const chainId of chainIdValues) {
      if (!chainIds.has(chainId.toUpperCase())) {
        addIssue(
          issues,
          `unknown_chain_id:${workId}:${chainId}`,
          'error',
          chainContractPath,
          'chain_id not found in equation provenance contract.',
        );
      }
    }

    const comparisonKeys = Array.isArray(profile.comparison_keys) ? profile.comparison_keys : [];
    if (comparisonKeys.length === 0) {
      addIssue(issues, `missing_comparison_keys:${workId}`, 'error', profilePath, 'comparison_keys[] is required.');
    }
    const seenComparisonIds = new Set<string>();
    for (const rawKey of comparisonKeys) {
      const key = (rawKey ?? {}) as Record<string, unknown>;
      const keyId = asText(key.id);
      const localPath = asText(key.local_reference_path);
      const externalPath = asText(key.external_path);
      const mode = asText(key.mode)?.toLowerCase();
      const tolerance = Number(key.tolerance);
      if (!keyId || !localPath || !externalPath || !mode) {
        addIssue(
          issues,
          `comparison_key_missing_fields:${workId}`,
          'error',
          profilePath,
          'comparison key requires id, local_reference_path, external_path, and mode.',
        );
        continue;
      }
      if (seenComparisonIds.has(keyId.toUpperCase())) {
        addIssue(
          issues,
          `comparison_key_duplicate:${workId}:${keyId}`,
          'error',
          profilePath,
          'comparison key id must be unique per profile.',
        );
      }
      seenComparisonIds.add(keyId.toUpperCase());
      if (!['delta', 'equals'].includes(mode)) {
        addIssue(
          issues,
          `comparison_key_mode_invalid:${workId}:${keyId}`,
          'error',
          profilePath,
          'comparison key mode must be delta or equals.',
        );
      }
      if (mode === 'delta' && key.tolerance !== undefined && !Number.isFinite(tolerance)) {
        addIssue(
          issues,
          `comparison_key_tolerance_invalid:${workId}:${keyId}`,
          'error',
          profilePath,
          'delta mode tolerance must be finite when provided.',
        );
      }
    }

    const mirrorTrack = (profile.track_mirror ?? {}) as Record<string, unknown>;
    if (typeof mirrorTrack.enabled !== 'boolean') {
      addIssue(issues, `mirror_enabled_missing:${workId}`, 'error', profilePath, 'track_mirror.enabled must be boolean.');
    } else if (mirrorTrack.enabled === true) {
      const lane = asText(mirrorTrack.lane)?.toLowerCase();
      const scenarioPack = asText(mirrorTrack.scenario_pack);
      const checkerScript = asText(mirrorTrack.checker_script);
      const requiredAnchors = Array.isArray(mirrorTrack.required_anchors)
        ? mirrorTrack.required_anchors.map(String)
        : [];
      if (!lane || !ALLOWED_MIRROR_LANES.includes(lane)) {
        addIssue(
          issues,
          `mirror_lane_invalid:${workId}`,
          'error',
          profilePath,
          `track_mirror.lane must be one of ${ALLOWED_MIRROR_LANES.join(', ')}.`,
        );
      }
      if (!scenarioPack) {
        addIssue(issues, `mirror_scenario_pack_missing:${workId}`, 'error', profilePath, 'scenario_pack is required.');
      } else {
        const scenarioResolved = resolvePathFromRoot(scenarioPack);
        if (!fs.existsSync(scenarioResolved)) {
          addIssue(
            issues,
            `mirror_scenario_pack_not_found:${workId}`,
            'error',
            scenarioPack,
            'scenario_pack path does not exist.',
          );
        } else {
          const packRefs = parseScenarioPackRefs(scenarioResolved);
          for (const anchor of requiredAnchors) {
            if (!registrySet.has(anchor.toUpperCase())) {
              addIssue(
                issues,
                `mirror_anchor_missing_registry:${workId}:${anchor}`,
                'error',
                registryPath,
                'required anchor missing in registry.',
              );
            }
            if (!packRefs.has(anchor.toUpperCase())) {
              addIssue(
                issues,
                `mirror_anchor_missing_pack:${workId}:${anchor}`,
                'error',
                scenarioPack,
                'required anchor missing in scenario pack.',
              );
            }
          }
        }
      }
      if (!checkerScript) {
        addIssue(issues, `mirror_checker_missing:${workId}`, 'error', profilePath, 'checker_script is required.');
      } else if (!fs.existsSync(resolvePathFromRoot(checkerScript))) {
        addIssue(
          issues,
          `mirror_checker_not_found:${workId}`,
          'error',
          checkerScript,
          'checker_script path does not exist.',
        );
      }
      if (requiredAnchors.length === 0) {
        addIssue(
          issues,
          `mirror_required_anchors_missing:${workId}`,
          'error',
          profilePath,
          'required_anchors[] is required when mirror track is enabled.',
        );
      }
    } else {
      const reason = asText(mirrorTrack.reason);
      if (!reason) {
        addIssue(
          issues,
          `mirror_disabled_reason_missing:${workId}`,
          'warn',
          profilePath,
          'disabled mirror track should provide a reason.',
        );
      }
    }

    const methodTrack = (profile.track_method ?? {}) as Record<string, unknown>;
    if (typeof methodTrack.enabled !== 'boolean') {
      addIssue(issues, `method_enabled_missing:${workId}`, 'error', profilePath, 'track_method.enabled must be boolean.');
    } else if (methodTrack.enabled === true) {
      const scriptPath = asText(methodTrack.script);
      const snapshots = Array.isArray(methodTrack.input_snapshots) ? methodTrack.input_snapshots.map(String) : [];
      const expectedOutputKeys = Array.isArray(methodTrack.expected_output_keys)
        ? methodTrack.expected_output_keys.map(String)
        : [];
      if (!scriptPath) {
        addIssue(issues, `method_script_missing:${workId}`, 'error', profilePath, 'method script is required.');
      } else if (!fs.existsSync(resolvePathFromRoot(scriptPath))) {
        addIssue(issues, `method_script_not_found:${workId}`, 'error', scriptPath, 'method script path does not exist.');
      }
      if (snapshots.length === 0) {
        addIssue(issues, `method_snapshots_missing:${workId}`, 'error', profilePath, 'input_snapshots[] is required.');
      } else {
        for (const snapshotPath of snapshots) {
          if (!fs.existsSync(resolvePathFromRoot(snapshotPath))) {
            addIssue(
              issues,
              `method_snapshot_not_found:${workId}`,
              'error',
              snapshotPath,
              'input snapshot does not exist.',
            );
          }
        }
      }
      if (expectedOutputKeys.length === 0) {
        addIssue(
          issues,
          `method_expected_keys_missing:${workId}`,
          'error',
          profilePath,
          'expected_output_keys[] is required when method track is enabled.',
        );
      }
    } else {
      const reason = asText(methodTrack.reason);
      if (!reason) {
        addIssue(
          issues,
          `method_disabled_reason_missing:${workId}`,
          'warn',
          profilePath,
          'disabled method track should provide a reason.',
        );
      }
    }

    const sourceClassHint = sourceRefs
      .map((ref) => citationMeta.get(ref.toUpperCase())?.source_class?.toLowerCase() ?? '')
      .filter(Boolean);
    if (sourceClassHint.length > 0 && sourceClassHint.every((klass) => klass === 'secondary')) {
      addIssue(
        issues,
        `all_secondary_sources:${profileLabel}`,
        'warn',
        citationPackPath,
        'profile references only secondary sources; strict waves should prefer primary/standard.',
      );
    }
  }

  const errorCount = issues.filter((issue) => issue.severity === 'error').length;
  const warningCount = issues.length - errorCount;
  const payload = {
    generatedOn: DATE_STAMP,
    profilePath: normalizePath(profilePath),
    pass: errorCount === 0,
    summary: {
      issueCount: issues.length,
      errorCount,
      warningCount,
      profileCount: profiles.length,
    },
    issues,
  };

  fs.mkdirSync(path.dirname(outJsonPath), { recursive: true });
  fs.mkdirSync(path.dirname(outMdPath), { recursive: true });
  fs.writeFileSync(outJsonPath, `${JSON.stringify(payload, null, 2)}\n`);
  fs.writeFileSync(
    outMdPath,
    `${renderMarkdown({
      profilePath,
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
  const result = validateExternalWorkProfiles({
    profilePath: readArgValue('--profiles') ?? DEFAULT_PROFILE_PATH,
    registryPath: readArgValue('--registry') ?? DEFAULT_REGISTRY_PATH,
    chainContractPath: readArgValue('--chains') ?? DEFAULT_CHAIN_CONTRACT_PATH,
    citationPackPath: readArgValue('--citations') ?? DEFAULT_CITATION_PACK_PATH,
    outJsonPath: readArgValue('--out') ?? DEFAULT_OUT_JSON,
    outMdPath: readArgValue('--out-md') ?? DEFAULT_OUT_MD,
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exit(1);
}
