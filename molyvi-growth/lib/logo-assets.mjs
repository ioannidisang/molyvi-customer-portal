import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {inflateSync} from 'node:zlib';
import {validatePhoto} from './product-assets.mjs';
import {IntakeError} from './intake-store.mjs';
const fail=(code,status=422)=>{throw new IntakeError(code,status);};
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const rgb=values=>'#'+values.map(value=>Math.round(value).toString(16).padStart(2,'0')).join('');
const paeth=(a,b,c)=>{const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);return pa<=pb&&pa<=pc?a:pb<=pc?b:c;};
function crc(bytes){let value=0xffffffff;for(const byte of bytes){value^=byte;for(let bit=0;bit<8;bit++)value=value&1?(value>>>1)^0xedb88320:value>>>1;}return (value^0xffffffff)>>>0;}
// Bounded native PNG decoding for a colour proposal; no AI call, upload to a
// third party or modification of logo bytes. Other supported formats use presets.
export function logoPalette(bytes){
  try{
    if(!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return null;
    let offset=8,header,palette,alpha,ended=false;const compressed=[];
    while(offset+12<=bytes.length){
      const length=bytes.readUInt32BE(offset),end=offset+12+length;if(end>bytes.length)return null;
      const type=bytes.toString('ascii',offset+4,offset+8),data=bytes.subarray(offset+8,offset+8+length);
      if(crc(bytes.subarray(offset+4,offset+8+length))!==bytes.readUInt32BE(offset+8+length))return null;
      if(type==='IHDR'){if(header||offset!==8||length!==13)return null;header=data;}
      else if(type==='PLTE')palette=data;
      else if(type==='tRNS')alpha=data;
      else if(type==='IDAT')compressed.push(data);
      else if(type==='acTL')return null;
      else if(type==='IEND'){if(length||end!==bytes.length)return null;ended=true;break;}
      offset=end;
    }
    if(!header||!ended||!compressed.length)return null;
    const width=header.readUInt32BE(0),height=header.readUInt32BE(4),type=header[9],channels={0:1,2:3,3:1,4:2,6:4}[type];
    if(!channels||header[8]!==8||header[10]||header[11]||header[12]||!width||!height||width*height>4_000_000||type===3&&(!palette||palette.length%3))return null;
    const rowLength=width*channels,raw=inflateSync(Buffer.concat(compressed),{maxOutputLength:(rowLength+1)*height});
    if(raw.length!==(rowLength+1)*height)return null;
    let prior=Buffer.alloc(rowLength);const buckets=new Map(),stride=Math.max(1,Math.ceil(width*height/10000));
    for(let y=0;y<height;y++){
      const filter=raw[y*(rowLength+1)],row=Buffer.from(raw.subarray(y*(rowLength+1)+1,(y+1)*(rowLength+1)));if(filter>4)return null;
      for(let index=0;index<rowLength;index++){const a=index>=channels?row[index-channels]:0,b=prior[index],c=index>=channels?prior[index-channels]:0;row[index]=(row[index]+[0,a,b,Math.floor((a+b)/2),paeth(a,b,c)][filter])&255;}
      for(let x=0;x<width;x++){if((y*width+x)%stride)continue;const index=x*channels;let values,opacity=255;
        if(type===3){const n=row[index];if(n*3+2>=palette.length)return null;values=[...palette.subarray(n*3,n*3+3)];opacity=alpha?.[n]??255;}
        else{values=type===0||type===4?[row[index],row[index],row[index]]:[...row.subarray(index,index+3)];opacity=type===4?row[index+1]:type===6?row[index+3]:255;}
        if(opacity<128||values.every(value=>value>240))continue;
        const key=values.map(value=>Math.floor(value/24)).join(':'),bucket=buckets.get(key)??{sum:[0,0,0],count:0};values.forEach((value,n)=>bucket.sum[n]+=value);bucket.count++;buckets.set(key,bucket);
      }prior=row;
    }
    const colors=[...buckets.values()].sort((a,b)=>b.count-a.count).map(bucket=>bucket.sum.map(value=>value/bucket.count));if(!colors.length)return null;
    return {algorithm:'png_quantized_v1',sourceSha256:sha(bytes),primary:rgb(colors[0]),secondary:'#f6f5f1',accent:rgb(colors[1]??colors[0].map(value=>value*.55+255*.45))};
  }catch{return null;}
}
export async function uploadLogo(store,session,command){
  const input=validatePhoto(command);if(input.bytes.length>4*1024*1024)fail('LOGO_TOO_LARGE',413);
  return store.transact(session.projectId,session.ownerId,async record=>{
    if(record.order.status!=='verified_paid')fail('PAYMENT_REQUIRED',402);
    if(record.tasks.branding.submission)fail('TASK_LOCKED',409);
    record.brandAssets??={};const duplicate=Object.values(record.brandAssets).find(asset=>asset.sha256===input.sha256);
    if(duplicate)return {assetId:duplicate.id,duplicate:true};
    if(Object.keys(record.brandAssets).length>=10||Object.values(record.brandAssets).reduce((sum,asset)=>sum+asset.bytes,0)+input.bytes.length>16*1024*1024)fail('LOGO_STORAGE_LIMIT',413);
    const id=crypto.randomUUID(),directory=await store.directory(record.id),handle=await fs.open(path.join(directory,`logo-${id}.bin`),'wx',0o600);
    try{await handle.writeFile(input.bytes);await handle.sync();}finally{await handle.close();}
    record.brandAssets[id]={id,kind:'logo',name:input.name,mime:input.mime,bytes:input.bytes.length,sha256:input.sha256,paletteProposal:logoPalette(input.bytes)};
    return {assetId:id,duplicate:false};
  });
}
export async function readLogo(store,session,id){
  if(!/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(id??''))fail('NOT_FOUND',404);
  return store.serial(session.projectId,async()=>{
    const {record,directory}=await store.load(session.projectId,session.ownerId),asset=record.brandAssets?.[id];if(!asset)fail('NOT_FOUND',404);
    const file=path.join(directory,`logo-${id}.bin`),info=await fs.lstat(file);if(info.isSymbolicLink()||!info.isFile())fail('UNSAFE_STORAGE',500);
    const bytes=await fs.readFile(file);if(bytes.length!==asset.bytes||sha(bytes)!==asset.sha256)fail('LOGO_INTEGRITY_FAILED',500);
    return {asset,bytes};
  });
}
