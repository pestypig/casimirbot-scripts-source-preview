import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root=process.cwd();
const version=process.argv[2]??'v1';
if(!/^v[1-9][0-9]*$/.test(version))throw new Error('Expected version v1, v2, ...');
const python=path.join(root,'.codex-build/solar-runtime-build-v1/Scripts/python.exe');
const destination=path.join(root,`.codex-build/solar-runtime-candidate-${version}`);
try {await access(destination);throw new Error('Candidate destination already exists; retain it and version the next attempt');}
catch(error){if(error.code!=='ENOENT')throw error;}
const reportBytes=await readFile(path.join(root,'.codex-build/solar-runtime-build-v1/install-report.json'));
const report=JSON.parse(reportBytes);
const pins=report.install.map(item=>{
  const hash=item.download_info?.archive_info?.hashes?.sha256;
  if(!/^[a-f0-9]{64}$/.test(hash??'')||!item.download_info.url.endsWith('.whl'))
    throw new Error('Candidate requires hash-bound binary wheels');
  return `${item.metadata.name}==${item.metadata.version} --hash=sha256:${hash}`;
}).sort();
const metadata=report.install.map(item=>item.metadata.name);
const args=['-m','PyInstaller','--onedir','--name','solar-exporter',
  '--distpath',destination,'--workpath',path.join(root,`.codex-build/solar-runtime-work-${version}`),
  '--specpath',path.join(root,`.codex-build/solar-runtime-spec-${version}`),
  '--paths',path.join(root,'tools'),'--hidden-import','solar_runtime_check',
  '--collect-data','sunpy','--collect-data','astropy','--collect-submodules','sunpy.net',
  ...metadata.flatMap(name=>['--copy-metadata',name]),path.join(root,'tools/solar_frozen_entry.py')];
let buildLog='';
await new Promise((resolve,reject)=>{
  const child=spawn(python,args,{cwd:root,stdio:['ignore','pipe','pipe'],windowsHide:true});
  for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{
    buildLog+=chunk.toString();process.stdout.write(chunk);
  });
  child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error(`PyInstaller exit ${code}`)));
});
await writeFile(path.join(destination,'build.log'),buildLog);
await writeFile(path.join(destination,'requirements.lock.txt'),pins.join('\n')+'\n');
await writeFile(path.join(destination,'install-report.json'),reportBytes);
const site=path.join(root,'.codex-build/solar-runtime-build-v1/Lib/site-packages');
for(const entry of await readdir(site)) {
  if(!entry.endsWith('.dist-info'))continue;
  for(const name of await readdir(path.join(site,entry))) {
    if(name==='licenses'||/^(LICENSE|COPYING|NOTICE)/i.test(name)) {
      const target=path.join(destination,'licenses',entry,name);
      await mkdir(path.dirname(target),{recursive:true});
      await cp(path.join(site,entry,name),target,{recursive:true,errorOnExist:true,force:false});
    }
  }
}
const hashes=[];
const sources=await Promise.all(['solar_frozen_entry.py','hek_movie_export.py','solar_runtime_check.py'].map(async name=>({
  path:`tools/${name}`,sha256:createHash('sha256').update(await readFile(path.join(root,'tools',name))).digest('hex'),
})));
async function visit(directory){for(const entry of await readdir(directory,{withFileTypes:true})){
  const file=path.join(directory,entry.name);
  if(entry.isDirectory())await visit(file);
  else if(entry.isFile())hashes.push({path:path.relative(destination,file).replaceAll('\\','/'),
    sha256:createHash('sha256').update(await readFile(file)).digest('hex')});
  else throw new Error('Unexpected candidate runtime entry');
}}
await visit(destination);hashes.sort((a,b)=>a.path.localeCompare(b.path));
await writeFile(path.join(destination,'candidate-manifest.json'),JSON.stringify({
  schemaVersion:'solar-runtime-candidate/1',platform:'win32-x64',python:'3.13.7',
  entry:'solar-exporter/solar-exporter.exe',sourceEntrySha256:createHash('sha256')
    .update(await readFile(path.join(root,'tools/solar_frozen_entry.py'))).digest('hex'),
  sources,files:hashes,cleanWindowsVerified:false,publicReleaseReady:false,scienceRunAllowed:false},null,2));
console.log('Hash-bound solar candidate built; clean-Windows and installed EXE checks remain required.');
