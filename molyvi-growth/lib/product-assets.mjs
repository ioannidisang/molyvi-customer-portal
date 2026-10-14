import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {IntakeError} from './intake-store.mjs';
import {MATERIAL_LIMITS,productLocked} from './product-materials.mjs';
const fail=(code,status=422)=>{throw new IntakeError(code,status);};

export function validatePhoto({name,mime,data}){
  if(typeof name!=='string'||!name.trim()||name.length>200||/[\x00-\x1f\x7f]/.test(name))fail('INVALID_PHOTO');
  if(typeof data!=='string'||!data.length||data.length>Math.ceil(MATERIAL_LIMITS.maxFileBytes/3)*4||data.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(data))fail('INVALID_PHOTO');
  const bytes=Buffer.from(data,'base64');if(bytes.toString('base64')!==data)fail('INVALID_PHOTO');if(bytes.length>MATERIAL_LIMITS.maxFileBytes)fail('PHOTO_TOO_LARGE',413);
  const png=bytes.length>=33&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))&&bytes.toString('ascii',12,16)==='IHDR'&&bytes.readUInt32BE(16)>0&&bytes.readUInt32BE(20)>0;
  const jpeg=bytes.length>=24&&bytes[0]===255&&bytes[1]===216&&bytes[bytes.length-2]===255&&bytes[bytes.length-1]===217;
  const webp=bytes.length>=30&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP'&&bytes.readUInt32LE(4)+8===bytes.length;
  if(!(mime==='image/png'&&png||mime==='image/jpeg'&&jpeg||mime==='image/webp'&&webp))fail('INVALID_PHOTO_TYPE',415);
  return {name:name.trim(),mime,bytes,sha256:crypto.createHash('sha256').update(bytes).digest('hex')};
}
export async function uploadPhoto(store,session,command){
  const input=validatePhoto(command);
  return store.transact(session.projectId,session.ownerId,async record=>{
    if(record.order.status!=='verified_paid')fail('PAYMENT_REQUIRED',402);
    const task=record.tasks.catalog;
    if(task.submission)fail('TASK_LOCKED',409);
    if(productLocked(record,command.productId))fail('PRODUCT_LOCKED',409);
    const product=task.draft.products?.find(product=>product.id===command.productId);
    if(!product)fail('PRODUCT_NOT_FOUND',404);
    record.assets??={};
    const duplicate=Object.values(record.assets).find(asset=>asset.productId===product.id&&asset.sha256===input.sha256);
    if(duplicate)return {assetId:duplicate.id,duplicate:true};
    const total=Object.values(record.assets).reduce((sum,asset)=>sum+asset.bytes,0);
    if(total+input.bytes.length>MATERIAL_LIMITS.maxProjectBytes)fail('PHOTO_STORAGE_LIMIT',413);
    const id=crypto.randomUUID(),directory=await store.directory(record.id),file=path.join(directory,`photo-${id}.bin`);
    const handle=await fs.open(file,'wx',0o600);
    try{await handle.writeFile(input.bytes);await handle.sync();}finally{await handle.close();}
    record.assets[id]={id,productId:product.id,name:input.name,mime:input.mime,bytes:input.bytes.length,sha256:input.sha256};
    return {assetId:id,duplicate:false};
  });
}
export async function readPhoto(store,session,id){
  if(!/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(id))fail('NOT_FOUND',404);
  return store.serial(session.projectId,async()=>{
    const {directory,record}=await store.load(session.projectId,session.ownerId),asset=record.assets?.[id];
    if(!asset)fail('NOT_FOUND',404);
    const file=path.join(directory,`photo-${id}.bin`),info=await fs.lstat(file);
    if(info.isSymbolicLink()||!info.isFile())fail('UNSAFE_STORAGE',500);
    const bytes=await fs.readFile(file);
    if(bytes.length!==asset.bytes||crypto.createHash('sha256').update(bytes).digest('hex')!==asset.sha256)fail('PHOTO_INTEGRITY_FAILED',500);
    return {asset,bytes};
  });
}

// Trusted adapter / test fixture only. Never exposed as a customer upload endpoint.
export async function storeGeneratedPhoto(store,session,{productId,sourceHash,visualUnitId,...command}){
  const input=validatePhoto(command);
  return store.transact(session.projectId,session.ownerId,async record=>{
    if(record.order.status!=='verified_paid')fail('PAYMENT_REQUIRED',402);
    const gallery=record.productGalleries?.[productId];
    if(!gallery||gallery.sourceHash!==sourceHash)fail('GALLERY_STALE',409);
    if(!gallery.slots.some(slot=>(slot.visualUnitId??null)===(visualUnitId??null)))fail('GENERATED_VISUAL_UNIT_NOT_OWNED',403);
    record.generatedAssets??={};
    const total=[...Object.values(record.assets),...Object.values(record.generatedAssets)].reduce((sum,asset)=>sum+asset.bytes,0);
    if(total+input.bytes.length>500*1024*1024)fail('PHOTO_STORAGE_LIMIT',413);
    const id=crypto.randomUUID(),directory=await store.directory(record.id),handle=await fs.open(path.join(directory,`generated-${id}.bin`),'wx',0o600);
    try{await handle.writeFile(input.bytes);await handle.sync();}finally{await handle.close();}
    record.generatedAssets[id]={id,productId,sourceHash,...(visualUnitId?{visualUnitId}:{}),name:input.name,mime:input.mime,bytes:input.bytes.length,sha256:input.sha256};
    return {assetId:id};
  });
}
export async function readGeneratedPhoto(store,session,id){
  if(!/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(id))fail('NOT_FOUND',404);
  return store.serial(session.projectId,async()=>{
    const {directory,record}=await store.load(session.projectId,session.ownerId),asset=record.generatedAssets?.[id];
    const publicCandidate=Object.values(record.productGalleries??{}).some(gallery=>gallery.slots.some(slot=>slot.candidates.some(candidate=>candidate.assetId===id)));
    if(!asset||!publicCandidate)fail('NOT_FOUND',404);
    const file=path.join(directory,`generated-${id}.bin`),info=await fs.lstat(file);
    if(info.isSymbolicLink()||!info.isFile())fail('UNSAFE_STORAGE',500);
    const bytes=await fs.readFile(file);if(bytes.length!==asset.bytes||crypto.createHash('sha256').update(bytes).digest('hex')!==asset.sha256)fail('PHOTO_INTEGRITY_FAILED',500);
    return {asset,bytes};
  });
}
