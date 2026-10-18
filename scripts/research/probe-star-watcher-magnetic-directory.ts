/** Live read-only catalog + bounded selected download into a temporary probe cache.
 * Nothing is admitted to a scientific run or retained in the signed-in profile.
 */
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {searchSolarMagneticArchiveDate} from '../../server/services/solar-research/magnetic-archive-directory';
import {acquireSolarMagneticArchiveProduct,readSolarMagneticAcquisition} from '../../server/services/solar-research/magnetic-archive-acquisition';
import {prepareGongDisplayMap} from '../../server/services/solar-research/gong-fits-display-map';

const dateUtc=process.argv[2]??new Date().toISOString().slice(0,10);
const provider=process.argv[3]==='--hmi'?'lmsal_sdo':'nso_gong';
function hmiHeaderCards(bytes:Buffer){
  let offset=0;const hdus:Record<string,string>[]=[];
  for(let hdu=0;hdu<2&&offset+80<=bytes.length;hdu++){
    const cards:Record<string,string>={};let end=false,cardCount=0;
    while(offset+80<=bytes.length&&cardCount<2000){
      const card=bytes.toString('ascii',offset,offset+80);offset+=80;cardCount++;
      const key=card.slice(0,8).trim();
      if(key==='END'){end=true;break;}
      if(/^(SIMPLE|XTENSION|DATE-OBS|T_OBS|NAXIS|NAXIS1|NAXIS2|BITPIX|BUNIT|INSTRUME|TELESCOP|CONTENT|QUALITY|CTYPE1|CTYPE2)$/.test(key))
        cards[key]=card.slice(10,80).trim();
    }
    if(!end)break;
    hdus.push(cards);offset=Math.ceil(offset/2880)*2880;
    if(hdu===0&&cards.NAXIS?.startsWith('0'))continue;
    break;
  }
  return hdus;
}
const root=await mkdtemp(path.join(os.tmpdir(),'casimir-solar-magnetic-probe-'));
try{
  const catalog=await searchSolarMagneticArchiveDate(dateUtc);
  const selected=catalog.products.find(product=>product.provider===provider);
  if(!selected)throw new Error(`No confirmed ${provider} product: ${JSON.stringify(catalog.providers)}`);
  const owner={tenantId:'temporary-probe',accountProfileId:'temporary-probe'};
  const receipt=await acquireSolarMagneticArchiveProduct(owner,{dateUtc,provider,
    providerRecordKey:selected.providerRecordKey},{env:{...process.env,SUNPY_CACHE_ROOT:root}});
  const retained=await readSolarMagneticAcquisition(owner,receipt.acquisitionId,{...process.env,SUNPY_CACHE_ROOT:root});
  if(!retained)throw new Error('Probe acquisition receipt did not reopen');
  const map=provider==='nso_gong'?prepareGongDisplayMap(retained.bytes,retained.receipt):null;
  const hmiHeader=provider==='lmsal_sdo'?hmiHeaderCards(retained.bytes):null;
  process.stdout.write(JSON.stringify({dateUtc,providers:catalog.providers,selected:selected.providerRecordKey,
    acquisitionId:receipt.acquisitionId,sha256:receipt.sha256,bytes:receipt.bytes,
    mapEpoch:map?.source.inputEndUtc??null,grid:map?[map.longitudeCells,map.sineLatitudeCells]:null,
    hmiHeader,receiptHmiHeader:receipt.hmiHeader??null,receiptQualityStatus:receipt.qualityStatus,
    scientificAdmission:false},null,2)+'\n');
}finally{
  if(path.isAbsolute(root)&&path.dirname(root)===os.tmpdir()&&
      path.basename(root).startsWith('casimir-solar-magnetic-probe-'))
    await rm(root,{recursive:true,force:false});
}
