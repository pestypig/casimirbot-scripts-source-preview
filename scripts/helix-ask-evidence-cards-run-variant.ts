import fs from 'node:fs/promises';
import path from 'node:path';

type PromptRow={id:string;bucket:string;prompt:string};
const VARIANT=(process.env.HELIX_ASK_AB_VARIANT??'A');
const BASE=process.env.HELIX_ASK_BASE_URL??'http://127.0.0.1:5173';
const SEEDS=(process.env.HELIX_ASK_AB_SEEDS??'7,11,13').split(',').map(Number);
const promptsPath='bench/helix_ask_evidence_cards_prompts.jsonl';
const MAX_INVALID_RATE=Number(process.env.HELIX_ASK_AB_MAX_INVALID_RATE??0.1);
const MIN_VALID=Number(process.env.HELIX_ASK_AB_MIN_VALID??200);
const MIN_COMPLETION_RATE=Number(process.env.HELIX_ASK_AB_MIN_COMPLETION_RATE??1);
const FAIL_ON_QUALITY=(process.env.HELIX_ASK_AB_FAIL_ON_QUALITY??'0')==='1';

async function ask(body:any){
  const t=Date.now();
  const res=await fetch(new URL('/api/agi/ask',BASE),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const latency_ms=Date.now()-t;
  let payload:any={};
  try{ payload=await res.json(); }catch{ payload={text:await res.text()}; }
  return {status:res.status,latency_ms,payload};
}

async function summarizeVariantRun(rawDir:string, expectedTotal:number){
  const files=(await fs.readdir(rawDir)).filter((name)=>name.endsWith('.json'));
  const status_counts:Record<string,number>={};
  let valid=0;
  for(const file of files){
    const row=JSON.parse(await fs.readFile(path.join(rawDir,file),'utf8')) as {status:number};
    const key=String(row.status);
    status_counts[key]=(status_counts[key]??0)+1;
    if(row.status===200) valid+=1;
  }
  const total=files.length;
  const invalid=Math.max(0,total-valid);
  const invalid_rate=total>0?invalid/total:1;
  const completion_rate=expectedTotal>0?total/expectedTotal:1;
  return {
    variant: VARIANT,
    expected_total: expectedTotal,
    n_total: total,
    n_valid: valid,
    n_invalid: invalid,
    invalid_rate,
    completion_rate,
    status_counts,
    gates: {
      min_valid: MIN_VALID,
      max_invalid_rate: MAX_INVALID_RATE,
      min_completion_rate: MIN_COMPLETION_RATE,
    },
    pass:
      valid>=MIN_VALID &&
      invalid_rate<=MAX_INVALID_RATE &&
      completion_rate>=MIN_COMPLETION_RATE,
  };
}

const main=async()=>{
  const lines=(await fs.readFile(promptsPath,'utf8')).trim().split('\n');
  const prompts=lines.map(l=>JSON.parse(l) as PromptRow);
  const outDir=path.join('artifacts/evidence-cards-ab',VARIANT,'raw');
  await fs.mkdir(outDir,{recursive:true});
  let i=0;
  for(const p of prompts){
    for(const seed of SEEDS){
      i++;
      const outPath=path.join(outDir,`${p.id}__seed${seed}.json`);
      try{ await fs.access(outPath); continue; }catch{}
      const res=await ask({question:p.prompt,debug:true,seed,temperature:0.2,tuning:{fast_quality_mode:false}});
      const row={variant:VARIANT,prompt_id:p.id,bucket:p.bucket,prompt:p.prompt,seed,...res,response:res.payload};
      await fs.writeFile(outPath,JSON.stringify(row,null,2));
      if(i%30===0) console.log(`${VARIANT}: ${i}/${prompts.length*SEEDS.length}`);
    }
  }
  const summary=await summarizeVariantRun(outDir,prompts.length*SEEDS.length);
  const summaryPath=path.join('artifacts/evidence-cards-ab',VARIANT,'summary.json');
  await fs.writeFile(summaryPath,JSON.stringify(summary,null,2),'utf8');
  console.log(`[${VARIANT}] status counts`,summary.status_counts,`valid=${summary.n_valid}/${summary.n_total}`);
  if(FAIL_ON_QUALITY && !summary.pass){
    console.error(
      `[${VARIANT}] run-quality gate failed: valid=${summary.n_valid} invalidRate=${summary.invalid_rate.toFixed(3)} completionRate=${summary.completion_rate.toFixed(3)}`,
    );
    process.exit(2);
  }
};
main().catch(e=>{console.error(e);process.exit(1)});
