// Explicit delivery authority only. Legacy callers never discover archive
// storage implicitly. No migration, deletion, network or provider activation.
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {PassThrough} from 'node:stream';
import {openArchiveSource} from './delivery-archive-source.mjs';

export const DELIVERY_STORAGE_MARKER='.delivery-storage-v1.json';
export const DELIVERY_STORAGE_LIMITS=Object.freeze({markerBytes:4096,manifestBytes:1024*1024,memberBytes:10*1024*1024,archiveBytes:128*1024*1024});
const bindings=new WeakMap(),H=/^[a-f0-9]{64}$/,sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const fail=code=>{throw Object.assign(new Error(code),{code});};
const check=(v,c='DELIVERY_STORAGE_INVALID')=>{if(!v)fail(c);};
const names=['Molyvi-Service-Delivery.zip',DELIVERY_STORAGE_MARKER,'delivery-manifest.json'].sort();
const keys='format,logicalBytes,manifestHash,memberCount,projectId,schemaVersion,serviceOrderId,zipBytes,zipHash';
const signature=s=>['dev','ino','size','mtimeNs','ctimeNs','nlink'].map(k=>s[k].toString()).join(':');
export function assertDeliveryStorageRoot(binding,root){
 const info=bindings.get(binding);check(info&&path.resolve(root)===info.root,'DELIVERY_STORAGE_AUTHORITY');
}
async function checkedPath(file){
 const full=path.resolve(file);let at=path.parse(full).root;
 for(const bit of full.slice(at.length).split(path.sep).filter(Boolean)){at=path.join(at,bit);const s=await fs.lstat(at,{bigint:true});check(!s.isSymbolicLink()&&(at===full?s.isFile():s.isDirectory()),'DELIVERY_STORAGE_PATH');if(at===full)return s;}
 fail('DELIVERY_STORAGE_PATH');
}
async function ordinary(file,max){
 const s=await checkedPath(file);check(s.nlink===1n&&s.size>=0n&&s.size<=BigInt(max),'DELIVERY_STORAGE_SIZE');
 const h=await fs.open(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0));try{
  const before=await h.stat({bigint:true});check(signature(before)===signature(s),'DELIVERY_STORAGE_CHANGED');
  const b=Buffer.alloc(Number(s.size));let used=0;
  while(used<b.length){const r=await h.read(b,used,Math.min(65536,b.length-used),used);check(r.bytesRead>0,'DELIVERY_STORAGE_CHANGED');used+=r.bytesRead;}
  check((await h.read(Buffer.alloc(1),0,1,b.length)).bytesRead===0,'DELIVERY_STORAGE_CHANGED');
  check(signature(await h.stat({bigint:true}))===signature(s)&&signature(await checkedPath(file))===signature(s),'DELIVERY_STORAGE_CHANGED');
  return b;
 }finally{await h.close();}
}
async function inspect(root,expected){
 let marker;try{marker=await ordinary(path.join(root,DELIVERY_STORAGE_MARKER),DELIVERY_STORAGE_LIMITS.markerBytes);}catch(e){if(e.code==='ENOENT')return null;throw e;}
 let d;try{d=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(marker));}catch{fail('DELIVERY_STORAGE_INVALID');}
 check(d&&Object.keys(d).sort().join(',')===keys&&d.schemaVersion===1&&d.format==='molyvi_delivery_zip_v1');
 for(const k of ['manifestHash','zipHash'])check(H.test(d[k])&&d[k]===expected[k],'DELIVERY_STORAGE_AUTHORITY');
 check(d.projectId===expected.projectId&&d.serviceOrderId===expected.orderId&&path.basename(root)===d.manifestHash,'DELIVERY_STORAGE_AUTHORITY');
 const raw=await ordinary(path.join(root,'delivery-manifest.json'),DELIVERY_STORAGE_LIMITS.manifestBytes);
 check(sha(raw)===d.manifestHash&&raw.equals(expected.manifestRaw),'DELIVERY_STORAGE_AUTHORITY');
 const model=JSON.parse(raw);check(model.projectId===d.projectId&&model.serviceOrderId===d.serviceOrderId&&Array.isArray(model.files),'DELIVERY_STORAGE_AUTHORITY');
 let total=raw.length;
 for(const entry of model.files){check(Number.isSafeInteger(entry.bytes)&&entry.bytes>=0&&entry.bytes<=DELIVERY_STORAGE_LIMITS.memberBytes,'DELIVERY_STORAGE_MEMBER_LIMIT');total+=entry.bytes;}
 check(d.memberCount===model.files.length+1&&d.logicalBytes===total&&total<=DELIVERY_STORAGE_LIMITS.archiveBytes,'DELIVERY_STORAGE_SIZE');
 const zipStat=await fs.lstat(path.join(root,'Molyvi-Service-Delivery.zip'));
 check(zipStat.isFile()&&!zipStat.isSymbolicLink()&&zipStat.nlink===1&&zipStat.size===d.zipBytes&&d.zipBytes<=DELIVERY_STORAGE_LIMITS.archiveBytes,'DELIVERY_STORAGE_SIZE');
 const found=[];for await(const entry of await fs.opendir(root)){check(found.length<3,'DELIVERY_STORAGE_MIXED_LAYOUT');found.push(entry.name);}
 check(JSON.stringify(found.sort())===JSON.stringify(names),'DELIVERY_STORAGE_MIXED_LAYOUT');
 return {descriptor:d,markerHash:sha(marker),raw};
}
export async function resolveDeliveryStorage({root,manifestRaw,manifestHash,zipHash,projectId,orderId}){
 // Canonical-only limits never alter an existing ordinary delivery.
 try{await checkedPath(path.join(root,DELIVERY_STORAGE_MARKER));}catch(e){if(e.code==='ENOENT')return null;throw e;}
 check(Buffer.isBuffer(manifestRaw)&&manifestRaw.length<=DELIVERY_STORAGE_LIMITS.manifestBytes&&H.test(manifestHash)&&H.test(zipHash)&&sha(manifestRaw)===manifestHash,'DELIVERY_STORAGE_AUTHORITY');
 const expected={root:path.resolve(root),manifestRaw:Buffer.from(manifestRaw),manifestHash,zipHash,projectId,orderId};
 const found=await inspect(expected.root,expected);if(!found)return null;
 const binding=Object.freeze({format:'molyvi_delivery_zip_v1'});
 bindings.set(binding,{...expected,...found});return binding;
}
async function source(binding){
 const info=bindings.get(binding);check(info,'DELIVERY_STORAGE_AUTHORITY');
 const latest=await inspect(info.root,info);
 check(latest&&latest.markerHash===info.markerHash,'DELIVERY_STORAGE_CHANGED');
 return openArchiveSource(info);
}
async function recheck(binding){
 const info=bindings.get(binding);check(info,'DELIVERY_STORAGE_AUTHORITY');
 const latest=await inspect(info.root,info);check(latest&&latest.markerHash===info.markerHash,'DELIVERY_STORAGE_CHANGED');
}
export async function digestDeliveryStoredFile(binding,file){
 return withDeliveryStorage(binding,async archive=>{const e=await archive.digest(file);return {bytes:e.bytes,sha256:e.sha256};});
}
export async function withDeliveryStorage(binding,body){
 check(typeof body==='function','DELIVERY_STORAGE_AUTHORITY');
 const archive=await source(binding);try{const result=await body(archive);await recheck(binding);return result;}finally{await archive.close();}
}
export async function readDeliveryStoredFile(binding,file){
 return withDeliveryStorage(binding,async archive=>{
  const e=archive.entry(file);check(e.bytes<=DELIVERY_STORAGE_LIMITS.memberBytes,'DELIVERY_STORAGE_MEMBER_LIMIT');
  if(e.bytes<=1024*1024)return archive.readSmall(file);
  return archive.streamVerify(file,async({chunks})=>{const b=Buffer.alloc(e.bytes);let at=0;for await(const chunk of chunks){chunk.copy(b,at);at+=chunk.length;}return b;});
 });
}
// Adapter for existing verified file streaming. One immutable handle capability
// stays open until the response settles; no temporary expanded file is created.
export async function openDeliveryStoredFile(binding,file){
 const archive=await source(binding);let stream,completion,started=false,closed=false;
 try{
  const entry=archive.entry(file);await archive.digest(file);
  return {size:entry.bytes,handle:{
   createReadStream(){
    check(!started&&!closed,'DELIVERY_STORAGE_STREAM_STATE');started=true;stream=new PassThrough({highWaterMark:65536});
    completion=archive.streamVerify(file,async({chunks})=>{
     for await(const chunk of chunks){
      if(closed||stream.destroyed)fail('DELIVERY_STORAGE_STREAM_ABORTED');
      if(!stream.write(chunk))await new Promise((resolve,reject)=>{
       const done=()=>{clean();resolve();},bad=()=>{clean();reject(Error('DELIVERY_STORAGE_STREAM_ABORTED'));};
       const clean=()=>{stream.off('drain',done);stream.off('close',bad);stream.off('error',bad);};
       stream.once('drain',done);stream.once('close',bad);stream.once('error',bad);
      });
     }
    }).then(()=>recheck(binding));
    completion.then(()=>stream.end(),e=>stream.destroy(e));return stream;
   },
   async close(){if(closed)return;closed=true;stream?.destroy();if(completion)await completion.catch(()=>{});await archive.close();}
  }};
 }catch(e){await archive.close();throw e;}
}
