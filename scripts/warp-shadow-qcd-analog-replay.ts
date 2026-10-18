import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const DATE_STAMP = new Date().toISOString().slice(0, 10);
const DEFAULT_RECORD_PATH = path.join('docs', 'specs', 'data', 'qcd-hepdata-record-159491.v1.json');
const DEFAULT_TABLE_SHORT_PATH = path.join('docs', 'specs', 'data', 'qcd-hepdata-table-159491-t3.v1.json');
const DEFAULT_TABLE_LONG_PATH = path.join('docs', 'specs', 'data', 'qcd-hepdata-table-159491-t4.v1.json');
const DEFAULT_TABLE_DR_PATH = path.join('docs', 'specs', 'data', 'qcd-hepdata-table-159491-t5.v1.json');
const DEFAULT_REGISTRY_PATH = path.join('docs', 'specs', 'casimir-tile-experimental-parameter-registry-2026-03-04.md');
const DEFAULT_OUT_JSON = path.join('artifacts', 'research', 'full-solve', `qcd-analog-replay-${DATE_STAMP}.json`);
const DEFAULT_OUT_MD = path.join('docs', 'audits', 'research', `warp-qcd-analog-replay-${DATE_STAMP}.md`);
const DEFAULT_RECORD_URL = 'https://www.hepdata.net/record/159491?format=json';
const DEFAULT_TABLE_SHORT_URL = 'https://www.hepdata.net/record/data/159491/1839022/1/?format=json';
const DEFAULT_TABLE_LONG_URL = 'https://www.hepdata.net/record/data/159491/1839023/1/?format=json';
const DEFAULT_TABLE_DR_URL = 'https://www.hepdata.net/record/data/159491/1839024/1/?format=json';
const BOUNDARY_STATEMENT =
  'This campaign defines falsifiable reduced-order full-solve gates and reproducible evidence requirements; it is not a physical warp feasibility claim.';

type HEPDataError = {
  label?: string;
  symerror?: string | number;
};

type HEPDataTableRow = {
  x?: Array<{ value?: string | number; low?: string | number; high?: string | number }>;
  y?: Array<{ value?: string | number; errors?: HEPDataError[] }>;
};

type HEPDataTable = {
  doi?: string;
  values?: HEPDataTableRow[];
  qualifiers?: Record<string, Array<{ value?: string }>>;
  location?: string;
  name?: string;
};

type HEPDataRecord = {
  data_tables?: Array<{
    id?: number;
    name?: string;
    doi?: string;
    data?: {
      json?: string;
      csv?: string;
    };
  }>;
  record?: {
    doi?: string;
    hepdata_doi?: string;
    publication_date?: string;
    title?: string;
    abstract?: string;
    data_keywords?: {
      cmenergies?: Array<{
        gte?: number;
        lte?: number;
      }>;
      reactions?: string[];
    };
  };
};

const readArgValue = (name: string, argv = process.argv.slice(2)): string | undefined => {
  const index = argv.findIndex((value) => value === name || value.startsWith(`${name}=`));
  if (index < 0) return undefined;
  if (argv[index].includes('=')) return argv[index].split('=', 2)[1];
  return argv[index + 1];
};

const hasFlag = (flag: string, argv = process.argv.slice(2)): boolean => argv.includes(flag);

const parseFinite = (value: unknown): number | null => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const parseErrorByLabel = (errors: HEPDataError[] | undefined, labelToken: string): number | null => {
  if (!Array.isArray(errors)) return null;
  const match = errors.find((entry) => String(entry.label ?? '').toLowerCase().includes(labelToken));
  return match ? parseFinite(match.symerror) : null;
};

const parseRegistryRows = (markdown: string): Array<{ entryId: string; value: string }> => {
  const rows: Array<{ entryId: string; value: string }> = [];
  for (const line of markdown.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('| EXP-QCD-')) continue;
    const cells = trimmed
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length < 4) continue;
    rows.push({ entryId: cells[0], value: cells[3] });
  }
  return rows;
};

const parseNumericLoose = (value: string): number | null => {
  const cleaned = String(value).replace(/[^0-9.+-]/g, '');
  if (!cleaned) return null;
  return parseFinite(cleaned);
};

const ensureDir = (filePath: string) => fs.mkdirSync(path.dirname(filePath), { recursive: true });

