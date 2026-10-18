import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {webcrypto,createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {runSolarExport,inspectSolarCache} from '../server/services/essence/solar-download-storage';
import {serializeObservationSnapshot,validateObservationReplay} from '../shared/solar-observation-replay';
import {solarObservationFreshness} from '../shared/solar-observation-freshness';

Object.defineProperty(globalThis,'crypto',{value:webcrypto,configurable:true});
const root=process.cwd();
const [python]=process.argv.slice(2);
if(!python || !path.isAbsolute(python))throw new Error('Usage: tsx scripts/verify-solar-live-processing.ts <absolute SunPy Python executable>');
await mkdir(path.join(root,'.tmp'),{recursive:true});
const output=await mkdtemp(path.join(root,'.tmp','solar-live-evidence-'));
const cache=await mkdtemp(path.join(os.tmpdir(),'solar-live-download-'));
process.env.SUNPY_PYTHON_BIN=python; // This verification process only, not the app's environment.
const env={...process.env,SUNPY_EXPORTER_BIN:undefined,SUNPY_CACHE_ROOT:cache};
const end=new Date(Date.now()-10*60_000).toISOString();
const start=new Date(Date.parse(end)-60*60_000).toISOString();
const script=path.join(root,'tools/hek_movie_export.py');
const base={schemaVersion:'solar-live-export-verification/1',start,end,framesRequested:1,gridSize:32,
  exporterSourceSha256:createHash('sha256').update(await readFile(script)).digest('hex'),
  sourceIdentityAuthenticated:false,scientificAdmission:false,exeAcceptance:false};
console.log(JSON.stringify({state:'started',output,window:{start,end},maxFrames:1,timeoutMs:60_000}));
try {
  const result=await runSolarExport(script,{env,timeoutMs:60_000,
    args:['--images-only','--start',start,'--end',end,'--max-frames','1','--grid-size','32']});
  if(!result.frames?.length)throw new Error(`No frame returned: ${result.meta?.frames_missing_reason ?? result.reason ?? 'unknown'}`);
  assert.equal(result.frames.length,1);
  const frame=result.frames[0];
  assert.ok(Date.parse(frame.obstime)>=Date.parse(start) && Date.parse(frame.obstime)<=Date.parse(end),'Acquisition outside requested window');
  assert.equal(frame.fits_sha256,createHash('sha256').update(await readFile(frame.fits_path)).digest('hex'));
  const snapshot=await serializeObservationSnapshot(result);
  await writeFile(path.join(output,'verified-replay.json'),snapshot,{flag:'wx'});
  const replay=await validateObservationReplay(JSON.parse(await readFile(path.join(output,'verified-replay.json'),'utf8')));
  assert.equal(await serializeObservationSnapshot(replay),snapshot);
  const report={...base,state:'passed',networkAcquisitionAttempted:true,
    acquiredAt:frame.obstime,fetchedAt:result.meta.fetched_at_utc,sourceFitsSha256:frame.fits_sha256,
    displaySha256:frame.display_sha256,archiveIdentity:replay.archive_identity,
    processing:replay.frames[0].display_normalization,
    freshness:solarObservationFreshness({acquiredAt:frame.obstime,fetchedAt:result.meta.fetched_at_utc,replay:false,nowMs:Date.now()}),
    retainedDownloadBytes:(await inspectSolarCache(env)).bytes};
  await writeFile(path.join(output,'verification-report.json'),JSON.stringify(report,null,2),{flag:'wx'});
  console.log(JSON.stringify({output,report}));
} catch(error) {
  const report={...base,state:'failed',networkAcquisitionAttempted:true,error:error instanceof Error?error.message:String(error),
    retainedDownloadBytes:(await inspectSolarCache(env)).bytes};
  await writeFile(path.join(output,'verification-report.json'),JSON.stringify(report,null,2),{flag:'wx'});
  console.log(JSON.stringify({output,report}));process.exitCode=1;
}
