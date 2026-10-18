import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {createHash,webcrypto} from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
import {runPythonScript} from '../server/utils/run-python';
import {serializeObservationSnapshot,validateObservationReplay} from '../shared/solar-observation-replay';
import {solarObservationFreshness} from '../shared/solar-observation-freshness';

Object.defineProperty(globalThis,'crypto',{value:webcrypto,configurable:true});
const root=process.cwd();
const [source,python]=process.argv.slice(2);
if(!source || !python || !path.isAbsolute(source) || !path.isAbsolute(python))
  throw new Error('Usage: tsx scripts/verify-solar-cached-processing.ts <absolute cached AIA 193 FITS> <absolute SunPy Python executable>');
await mkdir(path.join(root,'.tmp'),{recursive:true});
const output=await mkdtemp(path.join(root,'.tmp','solar-cached-processing-'));
const result=await runPythonScript(path.join(root,'tools/tests/verify_cached_solar_export.py'),{
  args:[source,output],pythonBin:python,timeoutMs:60_000});
assert.equal(result.frames.length,1);
const frame=result.frames[0];
assert.equal(frame.fits_sha256,createHash('sha256').update(await readFile(source)).digest('hex'));
assert.equal(frame.display_normalization.radiometricCalibrationApplied,false);
// main() timestamps its export, but this verification bypasses acquisition.
// Do not mislabel the processing timestamp as a new network retrieval.
const processingCompletedAt=result.meta.fetched_at_utc;
result.meta.fetched_at_utc=null;
result.meta.source='offline_cached_fits_verification';
const snapshot=await serializeObservationSnapshot(result);
await writeFile(path.join(output,'verified-replay.json'),snapshot,{flag:'wx'});
const replay=await validateObservationReplay(JSON.parse(await readFile(path.join(output,'verified-replay.json'),'utf8')));
assert.deepEqual(replay.frames[0].display_normalization,frame.display_normalization);
assert.equal(await serializeObservationSnapshot(replay),snapshot);
const altered=JSON.parse(snapshot);altered.frames[0].display_normalization.scale+=1;
await assert.rejects(validateObservationReplay(altered),/archive identity/);
const report={schemaVersion:'solar-cached-processing-verification/1',sourceFitsSha256:frame.fits_sha256,
  exporterSourceSha256:createHash('sha256').update(await readFile(path.join(root,'tools/hek_movie_export.py'))).digest('hex'),
  displaySha256:frame.display_sha256,archiveIdentity:replay.archive_identity,
  acquiredAt:frame.obstime,fetchedAt:null,processingCompletedAt,
  processing:replay.frames[0].display_normalization,frames:1,gridSize:32,
  freshness:solarObservationFreshness({acquiredAt:frame.obstime,fetchedAt:result.meta.fetched_at_utc,replay:true,nowMs:Date.now()}),
  acquisitionSubstitution:'exact_cached_fits_no_network_fetch',liveDownloadVerified:false,
  sourceIdentityAuthenticated:false,scientificAdmission:false,exeAcceptance:false};
await writeFile(path.join(output,'verification-report.json'),JSON.stringify(report,null,2),{flag:'wx'});
console.log(JSON.stringify({output,report}));
