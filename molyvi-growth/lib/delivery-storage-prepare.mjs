// Preparation only: produces a NEW private canonical copy. Never retires or
// renames a source delivery, changes a database, or enables a hosted feature.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {constants} from 'node:fs';
import {openArchiveSource} from './delivery-archive-source.mjs';
import {resolveDeliveryStorage,withDeliveryStorage,DELIVERY_STORAGE_MARKER} from './delivery-storage.mjs';
const check=(v,c)=>{if(!v)throw Object.assign(Error(c),{code:c});};
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const sig=s=>['dev','ino','size','mtimeNs','ctimeNs','nlink'].map(k=>s[k].toString()).join(':');
async function parents(full){
 let at=path.parse(full).root;for(const bit of full.slice(at.length).split(path.sep).filter(Boolean)){at=path.join(at,bit);const s=await fs.lstat(at);check(s.isDirectory()&&!s.isSymbolicLink(),'DELIVERY_PREPARE_PATH');}
}
async function verifyOrdinary(file,expected,output){
 await parents(path.dirname(file));const before=await fs.lstat(file,{bigint:true});
 check(before.isFile()&&!before.isSymbolicLink()&&before.nlink===1n&&before.size===BigInt(expected.bytes),'DELIVERY_PREPARE_FILE');
 const handle=await fs.open(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0));let destination;
 try{
  check(sig(await handle.stat({bigint:true}))===sig(before),'DELIVERY_PREPARE_CHANGED');
  if(output)destination=await fs.open(output,'wx',0o600);
  const hash=crypto.createHash('sha256');let used=0;
  while(used<expected.bytes){
   const b=Buffer.alloc(Math.min(65536,expected.bytes-used)),r=await handle.read(b,0,b.length,used);
   check(r.bytesRead===b.length,'DELIVERY_PREPARE_CHANGED');hash.update(b);
   if(destination){let offset=0;while(offset<b.length){const n=await destination.write(b,offset,b.length-offset);check(n.bytesWritten>0,'DELIVERY_PREPARE_WRITE');offset+=n.bytesWritten;}}used+=b.length;
  }
  check((await handle.read(Buffer.alloc(1),0,1,used)).bytesRead===0&&hash.digest('hex')===expected.sha256,'DELIVERY_PREPARE_CHANGED');
  await parents(path.dirname(file));check(sig(await handle.stat({bigint:true}))===sig(before)&&sig(await fs.lstat(file,{bigint:true}))===sig(before),'DELIVERY_PREPARE_CHANGED');
  await destination?.sync();
 }finally{await handle.close();await destination?.close();}
}
async function write(file,body){const h=await fs.open(file,'wx',0o600);try{await h.writeFile(body);await h.sync();}finally{await h.close();}}
async function syncDirectory(directory){
 if(process.platform==='win32')return;
 const h=await fs.open(directory,constants.O_RDONLY);try{await h.sync();}finally{await h.close();}
}
export async function prepareCanonicalDelivery({source,destination,manifestRaw,manifestHash,zipHash,projectId,orderId}){
 check(Buffer.isBuffer(manifestRaw)&&manifestRaw.length<=1024*1024,'DELIVERY_PREPARE_MANIFEST');
 manifestRaw=Buffer.from(manifestRaw);
 source=path.resolve(source);destination=path.resolve(destination);
 const relative=path.relative(source,destination),reverse=path.relative(destination,source);
 const inside=v=>v!==''&&!v.startsWith('..'+path.sep)&&v!=='..'&&!path.isAbsolute(v);
 check(source!==destination&&!inside(relative)&&!inside(reverse)&&path.basename(destination)===manifestHash,'DELIVERY_PREPARE_DESTINATION');
 await parents(source);await parents(path.dirname(destination));
 try{await fs.lstat(destination);check(false,'DELIVERY_PREPARE_EXISTS');}catch(e){if(e.code!=='ENOENT')throw e;}
 const zipBytes=(await fs.lstat(path.join(source,'Molyvi-Service-Delivery.zip'))).size;
 check(Number.isSafeInteger(zipBytes)&&zipBytes>=22&&zipBytes<=128*1024*1024,'DELIVERY_PREPARE_ZIP_LIMIT');
 const model=JSON.parse(manifestRaw),archive=await openArchiveSource({root:source,manifestRaw,manifestHash,zipHash,projectId,orderId});
 let logicalBytes=manifestRaw.length;
 try{
  for(const entry of model.files){
   check(entry.bytes<=10*1024*1024,'DELIVERY_PREPARE_MEMBER_LIMIT');
   await archive.digest(entry.file,{bytes:entry.bytes,sha256:entry.sha256});
   await verifyOrdinary(path.join(source,entry.file),entry);logicalBytes+=entry.bytes;
  }
  await verifyOrdinary(path.join(source,'delivery-manifest.json'),{bytes:manifestRaw.length,sha256:manifestHash});
 }finally{await archive.close();}
 await fs.mkdir(destination,{mode:0o700});
 await verifyOrdinary(path.join(source,'Molyvi-Service-Delivery.zip'),{bytes:zipBytes,sha256:zipHash},path.join(destination,'Molyvi-Service-Delivery.zip'));
 await write(path.join(destination,'delivery-manifest.json'),manifestRaw);
 const marker=Buffer.from(JSON.stringify({schemaVersion:1,format:'molyvi_delivery_zip_v1',projectId,serviceOrderId:orderId,manifestHash,zipHash,zipBytes,memberCount:model.files.length+1,logicalBytes})+'\n');
 await write(path.join(destination,DELIVERY_STORAGE_MARKER),marker);
 const binding=await resolveDeliveryStorage({root:destination,manifestRaw,manifestHash,zipHash,projectId,orderId});
 await withDeliveryStorage(binding,async reader=>{for(const entry of model.files)await reader.digest(entry.file,{bytes:entry.bytes,sha256:entry.sha256});});
 await syncDirectory(destination);await syncDirectory(path.dirname(destination));
 return Object.freeze({manifestHash,zipHash,projectId,orderId,files:model.files.length,logicalBytes,zipBytes,
  canonicalBytes:zipBytes+manifestRaw.length+marker.length,
  savedBytes:logicalBytes-manifestRaw.length-marker.length,markerHash:sha(marker),sourceRetired:false});
}
