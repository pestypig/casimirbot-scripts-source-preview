import { mkdtemp, mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { loadLocalPrimaryObservation } from '../server/services/solar-research/primary-observation';
import { prepareSolarResearchExport, verifySolarResearchExport } from '../shared/solar-research-export';
import { prepareSolarResearchFigure, verifySolarResearchFigure } from '../shared/solar-research-figure';

async function main() {
  const root=process.cwd();
  const record=await loadLocalPrimaryObservation(root,new Date().toISOString());
  const bundle=await prepareSolarResearchExport(record);
  await verifySolarResearchExport(bundle);
  const figure=await prepareSolarResearchFigure(bundle);
  await verifySolarResearchFigure(figure);
  const temporaryRoot=path.join(root,'.tmp');await mkdir(temporaryRoot,{recursive:true});
  const directory=await mkdtemp(path.join(temporaryRoot,'solar-research-local-'));
  async function write(name:string,text:string) {
    const file=path.join(directory,name);const handle=await open(file,'wx',0o600);
    try {await handle.writeFile(text,'utf8');await handle.sync();} finally {await handle.close();}
    return file;
  }
  const recordFile=await write('primary-observation-record.json',bundle.recordJson);
  const bundleFile=await write('primary-observation-bundle.json',JSON.stringify(bundle));
  const csvFile=await write('primary-observation-table.csv',bundle.tableCsv);
  const manifestFile=await write('primary-observation-manifest.json',bundle.manifestJson);
  const figureFile=await write('primary-observation-figure.svg',figure.figureSvg);
  const figureManifestFile=await write('primary-observation-figure-manifest.json',figure.figureManifestJson);
  const figureBundleFile=await write('primary-observation-figure-bundle.json',JSON.stringify(figure));
  console.log(JSON.stringify({recordId:bundle.recordId,rows:record.rows.length,recordFile,bundleFile,csvFile,
    manifestFile,figureFile,figureManifestFile,figureBundleFile,sourceIdentityAuthenticated:false,modelAvailable:false,admissionAllowed:false,
    scienceRunAllowed:false,publicationPerformed:false},null,2));
}
main().catch(error=>{console.error(error instanceof Error?error.message:'Local preparation failed');process.exitCode=1;});
