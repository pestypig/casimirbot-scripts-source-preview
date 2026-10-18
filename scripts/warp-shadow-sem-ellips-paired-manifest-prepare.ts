import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const DATE_STAMP = new Date().toISOString().slice(0, 10);
const DEFAULT_MANIFEST_PATH = path.join(
  'artifacts',
  'research',
  'full-solve',
  'se-paired-runs',
  DATE_STAMP,
  'pairing-manifest.json',
);
const DEFAULT_DATA_ORIGIN = 'instrument_export';

type ManifestPayload = {
  pairedRunId?: string;
  sourceClass?: string;
  sourceRefs?: string[];
  provenance?: {
    data_origin?: string;
    instrument_run_ids?: string[];
    raw_artifact_refs?: string[];
    raw_artifact_sha256?: Record<string, string>;
    operator_id?: string | null;
    acquisition_date_utc?: string | null;
  };
  semDefaults?: Record<string, unknown>;
  uncertainty?: Record<string, unknown>;
};

const readArgValue = (name: string, argv = process.argv.slice(2)): string | undefined => {
  const index = argv.findIndex((value) => value === name || value.startsWith(`${name}=`));
  if (index < 0) return undefined;
  if (argv[index].includes('=')) return argv[index].split('=', 2)[1];
  return argv[index + 1];
};

const parseBoolArg = (name: string, argv = process.argv.slice(2)): boolean => {
  const value = readArgValue(name, argv);
  if (value == null) return false;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
};

const parseList = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

const normalizeRef = (value: string): string => value.replace(/\\/g, '/').trim();

const unique = <T>(values: T[]): T[] => [...new Set(values)];

const sha256File = (filePath: string): string => {
  const digest = crypto.createHash('sha256');
  digest.update(fs.readFileSync(filePath));
  return digest.digest('hex');
};

export const prepareSemEllipsPairingManifest = (options: {
  manifestPath?: string;
  outPath?: string;
  pairedRunId?: string;
  runIds?: string;
  dataOrigin?: string;
  rawRefs?: string;
  operatorId?: string;
  acquisitionDateUtc?: string;
  mergeRunIds?: boolean;
  allowNonInstrumentOrigin?: boolean;
}) => {
  const manifestPath = options.manifestPath ?? DEFAULT_MANIFEST_PATH;
  const outPath = options.outPath ?? manifestPath;

  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Manifest file not found: ${manifestPath}`);
  }

  const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as ManifestPayload;
  const currentProvenance = parsed.provenance ?? {};

  const dataOrigin = String(options.dataOrigin ?? DEFAULT_DATA_ORIGIN).trim().toLowerCase();
  if (dataOrigin !== 'instrument_export' && !options.allowNonInstrumentOrigin) {
    throw new Error(
      'data_origin must be instrument_export unless --allow-non-instrument-origin=true is supplied.',
    );
  }

  const requestedRunIds = parseList(options.runIds);
  const existingRunIds = (currentProvenance.instrument_run_ids ?? [])
    .map((value) => String(value).trim())
    .filter((value) => value.length > 0);
  const instrumentRunIds = options.mergeRunIds
    ? unique([...existingRunIds, ...requestedRunIds]).sort((a, b) => a.localeCompare(b))
    : requestedRunIds;
  if (instrumentRunIds.length === 0) {
    throw new Error(
      'At least one run id is required. Use --run-ids <id1,id2,...> or --merge-run-ids=true with existing run ids.',
    );
  }

  const requestedRawRefs = parseList(options.rawRefs).map(normalizeRef);
  const existingRawRefs = (currentProvenance.raw_artifact_refs ?? []).map((value) =>
    normalizeRef(String(value)),
  );
  const rawArtifactRefs = unique([...existingRawRefs, ...requestedRawRefs]).sort((a, b) =>
    a.localeCompare(b),
  );

  const existingHashes = Object.entries(currentProvenance.raw_artifact_sha256 ?? {}).map(
    ([rawRef, hash]) => [normalizeRef(rawRef), String(hash).trim().toLowerCase()] as const,
  );
  const rawArtifactSha256: Record<string, string> = Object.fromEntries(
    existingHashes.filter(([rawRef]) => rawRef.length > 0),
  );

  const unresolvedRawRefs: string[] = [];
  for (const rawRef of rawArtifactRefs) {
    if (rawArtifactSha256[rawRef]) continue;
    const localPath = path.resolve(rawRef);
    if (fs.existsSync(localPath)) {
      rawArtifactSha256[rawRef] = sha256File(localPath);
      continue;
    }
    unresolvedRawRefs.push(rawRef);
  }

  const nextPayload: ManifestPayload = {
    ...parsed,
    pairedRunId: options.pairedRunId?.trim() || parsed.pairedRunId,
    provenance: {
      ...currentProvenance,
      data_origin: dataOrigin,
      instrument_run_ids: instrumentRunIds,
      raw_artifact_refs: rawArtifactRefs,
      raw_artifact_sha256: rawArtifactSha256,
      operator_id:
        options.operatorId !== undefined ? options.operatorId.trim() || null : currentProvenance.operator_id ?? null,
      acquisition_date_utc:
        options.acquisitionDateUtc !== undefined
          ? options.acquisitionDateUtc.trim() || null
          : currentProvenance.acquisition_date_utc ?? null,
    },
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(nextPayload, null, 2)}\n`);

  return {
    ok: true,
    manifestPath,
    outPath,
    pairedRunId: nextPayload.pairedRunId ?? null,
    dataOrigin,
    instrumentRunIdCount: instrumentRunIds.length,
    rawArtifactRefCount: rawArtifactRefs.length,
    rawArtifactHashCount: Object.keys(rawArtifactSha256).length,
    unresolvedRawRefCount: unresolvedRawRefs.length,
    unresolvedRawRefs,
  };
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const result = prepareSemEllipsPairingManifest({
    manifestPath: readArgValue('--manifest', argv) ?? DEFAULT_MANIFEST_PATH,
    outPath: readArgValue('--out', argv),
    pairedRunId: readArgValue('--paired-run-id', argv),
    runIds: readArgValue('--run-ids', argv),
    dataOrigin: readArgValue('--data-origin', argv) ?? DEFAULT_DATA_ORIGIN,
    rawRefs: readArgValue('--raw-refs', argv),
    operatorId: readArgValue('--operator-id', argv),
    acquisitionDateUtc: readArgValue('--acquisition-date-utc', argv),
    mergeRunIds: parseBoolArg('--merge-run-ids', argv),
    allowNonInstrumentOrigin: parseBoolArg('--allow-non-instrument-origin', argv),
  });
  console.log(JSON.stringify(result, null, 2));
}
