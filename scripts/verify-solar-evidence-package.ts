import {mkdir,mkdtemp,readFile,stat,writeFile} from 'node:fs/promises';
import {createHash,webcrypto} from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
import {verifySolarResearchExport} from '../shared/solar-research-export';
import {prepareSolarResearchLiterature} from '../shared/solar-research-literature';
import {prepareSolarResearchEvidencePackage,verifySolarResearchEvidencePackage,SOLAR_EVIDENCE_PACKAGE_MAX_BYTES} from '../shared/solar-research-evidence-package';
import {prepareSolarResearchFigure,verifySolarResearchFigure} from '../shared/solar-research-figure';

Object.defineProperty(globalThis,'crypto',{value:webcrypto,configurable:true});
const [comparisonPath,archivePath]=process.argv.slice(2);
if(!comparisonPath || !archivePath || !path.isAbsolute(comparisonPath) || !path.isAbsolute(archivePath))
  throw new Error('Usage: tsx scripts/verify-solar-evidence-package.ts <absolute comparison export JSON> <absolute observation replay JSON>');
async function boundedRead(file:string,max:number) {
  const info=await stat(file);
  if(!info.isFile() || info.size>max)throw new Error('Input exceeds local verification bounds');
  const text=await readFile(file,'utf8');
  if(Buffer.byteLength(text)>max)throw new Error('Input exceeds local verification bounds');
  return text;
}
const comparisonText=await boundedRead(comparisonPath,256_000);
const archiveText=await boundedRead(archivePath,8_000_000);
const bundle=JSON.parse(comparisonText),archive=JSON.parse(archiveText);
const original=await verifySolarResearchExport(bundle);
const literature=await prepareSolarResearchLiterature(bundle);
const prepared=await prepareSolarResearchEvidencePackage(bundle,archive,{literature});
await mkdir(path.join(process.cwd(),'.tmp'),{recursive:true});
const output=await mkdtemp(path.join(process.cwd(),'.tmp','solar-evidence-package-'));
const packagePath=path.join(output,'portable-evidence.json');
await writeFile(packagePath,prepared.packageJson,{flag:'wx'});
const reopenedText=await boundedRead(packagePath,SOLAR_EVIDENCE_PACKAGE_MAX_BYTES);
const reopened=await verifySolarResearchEvidencePackage(reopenedText);
assert.equal(reopened.indexId,prepared.indexId);
assert.deepEqual(reopened.record,original.record);
assert.equal(reopened.manifest.observationArchive.snapshotId,archive.archive_identity.snapshotId);
const changed=JSON.parse(reopenedText);changed.comparison.tableCsv+='changed';
await assert.rejects(verifySolarResearchEvidencePackage(JSON.stringify(changed)));
const figure=await prepareSolarResearchFigure(reopened.comparison);
await writeFile(path.join(output,'paper-figure.svg'),figure.figureSvg,{flag:'wx'});
await writeFile(path.join(output,'paper-table.csv'),figure.comparisonBundle.tableCsv,{flag:'wx'});
await writeFile(path.join(output,'paper-figure-replay.json'),JSON.stringify(figure),{flag:'wx'});
const figureReopened=await verifySolarResearchFigure(JSON.parse(await boundedRead(path.join(output,'paper-figure-replay.json'),256_000)));
assert.equal(figureReopened.recordId,original.recordId);
assert.equal(await readFile(path.join(output,'paper-table.csv'),'utf8'),bundle.tableCsv);
const report={schemaVersion:'solar-evidence-package-verification/1',verifiedAt:new Date().toISOString(),
  packageSha256:createHash('sha256').update(reopenedText).digest('hex'),packageBytes:Buffer.byteLength(reopenedText),
  indexId:reopened.indexId,recordId:original.recordId,
  archiveId:reopened.manifest.observationArchive.snapshotId,literatureContextId:reopened.manifest.literatureContextId,
  rows:reopened.record.rows.length,predictionRows:reopened.record.rows.filter(row=>row.primaryPrediction!==null).length,
  residualRows:reopened.record.rows.filter(row=>row.residual!==null).length,
  diskReplayVerified:true,nestedTamperRejected:true,networkAcquisitionPerformed:false,
  figureReplayVerified:true,figureRecordId:figureReopened.recordId,
  figureSha256:createHash('sha256').update(await readFile(path.join(output,'paper-figure.svg'))).digest('hex'),
  quantitativeJoinAllowed:false,sourceIdentityAuthenticated:false,scientificAdmission:false,
  scienceRunAllowed:false,originalFitsIncluded:false,browserDemoVerified:false,exeAcceptance:false};
await writeFile(path.join(output,'verification-report.json'),JSON.stringify(report,null,2),{flag:'wx'});
console.log(JSON.stringify({output,report}));
