import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {AsyncLocalStorage} from 'node:async_hooks';
import {canonicalJson,IntakeError} from './intake-store.mjs';

// LOCAL only. These are admission/lease records, not copies of customer files.
// Privileged filesystem writes are outside this cooperative lock boundary.
export const BASIC_SOURCE_RETENTION_BYTES_CAP=1024*1024;
const FILE_CAP=256*1024,ANCHOR='.basic-source-retention.json',ROOT='.basic-source-retention',LOCK='.basic-source-gate';
const context=new AsyncLocalStorage();
const reviewedRemounts=new Map();
const hash=value=>crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const fail=code=>{throw new IntakeError(`BASIC_SOURCE_RETENTION_${code}`,422);};
const isHash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const statKeys=['dev','ino','size','mtimeNs','ctimeNs','nlink'];
const pin=stat=>Object.fromEntries(statKeys.map(key=>[key,String(stat[key])]));
const freeze=value=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
async function safeDirectory(directory){
  if(typeof directory!=='string'||!path.isAbsolute(directory)||path.resolve(directory)!==directory)fail('DIRECTORY_INVALID');
  let current=path.parse(directory).root;
  for(const part of directory.slice(current.length).split(path.sep).filter(Boolean)){
    current=path.join(current,part);const stat=await fs.lstat(current);
    if(!stat.isDirectory()||stat.isSymbolicLink())fail('UNSAFE_DIRECTORY');
  }
  if(await fs.realpath(directory)!==directory)fail('DIRECTORY_ALIAS');
}
async function exists(file){try{return await fs.lstat(file);}catch(error){if(error.code==='ENOENT')return null;throw error;}}
async function read(file,maxBytes=FILE_CAP){
  const initial=await fs.lstat(file,{bigint:true});
  if(!initial.isFile()||initial.isSymbolicLink()||initial.nlink!==1n||initial.size<1n||initial.size>BigInt(maxBytes))fail('UNSAFE_FILE');
  const handle=await fs.open(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
  try{
    const before=await handle.stat({bigint:true});if(!same(pin(before),pin(initial)))fail('FILE_CHANGED');
    const bytes=Buffer.alloc(Number(before.size));let offset=0;
    while(offset<bytes.length){const r=await handle.read(bytes,offset,Math.min(65536,bytes.length-offset),offset);if(!r.bytesRead)fail('FILE_CHANGED');offset+=r.bytesRead;}
    if((await handle.read(Buffer.alloc(1),0,1,offset)).bytesRead||!same(pin(before),pin(await handle.stat({bigint:true})))||!same(pin(before),pin(await fs.lstat(file,{bigint:true}))))fail('FILE_CHANGED');
    try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{fail('CORRUPT_RECORD');}
  }finally{await handle.close();}
}
async function write(file,value){
  const bytes=Buffer.from(JSON.stringify(value)+'\n');if(bytes.length>FILE_CAP)fail('METADATA_LIMIT');
  const handle=await fs.open(file,'wx',0o600);try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
  await syncDirectory(path.dirname(file));
}
async function syncDirectory(directory){
  if(process.platform==='win32')return;
  const handle=await fs.open(directory,'r');try{await handle.sync();}finally{await handle.close();}
}
export function validateBasicSourceRetentionDescriptor(value){
  const {descriptorHash,...body}=value??{};
  if(descriptorHash!==hash(body)||body.schemaVersion!==1||body.kind!=='molyvi_basic_source_pin'||typeof body.sourceDirectory!=='string'||!isHash(body.ownerHash)||!isHash(body.recordHash)||!isHash(body.planHash)||!isHash(body.selectionHash)||!Array.isArray(body.files)||!body.files.length||body.files.length>131||new Set(body.files.map(x=>x.fileName)).size!==body.files.length||Buffer.byteLength(JSON.stringify(value))>FILE_CAP/2)fail('DESCRIPTOR_INVALID');
  for(const file of body.files)if(!/^(?:photo|generated|logo)-[a-f0-9-]{36}\.bin$/.test(file.fileName)||!isHash(file.sha256)||!Number.isSafeInteger(file.bytes)||file.bytes<1||file.bytes>10*1024*1024||!file.stat||statKeys.some(key=>!/^\d+$/.test(file.stat[key]??''))||file.stat.size!==String(file.bytes)||file.stat.nlink!=='1')fail('DESCRIPTOR_INVALID');
  return value;
}
export function makeBasicSourceRetentionDescriptor({directory,recordHash,plan,assets,verified}){
  const body={schemaVersion:1,kind:'molyvi_basic_source_pin',sourceDirectory:directory,projectId:plan.projectId,ownerHash:plan.binding.ownerHash,recordHash,planHash:plan.planHash,selectionHash:hash(assets),files:[...verified.values()].map(item=>({fileName:item.fileName,assetId:item.asset.id,kind:item.kind,bytes:item.asset.bytes,sha256:item.asset.sha256,mime:item.asset.mime,stat:pin(item.stat)}))};
  const remount=reviewedRemounts.get(directory);
  if(remount){for(const file of body.files){if(file.stat.dev!==remount.currentDev)fail('REMOUNT_CHANGED');file.stat.dev=remount.originalDev;}if(hash(body)!==remount.descriptorHash)fail('REMOUNT_CHANGED');}
  return freeze(validateBasicSourceRetentionDescriptor({...body,descriptorHash:hash(body)}));
}
async function state(directory){
  await safeDirectory(directory);
  const anchorStat=await exists(path.join(directory,ANCHOR)),rootStat=await exists(path.join(directory,ROOT));
  if(!anchorStat&&!rootStat)return null;
  if(!anchorStat||!rootStat)fail('INCOMPLETE_HISTORY');
  await safeDirectory(path.join(directory,ROOT));
  const names=(await fs.readdir(path.join(directory,ROOT))).sort();
  if(!same(names,['hold.json'])&&!same(names,['hold.json','release.json']))fail('INCOMPLETE_HISTORY');
  let total=Number(anchorStat.size);
  for(const name of names)total+=Number((await fs.lstat(path.join(directory,ROOT,name))).size);
  if(total>BASIC_SOURCE_RETENTION_BYTES_CAP)fail('METADATA_LIMIT');
  const anchor=await read(path.join(directory,ANCHOR)),hold=await read(path.join(directory,ROOT,'hold.json'));
  const {holdHash,...body}=hold;
  validateBasicSourceRetentionDescriptor(hold.source);
  if(holdHash!==hash(body)||body.schemaVersion!==1||body.kind!=='molyvi_basic_source_hold'||!isHash(body.intentHash)||typeof body.journalDirectory!=='string'||hold.source.sourceDirectory!==directory||!same(anchor,{schemaVersion:1,holdHash,intentHash:hold.intentHash,descriptorHash:hold.source.descriptorHash}))fail('HISTORY_MISMATCH');
  let release=null;
  if(names.includes('release.json')){
    release=await read(path.join(directory,ROOT,'release.json'));
    const {releaseHash,...unsigned}=release;
    if(releaseHash!==hash(unsigned)||release.schemaVersion!==1||release.kind!=='molyvi_basic_source_release'||release.holdHash!==holdHash||release.intentHash!==hold.intentHash||!isHash(release.journalHead)||!Number.isSafeInteger(release.eventCount)||release.eventCount<1)fail('HISTORY_MISMATCH');
  }
  return {hold,release};
}
async function gate(directory,operation){
  await safeDirectory(directory);
  const current=context.getStore();
  if(current?.directory===directory){
    if(!current.active)fail('EXPIRED_LEASE');
    return operation(current);
  }
  const lock=path.join(directory,LOCK);
  try{await fs.mkdir(lock,{mode:0o700});}catch(error){if(error.code==='EEXIST')fail('BUSY_OR_INTERRUPTED_LEASE');throw error;}
  await syncDirectory(directory);
  const lease={directory,active:true,reads:0,mutations:0};
  try{return await context.run(lease,()=>operation(lease));}
  finally{lease.active=false;await fs.rmdir(lock);await syncDirectory(directory);}
}
function match(current,descriptor,{allowReleased=false}={}){
  if(!current||!same(current.hold.source,descriptor))fail('HOLD_MISMATCH');
  if(current.release&&!allowReleased)fail('RELEASED');
}
async function currentFiles(descriptor){
  await safeDirectory(descriptor.sourceDirectory);
  const record=await read(path.join(descriptor.sourceDirectory,'workspace.json'),2*1024*1024);
  if(record.id!==descriptor.projectId||hash(record.ownerId)!==descriptor.ownerHash||hash(record)!==descriptor.recordHash)fail('SOURCE_CHANGED');
  for(const file of descriptor.files){
    const stat=await fs.lstat(path.join(descriptor.sourceDirectory,file.fileName),{bigint:true});
    const actual=pin(stat),remount=reviewedRemounts.get(descriptor.sourceDirectory);if(remount&&remount.descriptorHash===descriptor.descriptorHash&&actual.dev===remount.currentDev&&file.stat.dev===remount.originalDev)actual.dev=remount.originalDev;
    if(!stat.isFile()||stat.isSymbolicLink()||!same(actual,file.stat))fail('SOURCE_CHANGED');
  }
}
/** Guards actual TaskStore callbacks, including any new material files they create. */
export async function withBasicSourceMutation(directory,operation){
  return gate(directory,async lease=>{
    if(lease.reads)fail('ACTIVE_SOURCE_READ');
    if(lease.mutations)fail('ACTIVE_SOURCE_MUTATION');
    const current=await state(directory);if(current&&!current.release)fail('HELD');
    lease.mutations++;try{return await operation();}finally{lease.mutations--;}
  });
}
/** A future material-removal operation must use this same admission wrapper.
 * There is currently no production project/material deletion API. */
export const withBasicSourceRemoval=withBasicSourceMutation;
export async function withBasicRetainedSourceRead(descriptor,operation){
  return gate(descriptor.sourceDirectory,async lease=>{
    if(lease.mutations)fail('ACTIVE_SOURCE_MUTATION');
    const current=await state(descriptor.sourceDirectory);if(current)match(current,descriptor);
    lease.reads++;try{return await operation();}finally{lease.reads--;}
  });
}
export async function acquireBasicSourceRetention(referenceComposition,{intentHash,journalDirectory}){
  const {describeBasicReferenceRetention}=await import('./basic-store-package.mjs');
  const descriptor=describeBasicReferenceRetention(referenceComposition);
  if(!isHash(intentHash)||typeof journalDirectory!=='string'||path.resolve(journalDirectory)!==journalDirectory)fail('BINDING_INVALID');
  return gate(descriptor.sourceDirectory,async lease=>{
    if(lease.reads||lease.mutations)fail('ACTIVE_SOURCE_LEASE');
    if(await state(descriptor.sourceDirectory))fail('ALREADY_RESERVED');
    await referenceComposition.revalidate();
    const body={schemaVersion:1,kind:'molyvi_basic_source_hold',source:descriptor,intentHash,journalDirectory},hold={...body,holdHash:hash(body)};
    await write(path.join(descriptor.sourceDirectory,ANCHOR),{schemaVersion:1,holdHash:hold.holdHash,intentHash,descriptorHash:descriptor.descriptorHash});
    await fs.mkdir(path.join(descriptor.sourceDirectory,ROOT),{mode:0o700});
    await syncDirectory(descriptor.sourceDirectory);
    await write(path.join(descriptor.sourceDirectory,ROOT,'hold.json'),hold);
    return freeze(hold);
  });
}
export async function withBasicInstallationSourceHold(intent,journalDirectory,operation){
  if(!intent.sourceRetention)return operation();
  const descriptor=validateBasicSourceRetentionDescriptor(intent.sourceRetention);
  return gate(descriptor.sourceDirectory,async lease=>{
    if(lease.reads||lease.mutations)fail('ACTIVE_SOURCE_LEASE');
    const current=await state(descriptor.sourceDirectory);match(current,descriptor);
    if(current.hold.intentHash!==intent.intentHash||current.hold.journalDirectory!==journalDirectory||intent.planHash!==descriptor.planHash||intent.projectId!==descriptor.projectId||intent.ownerHash!==descriptor.ownerHash)fail('INSTALLATION_MISMATCH');
    await currentFiles(descriptor);
    const result=await operation();await currentFiles(descriptor);return result;
  });
}
export async function assertBasicRetainedRequest(referenceComposition,binding){
  const {describeBasicReferenceRetention}=await import('./basic-store-package.mjs');
  const descriptor=describeBasicReferenceRetention(referenceComposition);
  return gate(descriptor.sourceDirectory,async()=>{
    const current=await state(descriptor.sourceDirectory);if(!current)return;
    match(current,descriptor);
    if(binding?.intentHash!==current.hold.intentHash||binding?.projectId!==descriptor.projectId||binding?.ownerHash!==descriptor.ownerHash||binding?.planHash!==descriptor.planHash)fail('INSTALLATION_MISMATCH');
  });
}
export async function withBasicRetainedOperation(referenceComposition,operation){
  const {describeBasicReferenceRetention}=await import('./basic-store-package.mjs');
  return withBasicRetainedSourceRead(describeBasicReferenceRetention(referenceComposition),operation);
}
export async function assertBasicSourceUnreserved(referenceComposition){
  const {describeBasicReferenceRetention}=await import('./basic-store-package.mjs');
  const descriptor=describeBasicReferenceRetention(referenceComposition);
  return gate(descriptor.sourceDirectory,async()=>{if(await state(descriptor.sourceDirectory))fail('ALREADY_RESERVED');});
}
/** Completion is read from the actual checked journal, never a caller flag. */
export async function releaseBasicSourceRetention({referenceComposition,directory,context:callerContext}){
  const {describeBasicReferenceRetention}=await import('./basic-store-package.mjs');
  const descriptor=describeBasicReferenceRetention(referenceComposition),journalDirectory=path.resolve(directory),snapshot=structuredClone(callerContext);
  return gate(descriptor.sourceDirectory,async lease=>{
    if(lease.reads||lease.mutations)fail('ACTIVE_SOURCE_LEASE');
    const current=await state(descriptor.sourceDirectory);match(current,descriptor);
    if(current.hold.journalDirectory!==journalDirectory)fail('INSTALLATION_MISMATCH');
    const {readBasicInstallation,BASIC_INSTALL_CONTINUATION_REGISTRY}=await import('./basic-installation.mjs');
    const journal=await readBasicInstallation({directory:journalDirectory,context:snapshot}),intent=journal.intent;
    if(intent.intentHash!==current.hold.intentHash||!same(intent.sourceRetention,descriptor)||journal.continuation||journal.installationStatus!=='installed_operator_attested'||Object.values(journal.steps).some(step=>step.status!=='succeeded')||!['not_started','restored_operator_attested'].includes(journal.visibility.status))fail('VERIFIED_COMPLETION_REQUIRED');
    for(const root of [intent.registryDirectory,BASIC_INSTALL_CONTINUATION_REGISTRY]){
      const runner=path.join(root,`${intent.registryKey}.runner-lock`);
      if(await exists(runner))fail('RUNNER_ACTIVE_OR_INTERRUPTED');
    }
    await referenceComposition.revalidate();
    const body={schemaVersion:1,kind:'molyvi_basic_source_release',holdHash:current.hold.holdHash,intentHash:intent.intentHash,journalHead:journal.head,eventCount:journal.eventCount};
    const release={...body,releaseHash:hash(body)};
    await write(path.join(descriptor.sourceDirectory,ROOT,'release.json'),release);
    return freeze(release);
  });
}

// Private backend admission after an explicitly pinned remount review. Only the
// OS device number is portable; every inode, size, timestamp, link count and
// complete payload hash must match before granting this process-local mapping.
export async function authorizeReviewedBasicSourceRemount({directory,holdHash,descriptorHash,sourceHash}){
 return gate(directory,async()=>{
  const current=await state(directory);if(!current||current.hold.holdHash!==holdHash||current.hold.source.descriptorHash!==descriptorHash||current.hold.source.recordHash!==sourceHash)fail('REMOUNT_REVIEW_MISMATCH');
  const d=current.hold.source,record=await read(path.join(directory,'workspace.json'),2*1024*1024);if(hash(record)!==sourceHash)fail('SOURCE_CHANGED');
  let originalDev,currentDev;for(const file of d.files){const name=path.join(directory,file.fileName),s=await fs.lstat(name,{bigint:true});if(!s.isFile()||s.isSymbolicLink())fail('SOURCE_CHANGED');const actual=pin(s),withoutDev={...actual,dev:file.stat.dev};if(!same(withoutDev,file.stat))fail('SOURCE_CHANGED');originalDev??=file.stat.dev;currentDev??=actual.dev;if(originalDev!==file.stat.dev||currentDev!==actual.dev)fail('REMOUNT_MIXED_DEVICES');
   const h=await fs.open(name,constants.O_RDONLY|(constants.O_NOFOLLOW??0));try{if(!same(pin(await h.stat({bigint:true})),actual))fail('FILE_CHANGED');const digest=crypto.createHash('sha256'),buf=Buffer.alloc(65536);let count=0;for(;;){const n=await h.read(buf,0,buf.length,null);if(!n.bytesRead)break;count+=n.bytesRead;if(count>file.bytes)fail('SOURCE_CHANGED');digest.update(buf.subarray(0,n.bytesRead));}if(count!==file.bytes||digest.digest('hex')!==file.sha256||!same(pin(await h.stat({bigint:true})),actual)||!same(pin(await fs.lstat(name,{bigint:true})),actual))fail('SOURCE_CHANGED');}finally{await h.close();}
  }
  if(hash(await read(path.join(directory,'workspace.json'),2*1024*1024))!==sourceHash)fail('SOURCE_CHANGED');
  reviewedRemounts.set(directory,Object.freeze({descriptorHash,originalDev,currentDev}));return {verifiedFiles:d.files.length,originalDev,currentDev,descriptorHash};
 });
}
