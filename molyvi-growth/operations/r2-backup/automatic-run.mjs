// Explicit V2 scheduled execution; no timer, credential discovery or activation.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {snapshot,inventory} from './backup.mjs';
import {selectReferenceBackupProjects,prepareReferenceSnapshot,encryptReferenceSnapshot,restoreReferenceSnapshot,REFERENCE_BACKUP_LIMITS as L} from './reference-backup.mjs';
import {R2_LIMITS} from './r2-budget.mjs';
import {seedVerifiedLegacy,rotateVerifiedBackups} from './retention.mjs';
const check=(v,m)=>{if(!v)throw Error(m);},sha=b=>crypto.createHash('sha256').update(b).digest('hex');
export const AUTOMATIC_REFERENCE_POLICY=Object.freeze({schemaVersion:1,format:'MOLYVI-BACKUP-2',selection:'duplicate-images-v1'});
// Worst-case all simultaneous NEW local copies: source snapshot + logical
// restore, three compact/pack copies, three encrypted/compressed copies.
export const REFERENCE_AUTOMATIC_DISK_BYTES=8*L.sourceBytes+2*L.manifestBytes+L.reservedBytes+L.diskHeadroomBytes;
export function assessReferenceBackupCapacity({sourceBytes,availableBytes,usage,storedBytes,objects}){
  for(const n of [sourceBytes,availableBytes,usage?.requests,usage?.uploadBytes,usage?.downloadBytes,storedBytes,objects])
    check(Number.isSafeInteger(n)&&n>=0,'BACKUP_CAPACITY_INPUT');
  const blockers=[];
  if(sourceBytes+L.reservedBytes>L.sourceBytes)blockers.push('BACKUP_SOURCE_SIZE_LIMIT');
  if(availableBytes<REFERENCE_AUTOMATIC_DISK_BYTES)blockers.push('BACKUP_LOCAL_DISK_LIMIT');
  // Covers upload/download, two legacy HEADs, <=20 catalog heads/deletions and
  // their verification/lists. Actual requests still reserve one by one.
  if(usage.requests+96>R2_LIMITS.requests||usage.uploadBytes+L.objectBytes>R2_LIMITS.uploadBytes||usage.downloadBytes+L.objectBytes>R2_LIMITS.downloadBytes)blockers.push('BACKUP_TRANSFER_BUDGET_STOP');
  if(storedBytes+L.objectBytes>R2_LIMITS.storedBytes||objects+1>R2_LIMITS.objects)blockers.push('BACKUP_STORAGE_BUDGET_STOP');
  return {admitted:blockers.length===0,blockers,sourceBytes,reservedBytes:L.reservedBytes,sourceLimit:L.sourceBytes,availableBytes,
    requiredFreeBytes:REFERENCE_AUTOMATIC_DISK_BYTES,objectLimit:L.objectBytes,usage:{...usage},storedBytes,objects,
    requestHeadroom:96,dedupCreditBytes:0,retentionDeletionCreditBytes:0};
}
async function safeDirectory(value){
  const full=path.resolve(value),p=path.parse(full);let at=p.root;
  for(const bit of full.slice(p.root.length).split(path.sep).filter(Boolean)){at=path.join(at,bit);const s=await fs.lstat(at);check(s.isDirectory()&&!s.isSymbolicLink(),'BACKUP_PRIVATE_PATH_SYMLINK');}
  const real=await fs.realpath(full);check(process.platform==='win32'?real.toLowerCase()===full.toLowerCase():real===full,'BACKUP_PRIVATE_PATH_ALIAS');return full;
}
function separate(a,b){for(const [x,y]of [[a,b],[b,a]]){const r=path.relative(x,y);check(r&&(r==='..'||r.startsWith('..'+path.sep)||path.isAbsolute(r)),'BACKUP_PATH_OVERLAP');}}
async function proof(file,value){const h=await fs.open(file,'wx',0o600);try{await h.writeFile(JSON.stringify(value,null,2)+'\n');await h.sync();}finally{await h.close();}if(process.platform!=='win32'){const d=await fs.open(path.dirname(file),'r');try{await d.sync();}finally{await d.close();}}}
async function syncDirectory(dir){if(process.platform!=='win32'){const h=await fs.open(dir,'r');try{await h.sync();}finally{await h.close();}}}
async function cleanupChild(root,child){
  check(path.dirname(child)===root,'BACKUP_CLEANUP_SCOPE');const real=await fs.realpath(child);
  check(real===child||process.platform==='win32'&&real.toLowerCase()===child.toLowerCase(),'BACKUP_CLEANUP_SCOPE');
  const s=await fs.lstat(child);check(!s.isSymbolicLink(),'BACKUP_CLEANUP_SCOPE');
  if(s.isDirectory())await fs.rm(child,{recursive:true});else{check(s.isFile()&&s.nlink===1,'BACKUP_CLEANUP_SCOPE');await fs.unlink(child);}
}
export function createReferenceBackupRun({source,root,release,keyFile,keyHash,withBackupResources,quietSnapshot,r2,budget,catalog=null,seedLegacy=false,now=Date.now,statfs=fs.statfs}){
  source=path.resolve(source);root=path.resolve(root);keyFile=path.resolve(keyFile);separate(source,root);separate(source,keyFile);separate(root,keyFile);
  check(/^[a-f0-9]{40}$/.test(release)&&/^[a-f0-9]{64}$/.test(keyHash)&&typeof quietSnapshot==='function'&&typeof withBackupResources==='function','BACKUP_REFERENCE_CONFIG');
  // Hold exclusive heavy-work resources across admission, all archive/restore
  // processing, network transfers and cleanup. Snapshot is a shorter nested
  // write barrier; it cannot release the outer production exclusion.
  return runId=>withBackupResources(async()=>{
    check(/^auto-[0-9]{14}-[a-f0-9]{8}$/.test(runId),'BACKUP_RUN_ID');await safeDirectory(source);await safeDirectory(root);
    const dir=path.join(root,runId);
    try{await fs.lstat(dir);throw Error('BACKUP_RUN_EXISTS');}catch(e){if(e.code!=='ENOENT')throw e;}
    const sourceBytes=(await inventory(source,{skipSqliteSidecars:true})).reduce((n,e)=>n+e.bytes,0);
    const disk=await statfs(root),rows=catalog?.active()??[];
    catalog?.assertSettled();
    const capacity=assessReferenceBackupCapacity({sourceBytes,availableBytes:Number(disk.bavail)*Number(disk.bsize),usage:budget.summary(),
      storedBytes:rows.reduce((n,r)=>n+r.bytes,0),objects:rows.length});
    check(capacity.admitted,capacity.blockers[0]); // before ANY provider access
    await fs.mkdir(dir,{mode:0o700});await safeDirectory(dir);await syncDirectory(root);let key;
    try{
      const manifest=await quietSnapshot(()=>snapshot({source,output:path.join(dir,'snapshot'),release}));
      const capturedBytes=manifest.files.reduce((n,e)=>n+e.bytes,0);
      check(capturedBytes+L.reservedBytes<=L.sourceBytes,'BACKUP_SOURCE_SIZE_LIMIT');
      const selection=await selectReferenceBackupProjects({root:path.join(dir,'snapshot'),manifest});
      const compact=await prepareReferenceSnapshot({root:path.join(dir,'snapshot'),manifest,output:path.join(dir,'compact'),projects:selection.projects});
      await safeDirectory(path.dirname(keyFile));const ks=await fs.lstat(keyFile);
      check(ks.isFile()&&!ks.isSymbolicLink()&&ks.nlink===1&&ks.size===32,'BACKUP_INDEPENDENT_KEY_MISMATCH');
      key=await fs.readFile(keyFile);check(sha(key)===keyHash,'BACKUP_INDEPENDENT_KEY_MISMATCH');
      const file=path.join(dir,'service-backup.mlvb'),receipt=await encryptReferenceSnapshot({root:path.join(dir,'compact'),manifest:compact,key,file});
      // Full conservative capacity is checked again against free space already
      // reduced by this run's preparation; do not rely on forecast compression.
      const diskNow=await statfs(root),u=budget.summary();
      check(Number(diskNow.bavail)*Number(diskNow.bsize)>=REFERENCE_AUTOMATIC_DISK_BYTES,'BACKUP_LOCAL_DISK_LIMIT');
      check(u.requests+96<=R2_LIMITS.requests&&u.uploadBytes+receipt.bytes<=R2_LIMITS.uploadBytes&&u.downloadBytes+receipt.bytes<=R2_LIMITS.downloadBytes,'BACKUP_TRANSFER_BUDGET_STOP');
      if(catalog&&seedLegacy)await seedVerifiedLegacy(catalog,r2);
      const remote=await r2.list();budget.checkStorage(remote,receipt.bytes);
      const objectKey=`snapshots/${new Date(now()).toISOString().slice(0,10)}/${runId}/service-backup.mlvb`;
      const upload=await r2.upload({file,key:objectKey,receipt}),download=await r2.download({file:path.join(dir,'downloaded.mlvb'),key:objectKey,receipt});
      const restored=await restoreReferenceSnapshot({file:path.join(dir,'downloaded.mlvb'),key,output:path.join(dir,'restored'),expectedSha256:receipt.sha256});
      const result={status:'PASS',createdAt:new Date(now()).toISOString(),runId,release,objectKey,receipt,upload,download,restore:restored.report,
        policy:AUTOMATIC_REFERENCE_POLICY,selection:{projects:selection.projects.length,notes:selection.notes},capacity,
        budget:budget.summary(),remoteDeletion:false};
      await proof(path.join(dir,'backup-verified.json'),result);
      if(catalog){result.retention=await rotateVerifiedBackups({catalog,r2,result});result.remoteDeletion=result.retention.deleted.length>0;result.budget=budget.summary();}
      await proof(path.join(dir,'receipt.json'),result);
      for(const name of ['snapshot','compact','restored','service-backup.mlvb','downloaded.mlvb'])await cleanupChild(dir,path.join(dir,name));
      await cleanupChild(dir,restored.scratchDirectory);
      return result;
    }finally{key?.fill(0);}
  });
}