const writeJson = (filePath: string, payload: unknown) => {
  ensureDir(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`);
};

const writeMarkdown = (filePath: string, body: string) => {
  ensureDir(filePath);
  fs.writeFileSync(filePath, body);
};

const fetchJson = async (url: string): Promise<unknown> => {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`Failed fetch: ${url} (${response.status})`);
  }
  return response.json();
};

const extractFromAbstract = (text: string | undefined): {
  eventCountMillions: number | null;
  beamSpeedPctC: number | null;
  pPercentAbstract: number | null;
  pPercentAbstractUnc: number | null;
} => {
  const abstract = String(text ?? '');
  const eventMatch = abstract.match(/([0-9]+)\s*million/i);
  const speedMatch = abstract.match(/([0-9]+(?:\.[0-9]+)?)\s*%\s*c/i);
  const percentMatch = abstract.match(/\(([0-9]+(?:\.[0-9]+)?)\s*\\pm\s*([0-9]+(?:\.[0-9]+)?)\)\\%/i);
  return {
    eventCountMillions: eventMatch ? parseFinite(eventMatch[1]) : null,
    beamSpeedPctC: speedMatch ? parseFinite(speedMatch[1]) : null,
    pPercentAbstract: percentMatch ? parseFinite(percentMatch[1]) : null,
    pPercentAbstractUnc: percentMatch ? parseFinite(percentMatch[2]) : null,
  };
};

const getHeadCommit = (): string | null => {
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
};

const toFixed = (value: number, digits = 6): number => Number(value.toFixed(digits));

const parsePoint = (row: HEPDataTableRow | null) => {
  const p = parseFinite(row?.y?.[0]?.value);
  const stat = parseErrorByLabel(row?.y?.[0]?.errors, 'stat');
  const sys = parseErrorByLabel(row?.y?.[0]?.errors, 'sys');
  const sigma = stat != null && sys != null ? Math.sqrt(Math.max(0, stat * stat + sys * sys)) : null;
  const z = p != null && sigma != null && sigma > 0 ? Math.abs(p) / sigma : null;
  return { p, stat, sys, sigma, z };
};

const findRowByDiscreteX = (table: HEPDataTable, xTarget: string): HEPDataTableRow | null => {
  return table.values?.find((row) => String(row.x?.[0]?.value ?? '').trim() === xTarget) ?? null;
};

const parseDrRows = (table: HEPDataTable) => {
  const rows = Array.isArray(table.values) ? table.values : [];
  return rows.map((row, index) => {
    const low = parseFinite(row.x?.[0]?.low);
    const high = parseFinite(row.x?.[0]?.high);
    const point = parsePoint(row);
    return {
      index,
      low,
      high,
      ...point,
    };
  });
};

const meanAbs = (values: number[]): number | null => {
  if (values.length === 0) return null;
  return values.reduce((acc, cur) => acc + Math.abs(cur), 0) / values.length;
};

const renderMarkdown = (payload: any): string => {
  const checksRows = Object.entries(payload.replay.checks as Record<string, boolean>)
    .map(([key, value]) => `| ${key} | ${value ? 'PASS' : 'FAIL'} |`)
    .join('\n');
  const blockers = (payload.replay.blockers as string[]).length
    ? (payload.replay.blockers as string[]).map((b) => `- ${b}`).join('\n')
    : '- none';

  return `# QCD Analog Replay (${payload.generatedOn})

"${payload.boundaryStatement}"

## Scope
- lane: \`${payload.lane}\`
- chain_id: \`${payload.chainId}\`
- posture: \`${payload.dependencyMode}\`

## Inputs
- record_snapshot: \`${payload.inputs.recordPath}\`
- table_short_snapshot: \`${payload.inputs.tableShortPath}\`
- table_long_snapshot: \`${payload.inputs.tableLongPath}\`
- table_dr_snapshot: \`${payload.inputs.tableDrPath}\`
- source_ids: \`SRC-069\`, \`SRC-070\`

## Extracted Anchors
| field | value |
|---|---:|
| cm_energy_gev | ${payload.extracts.cmEnergyGeV ?? 'UNKNOWN'} |
| event_count_millions | ${payload.extracts.eventCountMillions ?? 'UNKNOWN'} |
| beam_speed_pct_c | ${payload.extracts.beamSpeedPctC ?? 'UNKNOWN'} |
| p_rel_short_range | ${payload.extracts.shortRange.pValue ?? 'UNKNOWN'} |
| p_rel_short_stat | ${payload.extracts.shortRange.statUnc ?? 'UNKNOWN'} |
| p_rel_short_sys | ${payload.extracts.shortRange.sysUnc ?? 'UNKNOWN'} |
| p_rel_long_range | ${payload.extracts.longRange.pValue ?? 'UNKNOWN'} |
| p_rel_long_stat | ${payload.extracts.longRange.statUnc ?? 'UNKNOWN'} |
| p_rel_long_sys | ${payload.extracts.longRange.sysUnc ?? 'UNKNOWN'} |
| dr_row_count | ${payload.extracts.drBinCount ?? 'UNKNOWN'} |

## Replay Equation
\`z = |P| / sqrt(sigma_stat^2 + sigma_sys^2)\`

## Replay Results
| metric | value |
|---|---:|
| sigma_combined_short | ${payload.replay.derived.shortSigmaCombined ?? 'UNKNOWN'} |
| z_score_short | ${payload.replay.derived.shortZScore ?? 'UNKNOWN'} |
| sigma_combined_long | ${payload.replay.derived.longSigmaCombined ?? 'UNKNOWN'} |
| z_score_long | ${payload.replay.derived.longZScore ?? 'UNKNOWN'} |
| z_target | ${payload.replay.targets.zExpected} |
| z_abs_diff_short | ${payload.replay.residuals.shortZAbsDiff ?? 'UNKNOWN'} |
| abs_p_short_minus_long | ${payload.replay.derived.absPContrast ?? 'UNKNOWN'} |
| dr_mean_abs_near | ${payload.replay.derived.drMeanAbsNear ?? 'UNKNOWN'} |
| dr_mean_abs_far | ${payload.replay.derived.drMeanAbsFar ?? 'UNKNOWN'} |
| dr_near_far_ratio | ${payload.replay.derived.drNearFarRatio ?? 'UNKNOWN'} |
| status | ${payload.replay.status} |
| recompute_ready | ${payload.replay.recomputeReady} |

## Deterministic Checks
| check | status |
|---|---|
${checksRows}

## Blockers
${blockers}
`;
};

export const runQcdAnalogReplay = async (options: {
  recordPath?: string;
  tableShortPath?: string;
  tableLongPath?: string;
  tableDrPath?: string;
  registryPath?: string;
  outJsonPath?: string;
  outMdPath?: string;
  fetchLive?: boolean;
  recordUrl?: string;
  tableShortUrl?: string;
  tableLongUrl?: string;
  tableDrUrl?: string;
} = {}) => {
  const recordPath = options.recordPath ?? DEFAULT_RECORD_PATH;
  const tableShortPath = options.tableShortPath ?? DEFAULT_TABLE_SHORT_PATH;
  const tableLongPath = options.tableLongPath ?? DEFAULT_TABLE_LONG_PATH;
  const tableDrPath = options.tableDrPath ?? DEFAULT_TABLE_DR_PATH;
  const registryPath = options.registryPath ?? DEFAULT_REGISTRY_PATH;
  const outJsonPath = options.outJsonPath ?? DEFAULT_OUT_JSON;
  const outMdPath = options.outMdPath ?? DEFAULT_OUT_MD;
  const recordUrl = options.recordUrl ?? DEFAULT_RECORD_URL;
  const tableShortUrl = options.tableShortUrl ?? DEFAULT_TABLE_SHORT_URL;
  const tableLongUrl = options.tableLongUrl ?? DEFAULT_TABLE_LONG_URL;
  const tableDrUrl = options.tableDrUrl ?? DEFAULT_TABLE_DR_URL;

  if (options.fetchLive) {
    const [recordLive, tableShortLive, tableLongLive, tableDrLive] = await Promise.all([
      fetchJson(recordUrl),
      fetchJson(tableShortUrl),
      fetchJson(tableLongUrl),
      fetchJson(tableDrUrl),
    ]);
    writeJson(recordPath, recordLive);
    writeJson(tableShortPath, tableShortLive);
    writeJson(tableLongPath, tableLongLive);
    writeJson(tableDrPath, tableDrLive);
  }

  if (!fs.existsSync(recordPath)) throw new Error(`Missing record snapshot: ${recordPath}`);
  if (!fs.existsSync(tableShortPath)) throw new Error(`Missing short-range table snapshot: ${tableShortPath}`);
  if (!fs.existsSync(tableLongPath)) throw new Error(`Missing long-range table snapshot: ${tableLongPath}`);
  if (!fs.existsSync(tableDrPath)) throw new Error(`Missing delta-R table snapshot: ${tableDrPath}`);

  const record = JSON.parse(fs.readFileSync(recordPath, 'utf8')) as HEPDataRecord;
  const tableShort = JSON.parse(fs.readFileSync(tableShortPath, 'utf8')) as HEPDataTable;
  const tableLong = JSON.parse(fs.readFileSync(tableLongPath, 'utf8')) as HEPDataTable;
  const tableDr = JSON.parse(fs.readFileSync(tableDrPath, 'utf8')) as HEPDataTable;
  const registryRows = fs.existsSync(registryPath)
    ? parseRegistryRows(fs.readFileSync(registryPath, 'utf8'))
    : [];
  const registryEventCount = parseNumericLoose(
    registryRows.find((row) => row.entryId === 'EXP-QCD-002')?.value ?? '',
  );
  const registryBeamSpeed = parseNumericLoose(
    registryRows.find((row) => row.entryId === 'EXP-QCD-003')?.value ?? '',
  );

  const cmEnergyGeV = parseFinite(record.record?.data_keywords?.cmenergies?.[0]?.gte);
  const abstractExtract = extractFromAbstract(record.record?.abstract);
  const shortRow = findRowByDiscreteX(tableShort, '1') ?? tableShort.values?.[0] ?? null;
  const longRow = findRowByDiscreteX(tableLong, '1') ?? tableLong.values?.[0] ?? null;
  const shortPoint = parsePoint(shortRow);
  const longPoint = parsePoint(longRow);

  const drRows = parseDrRows(tableDr);
  const drNearRows = drRows.filter((row) => row.high != null && row.high <= 1.0 && row.p != null);
  const drFarRows = drRows.filter((row) => row.low != null && row.low >= 1.5 && row.p != null);
  const drMeanAbsNear = meanAbs(drNearRows.map((row) => row.p as number));
  const drMeanAbsFar = meanAbs(drFarRows.map((row) => row.p as number));
  const drNearFarRatio =
    drMeanAbsNear != null && drMeanAbsFar != null && drMeanAbsFar > 0 ? drMeanAbsNear / drMeanAbsFar : null;

  const drPeakAbs = drRows
    .filter((row) => row.p != null)
    .reduce((best, row) => {
      if (!best || Math.abs((row.p as number)) > Math.abs(best.p as number)) return row;
      return best;
    }, null as (typeof drRows)[number] | null);

  const zExpected = 4.4;
  const shortZAbsDiff = shortPoint.z != null ? Math.abs(shortPoint.z - zExpected) : null;
  const absPContrast =
    shortPoint.p != null && longPoint.p != null ? Math.abs(shortPoint.p) - Math.abs(longPoint.p) : null;

  const checks = {
    recordDoiPresent: String(record.record?.doi ?? '').length > 0,
    hepdataDoiPresent: String(record.record?.hepdata_doi ?? '').length > 0,
    shortTableDoiPresent: String(tableShort.doi ?? '').length > 0,
    longTableDoiPresent: String(tableLong.doi ?? '').length > 0,
    drTableDoiPresent: String(tableDr.doi ?? '').length > 0,
    shortRangeRowPresent: shortRow != null,
    longRangeRowPresent: longRow != null,
    shortStatUncertaintyPresent: shortPoint.stat != null,
    shortSysUncertaintyPresent: shortPoint.sys != null,
    longStatUncertaintyPresent: longPoint.stat != null,
    longSysUncertaintyPresent: longPoint.sys != null,
    shortZComputable: shortPoint.z != null,
    longZComputable: longPoint.z != null,
    shortZParityWithinTolerance: shortZAbsDiff != null && shortZAbsDiff <= 0.05,
    longRangeConsistentWithZero: longPoint.z != null && longPoint.z <= 2.0,
    shortLongContrastPresent: absPContrast != null && absPContrast > 0,
    drRowsPresent: drRows.length > 0,
    drNearFarTrendPresent: drMeanAbsNear != null && drMeanAbsFar != null && drMeanAbsNear > drMeanAbsFar,
    drPeakAtOrBelowOne: drPeakAbs != null && drPeakAbs.high != null && drPeakAbs.high <= 1.0,
  };

  const blockers: string[] = [];
  if (!checks.shortRangeRowPresent) blockers.push('missing_short_range_table_row');
  if (!checks.longRangeRowPresent) blockers.push('missing_long_range_table_row');
  if (!checks.shortStatUncertaintyPresent) blockers.push('missing_short_stat_uncertainty');
  if (!checks.shortSysUncertaintyPresent) blockers.push('missing_short_sys_uncertainty');
  if (!checks.longStatUncertaintyPresent) blockers.push('missing_long_stat_uncertainty');
  if (!checks.longSysUncertaintyPresent) blockers.push('missing_long_sys_uncertainty');
  if (!checks.shortZComputable) blockers.push('unable_to_compute_short_significance');
  if (!checks.longZComputable) blockers.push('unable_to_compute_long_significance');
  if (checks.shortZComputable && !checks.shortZParityWithinTolerance) blockers.push('short_z_score_not_within_tolerance');
  if (checks.longZComputable && !checks.longRangeConsistentWithZero) blockers.push('long_range_not_consistent_with_zero');
  if (!checks.shortLongContrastPresent) blockers.push('short_long_contrast_not_observed');
  if (!checks.drRowsPresent) blockers.push('missing_delta_r_table_rows');
  if (checks.drRowsPresent && !checks.drNearFarTrendPresent) blockers.push('delta_r_decoherence_trend_not_observed');
  if (checks.drRowsPresent && !checks.drPeakAtOrBelowOne) blockers.push('delta_r_peak_not_in_short_range');

  const payload = {
    generatedOn: DATE_STAMP,
    generatedAt: new Date().toISOString(),
    boundaryStatement: BOUNDARY_STATEMENT,
    lane: 'qcd_analog',
    chainId: 'CH-QCD-001',
    dependencyMode: 'reference_only',
    canonicalBlocking: false,
    sourceIds: ['SRC-069', 'SRC-070'],
    inputs: {
      recordPath,
      tableShortPath,
      tableLongPath,
      tableDrPath,
      recordUrl,
      tableShortUrl,
      tableLongUrl,
      tableDrUrl,
    },
    extracts: {
      cmEnergyGeV,
      eventCountMillions: abstractExtract.eventCountMillions ?? (registryEventCount != null ? registryEventCount / 1e6 : null),
      beamSpeedPctC: abstractExtract.beamSpeedPctC ?? registryBeamSpeed,
      shortRange: {
        pValue: shortPoint.p,
        statUnc: shortPoint.stat,
        sysUnc: shortPoint.sys,
      },
      longRange: {
        pValue: longPoint.p,
        statUnc: longPoint.stat,
        sysUnc: longPoint.sys,
      },
      drBinCount: drRows.length,
      pPercentAbstract: abstractExtract.pPercentAbstract,
      pPercentAbstractUnc: abstractExtract.pPercentAbstractUnc,
      publicationDoi: record.record?.doi ?? null,
      hepdataDoi: record.record?.hepdata_doi ?? null,
      tableShortDoi: tableShort.doi ?? null,
      tableLongDoi: tableLong.doi ?? null,
      tableDrDoi: tableDr.doi ?? null,
      recordTitle: record.record?.title ?? null,
      publicationDate: record.record?.publication_date ?? null,
    },
    replay: {
      equation:
        'z = |P| / sqrt(sigma_stat^2 + sigma_sys^2); contrast = |P_short| - |P_long|; dr_near_far_ratio = mean(|P|_near)/mean(|P|_far)',
      targets: {
        shortPExpected: 0.181,
        shortStatExpected: 0.035,
        shortSysExpected: 0.022,
        longPExpected: 0.020,
        longStatExpected: 0.023,
        longSysExpected: 0.022,
        zExpected,
      },
      derived: {
        shortSigmaCombined: shortPoint.sigma != null ? toFixed(shortPoint.sigma, 6) : null,
        shortZScore: shortPoint.z != null ? toFixed(shortPoint.z, 6) : null,
        shortPPercent: shortPoint.p != null ? toFixed(shortPoint.p * 100, 3) : null,
        longSigmaCombined: longPoint.sigma != null ? toFixed(longPoint.sigma, 6) : null,
        longZScore: longPoint.z != null ? toFixed(longPoint.z, 6) : null,
        longPPercent: longPoint.p != null ? toFixed(longPoint.p * 100, 3) : null,
        absPContrast: absPContrast != null ? toFixed(absPContrast, 6) : null,
        drMeanAbsNear: drMeanAbsNear != null ? toFixed(drMeanAbsNear, 6) : null,
        drMeanAbsFar: drMeanAbsFar != null ? toFixed(drMeanAbsFar, 6) : null,
        drNearFarRatio: drNearFarRatio != null ? toFixed(drNearFarRatio, 6) : null,
        drPeakAbsP: drPeakAbs?.p != null ? toFixed(Math.abs(drPeakAbs.p), 6) : null,
        drPeakRangeLow: drPeakAbs?.low ?? null,
        drPeakRangeHigh: drPeakAbs?.high ?? null,
      },
      residuals: {
        shortPAbsDiff: shortPoint.p != null ? toFixed(Math.abs(shortPoint.p - 0.181), 9) : null,
        shortStatAbsDiff: shortPoint.stat != null ? toFixed(Math.abs(shortPoint.stat - 0.035), 9) : null,
        shortSysAbsDiff: shortPoint.sys != null ? toFixed(Math.abs(shortPoint.sys - 0.022), 9) : null,
        shortZAbsDiff: shortZAbsDiff != null ? toFixed(shortZAbsDiff, 6) : null,
        longPAbsDiff: longPoint.p != null ? toFixed(Math.abs(longPoint.p - 0.020), 9) : null,
        longStatAbsDiff: longPoint.stat != null ? toFixed(Math.abs(longPoint.stat - 0.023), 9) : null,
        longSysAbsDiff: longPoint.sys != null ? toFixed(Math.abs(longPoint.sys - 0.022), 9) : null,
      },
      drRows: drRows.map((row) => ({
        low: row.low,
        high: row.high,
        p: row.p,
        stat: row.stat,
        sys: row.sys,
        sigma: row.sigma != null ? toFixed(row.sigma, 6) : null,
        z: row.z != null ? toFixed(row.z, 6) : null,
      })),
      checks,
      blockers,
      recomputeReady: blockers.length === 0 ? 'partial' : 'blocked',
      status: blockers.length === 0 ? 'pass_partial' : 'blocked_partial',
      note: 'Replay is table-level (t3+t4+t5) and exploratory; full event-level reconstruction remains out of scope for this wave.',
    },
    provenance: {
      commitHash: getHeadCommit(),
    },
  };

  writeJson(outJsonPath, payload);
  writeMarkdown(outMdPath, renderMarkdown(payload));
  return payload;
};

const isEntryPoint = (() => {
  if (!process.argv[1]) return false;
  try {
    return pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
})();

if (isEntryPoint) {
  const recordPath = readArgValue('--record');
  const tableShortPath = readArgValue('--table-short') ?? readArgValue('--table');
  const tableLongPath = readArgValue('--table-long');
  const tableDrPath = readArgValue('--table-dr');
  const registryPath = readArgValue('--registry');
  const outJsonPath = readArgValue('--out-json');
  const outMdPath = readArgValue('--out-md');
  const recordUrl = readArgValue('--record-url');
  const tableShortUrl = readArgValue('--table-short-url') ?? readArgValue('--table-url');
  const tableLongUrl = readArgValue('--table-long-url');
  const tableDrUrl = readArgValue('--table-dr-url');
  const fetchLive = hasFlag('--fetch-live');

  runQcdAnalogReplay({
    recordPath,
    tableShortPath,
    tableLongPath,
    tableDrPath,
    registryPath,
    outJsonPath,
    outMdPath,
    fetchLive,
    recordUrl,
    tableShortUrl,
    tableLongUrl,
    tableDrUrl,
  })
    .then((payload) => {
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    })
    .catch((error) => {
      process.stderr.write(`${String(error instanceof Error ? error.message : error)}\n`);
      process.exitCode = 1;
    });
}
