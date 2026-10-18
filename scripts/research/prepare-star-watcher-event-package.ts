import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { loadLocalPrimaryObservation } from '../../server/services/solar-research/primary-observation';
import { prepareSolarResearchExport } from '../../shared/solar-research-export';
import { prepareSolarResearchLiterature } from '../../shared/solar-research-literature';
import { prepareSolarResearchEvidencePackage, verifySolarResearchEvidencePackage } from '../../shared/solar-research-evidence-package';
import { validateObservationReplay } from '../../shared/solar-observation-replay';

const [archivePath, outputPath, recordCreatedAt, expectedRecordId] = process.argv.slice(2);
if (!archivePath || !outputPath || !recordCreatedAt || !expectedRecordId)
  throw new Error('Usage: tsx scripts/research/prepare-star-watcher-event-package.ts ARCHIVE_JSON OUTPUT_JSON RECORD_CREATED_AT EXPECTED_RECORD_ID');
if (!/^solar-primary:[a-f0-9]{64}$/.test(expectedRecordId) || !Number.isFinite(Date.parse(recordCreatedAt)))
  throw new Error('A bounded expected record ID and creation time are required');

const record = await loadLocalPrimaryObservation(process.cwd(), recordCreatedAt);
const comparison = await prepareSolarResearchExport(record);
if (comparison.recordId !== expectedRecordId) throw new Error('Local observation is not the exact retained comparison record');
const archive = await validateObservationReplay(JSON.parse(await readFile(archivePath, 'utf8')));
if (!archive.selected_event_context) throw new Error('An event/frame selection is required');
const literature = await prepareSolarResearchLiterature(comparison);
const { packageJson, indexId } = await prepareSolarResearchEvidencePackage(comparison, archive, { literature });
const verified = await verifySolarResearchEvidencePackage(packageJson);
if (verified.indexId !== indexId || verified.manifest.comparison.recordId !== expectedRecordId ||
    verified.archiveReplay?.archive_identity?.snapshotId !== archive.archive_identity?.snapshotId)
  throw new Error('Portable package identity mismatch');

await writeFile(outputPath, packageJson, { flag: 'wx' });
const packageId = `solar-package:${createHash('sha256').update(packageJson).digest('hex')}`;
process.stdout.write(JSON.stringify({
  packageId, indexId, comparisonRecordId: expectedRecordId,
  imageArchiveId: archive.archive_identity?.snapshotId,
  selectedEventId: archive.selected_event_context.eventId,
  comparisonRows: verified.record.rows.length, bytes: Buffer.byteLength(packageJson),
  sourceIdentityAuthenticated: false, scientificAdmission: false,
  quantitativeJoinAllowed: false, originalFitsIncluded: false,
}, null, 2) + '\n');
