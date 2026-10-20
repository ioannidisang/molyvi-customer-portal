// Opt-in execution only: no timer, environment discovery, credentials or network
// client are created until a caller admits a new run under its production lease.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {snapshot,inventory} from './backup.mjs';
import {createGenerationBase,encryptGeneration,restoreGeneration,GENERATION_BACKUP_LIMITS as L} from './generation-backup.mjs';
import {generationEvidenceHash,planGenerationRetention} from './generation-retention.mjs';
import {R2_LIMITS} from './r2-budget.mjs';

export const AUTOMATIC_GENERATION_POLICY=Object.freeze({
  schemaVersion:1,format:'MOLYVI-GENERATION-1',selection:'whole-service-shared-base-v1'
});
// Snapshot, local newly encrypted base/overlay, downloaded base/overlay, two
// authenticated streams, two unpacked streams, logical restore and headroom.
export const GENERATION_AUTOMATIC_DISK_BYTES=10*L.sourceBytes+2*L.metadataBytes+L.reservedBytes+L.diskHeadroomBytes;
const check=(v,m)=>{if(!v)throw Error(m);};
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const plain=v=>JSON.parse(JSON.stringify(v));
const objectOnly=r=>({key:r.key,bytes:r.bytes,sha256:r.sha256,kind:r.kind});
const iso=now=>new Date(now()).toISOString();
function receipt(r,scope){
  return r.kind==='legacy'?{bytes:r.bytes,sha256:r.sha256}:
    {format:AUTOMATIC_GENERATION_POLICY.format,bytes:r.bytes,sha256:r.sha256,scope,kind:r.kind};
}
function record(descriptor,kind){
  return {key:`generations/v1/${kind==='base'?'bases':'overlays'}/${descriptor.cipherHash}.mlvb`,
    bytes:descriptor.cipherBytes,sha256:descriptor.cipherHash,kind,descriptor};
}
async function directory(value){
  const full=path.resolve(value);let at=path.parse(full).root;
  for(const bit of full.slice(at.length).split(path.sep).filter(Boolean)){
    at=path.join(at,bit);const s=await fs.lstat(at);check(s.isDirectory()&&!s.isSymbolicLink(),'GENERATION_RUN_PATH');
  }
  const real=await fs.realpath(full);
  check(real===full||process.platform==='win32'&&real.toLowerCase()===full.toLowerCase(),'GENERATION_RUN_PATH');
  return full;
}
function separate(a,b){
  for(const [x,y]of [[a,b],[b,a]]){
    const r=path.relative(x,y);check(r&&(r==='..'||r.startsWith('..'+path.sep)||path.isAbsolute(r)),'GENERATION_RUN_PATH_OVERLAP');
  }
}
async function writeProof(file,value){
  const h=await fs.open(file,'wx',0o600);
  try{await h.writeFile(JSON.stringify(value,null,2)+'\n');await h.sync();}finally{await h.close();}
  if(process.platform!=='win32'){const d=await fs.open(path.dirname(file),'r');try{await d.sync();}finally{await d.close();}}
}
async function cleanupChild(root,child){
  check(path.dirname(child)===root,'GENERATION_RUN_CLEANUP_SCOPE');
  const real=await fs.realpath(child),s=await fs.lstat(child);
  check((real===child||process.platform==='win32'&&real.toLowerCase()===child.toLowerCase())&&!s.isSymbolicLink(),'GENERATION_RUN_CLEANUP_SCOPE');
  if(s.isDirectory())await fs.rm(child,{recursive:true});
  else{check(s.isFile()&&s.nlink===1,'GENERATION_RUN_CLEANUP_SCOPE');await fs.unlink(child);}
}
function admitted(plan){check(plan.admitted,plan.blockers[0]??'GENERATION_RUN_CAPACITY');return plan;}
function sameInventory(a,b){
  return generationEvidenceHash(a.map(x=>({key:x.key,bytes:x.bytes,etag:x.etag})).sort((x,y)=>x.key.localeCompare(y.key)))===
    generationEvidenceHash(b.map(x=>({key:x.key,bytes:x.bytes,etag:x.etag})).sort((x,y)=>x.key.localeCompare(y.key)));
}
export function createGenerationBackupRun({
  source,root,release,keyFile,keyHash,scope,withBackupResources,quietSnapshot,
  r2Factory,budget,catalog,now=Date.now,statfs=fs.statfs
}){
  source=path.resolve(source);root=path.resolve(root);keyFile=path.resolve(keyFile);
  separate(source,root);separate(source,keyFile);separate(root,keyFile);
  check(/^[a-f0-9]{40}$/.test(release)&&/^[a-f0-9]{64}$/.test(keyHash)
    &&typeof withBackupResources==='function'&&typeof quietSnapshot==='function'
    &&typeof r2Factory==='function'&&typeof budget?.reserveRecorded==='function'
    &&typeof budget?.entries==='function'&&catalog,'GENERATION_RUN_CONFIG');
  scope=plain(scope);
  return runId=>withBackupResources(async()=>{
    check(/^auto-\d{14}-[a-f0-9]{8}$/.test(runId),'BACKUP_RUN_ID');
    await directory(source);await directory(root);catalog.assertSettled();
    check(generationEvidenceHash(catalog.scope)===generationEvidenceHash(scope),'GENERATION_RUN_SCOPE');
    const dir=path.join(root,runId);
    try{await fs.lstat(dir);throw Error('GENERATION_RUN_EXISTS');}catch(e){if(e.code!=='ENOENT')throw e;}
    const sourceBytes=(await inventory(source,{skipSqliteSidecars:true})).reduce((n,e)=>n+e.bytes,0);
    check(sourceBytes+L.reservedBytes<=L.sourceBytes,'BACKUP_SOURCE_SIZE_LIMIT');
    const disk=await statfs(root);
    check(Number(disk.bavail)*Number(disk.bsize)>=GENERATION_AUTOMATIC_DISK_BYTES,'BACKUP_LOCAL_DISK_LIMIT');
    check(budget.summary().requests<R2_LIMITS.requests,'BACKUP_TRANSFER_BUDGET_STOP');
    const before=catalog.snapshot(),at=iso(now);
    catalog.beginRun({id:runId,release,at});
    await fs.mkdir(dir,{mode:0o700});await directory(dir);
    let key,r2,operation=0;
    const reservedIds=new Set();
    const trackedBudget={
      summary:()=>budget.summary(),checkStorage:(...args)=>budget.checkStorage(...args),
      reserve:value=>{
        const row=budget.reserveRecorded(value);
        // If this write fails, the charge is still durable and the unresolved
        // operation stops all replay. It can never be credited back silently.
        catalog.recordReservation(runId,row);reservedIds.add(row.id);
        return budget.summary();
      }
    };
    const reservations=()=>budget.entries().map(row=>({
      id:`r2-${row.id}`,generationId:reservedIds.has(row.id)?runId:null,
      at:new Date(row.at).toISOString(),requests:row.requests,uploadBytes:row.uploadBytes,
      downloadBytes:row.downloadBytes,status:'reserved'
    }));
    async function call(kind,r,fn){
      const id=`op-${++operation}`,objectKey=r?.key??null;
      catalog.beginOperation(runId,{id,kind,key:objectKey,expected:r?{bytes:r.bytes,sha256:r.sha256}:null});
      const result=await fn();
      let normalized;
      if(kind==='list')normalized={status:'PASS',kind,key:null,raw:plain(result),capturedAt:iso(now)};
      else normalized={status:'PASS',kind,key:objectKey,bytes:r.bytes,sha256:r.sha256,
        ...((kind==='head'?result.ETag:result.etag??r.etag)?{etag:kind==='head'?result.ETag:result.etag??r.etag}:{})};
      catalog.completeOperation(runId,id,normalized);
      return {result,normalized};
    }
    async function remoteInventory(known,{heads=true}={}){
      const listed=await call('list',null,()=>r2.list()),raw=listed.result;
      check(new Set(raw.map(x=>x.Key)).size===raw.length,'GENERATION_RUN_DUPLICATE_REMOTE');
      const map=new Map(known.map(r=>[r.key,r]));
      for(const item of raw){
        check(!item.Key.startsWith('generations/')||map.has(item.Key),'GENERATION_RUN_UNKNOWN_GENERATION_OBJECT');
        const expected=map.get(item.Key);
        if(expected)check(item.Size===expected.bytes&&item.ETag===expected.etag,'GENERATION_RUN_REMOTE_CHANGED');
      }
      for(const r of known){
        check(raw.some(x=>x.Key===r.key),'GENERATION_RUN_REMOTE_MISSING');
        if(heads){
          const h=await call('head',r,()=>r2.verify(r.key,receipt(r,scope)));
          check(h.result.ETag===r.etag,'GENERATION_RUN_REMOTE_CHANGED');
        }
      }
      return {complete:true,capturedAt:listed.normalized.capturedAt,
        objects:raw.map(x=>({key:x.Key,bytes:x.Size,sha256:map.get(x.Key)?.sha256??null,etag:x.ETag}))};
    }
    try{
      const manifest=await quietSnapshot(()=>snapshot({source,output:path.join(dir,'snapshot'),release}));
      await directory(path.dirname(keyFile));const ks=await fs.lstat(keyFile);
      check(ks.isFile()&&!ks.isSymbolicLink()&&ks.nlink===1&&ks.size===32,'BACKUP_INDEPENDENT_KEY_MISMATCH');
      key=await fs.readFile(keyFile);check(sha(key)===keyHash,'BACKUP_INDEPENDENT_KEY_MISMATCH');
      let base=before.base?before.objects.find(r=>r.key===before.base.key):null;
      check(!before.base||base?.kind==='base','GENERATION_RUN_BASE_REQUIRED');
      const newBase=!base;
      if(newBase)base=record((await createGenerationBase({root:path.join(dir,'snapshot'),manifest,key,file:path.join(dir,'base.mlvb'),scope})).descriptor,'base');
      const overlay=record((await encryptGeneration({root:path.join(dir,'snapshot'),manifest,
        baseDescriptor:base.descriptor,key,file:path.join(dir,'overlay.mlvb'),scope})).descriptor,'overlay');
      const candidate={id:runId,verifiedAt:at,kind:'base-overlay',baseKey:base.key,overlayKey:overlay.key};
      const all=[...before.objects,...(newBase?[base]:[]),overlay];
      const u=budget.summary(),uploadBytes=overlay.bytes+(newBase?base.bytes:0),downloadBytes=base.bytes+overlay.bytes;
      // Exact ciphertext sizes, no forecast compression or future deletion.
      check(u.uploadBytes+uploadBytes<=R2_LIMITS.uploadBytes&&u.downloadBytes+downloadBytes<=R2_LIMITS.downloadBytes
        &&u.requests+12<=R2_LIMITS.requests,'BACKUP_TRANSFER_BUDGET_STOP');
      const remaining=await statfs(root);
      check(Number(remaining.bavail)*Number(remaining.bsize)>=GENERATION_AUTOMATIC_DISK_BYTES,'BACKUP_LOCAL_DISK_LIMIT');
      r2=await r2Factory({budget:trackedBudget,generationScope:scope});
      const initial=await remoteInventory(before.objects);
      const preflight=admitted(planGenerationRetention({phase:'preflight',now:iso(now),inventory:initial,
        objects:all.map(objectOnly),generations:before.generations,candidate,reservations:reservations()}));
      await writeProof(path.join(dir,'preflight.json'),{scope,preflight,inventory:initial});
      const uploads=[];
      for(const [r,name]of [...(newBase?[[base,'base.mlvb']]:[]),[overlay,'overlay.mlvb']]){
        const {result}=await call('upload',r,()=>r2.upload({file:path.join(dir,name),key:r.key,receipt:receipt(r,scope)}));
        check(result.status==='PASS'&&result.duplicate===false,'GENERATION_RUN_UPLOAD_NOT_NEW');
        r.etag=result.etag;uploads.push({key:r.key,bytes:r.bytes,sha256:r.sha256,status:'PASS'});
      }
      const downloads=[];
      for(const [r,name]of [[base,'downloaded-base.mlvb'],[overlay,'downloaded-overlay.mlvb']]){
        const {result}=await call('download',r,()=>r2.download({file:path.join(dir,name),key:r.key,receipt:receipt(r,scope)}));
        check(result.status==='PASS'&&result.downloadedFromR2===true,'GENERATION_RUN_DOWNLOAD_REQUIRED');
        downloads.push({key:r.key,bytes:r.bytes,sha256:r.sha256,status:'PASS'});
      }
      const restored=await restoreGeneration({baseFile:path.join(dir,'downloaded-base.mlvb'),baseDescriptor:base.descriptor,
        generationFile:path.join(dir,'downloaded-overlay.mlvb'),generationDescriptor:overlay.descriptor,
        key,output:path.join(dir,'restored'),scope});
      check(restored.report.status==='PASS'&&restored.report.database?.integrity==='ok'
        &&restored.report.mailSent===false&&restored.report.liveStorageOverwritten===false
        &&generationEvidenceHash(restored.manifest)===generationEvidenceHash(manifest),'GENERATION_RUN_RESTORE_REQUIRED');
      const restoredAt=iso(now);
      // A real new LIST after the full restore; old timestamps are never restamped.
      // Initial HEADs / new-upload readbacks pin all identities; this fresh
      // LIST must still match their ETags. Retained HEADs follow the plan.
      const current=await remoteInventory(all,{heads:false});
      const verification={schemaVersion:1,status:'PASS',generationId:runId,
        generationHash:generationEvidenceHash(candidate),inventoryHash:generationEvidenceHash(current),verifiedAt:current.capturedAt,
        uploads,downloads,fullRestore:{status:'PASS',logicalFiles:manifest.files.length,
          logicalBytes:manifest.files.reduce((n,e)=>n+e.bytes,0),databaseIntegrity:'ok',mailSent:false,liveStorageOverwritten:false},
        reservationIds:catalog.reservationIds(runId)};
      const proof={scope,verification,inventory:current},proofHash=generationEvidenceHash(proof);
      await writeProof(path.join(dir,'backup-verified.json'),{proof,proofHash,restoreCompletedAt:restoredAt,restore:restored.report});
      const plan=admitted(planGenerationRetention({phase:'restored',now:iso(now),inventory:current,
        objects:all.map(objectOnly),generations:before.generations,candidate,reservations:reservations(),
        restoreProof:verification,trustedProofHash:generationEvidenceHash(verification)}));
      catalog.commitVerified(runId,{generation:candidate,objects:[base,overlay],proof,proofHash,base:{key:base.key,descriptor:base.descriptor}});
      catalog.beginPrune(runId,{plan,planHash:generationEvidenceHash(plan)});
      // Durable catalog also requires these retained dependency HEADs after plan.
      for(const objectKey of plan.keepObjectKeys){
        const r=all.find(x=>x.key===objectKey);
        const h=await call('head',r,()=>r2.verify(r.key,receipt(r,scope)));
        check(h.result.ETag===r.etag,'GENERATION_RUN_RETAINED_CHANGED');
      }
      const deleted=[];
      r2.requireDeleteBudget(plan.deletionCandidates.length);
      for(const value of plan.deletionCandidates){
        const r=all.find(x=>x.key===value.key);catalog.markDeleting(runId,r.key);
        const result=await r2.deleteVerified({...receipt(r,scope),key:r.key,etag:r.etag});
        catalog.markDeleted(runId,r.key,result);deleted.push(r.key);
      }
      const survivors=all.filter(r=>!deleted.includes(r.key));
      const final=await remoteInventory(survivors,{heads:false});
      const expected=current.objects.filter(r=>!deleted.includes(r.key));
      check(sameInventory(expected,final.objects),'GENERATION_RUN_FINAL_INVENTORY_CHANGED');
      const result={status:'PASS',runId,release,scope,policy:AUTOMATIC_GENERATION_POLICY,
        sourceBytes:verification.fullRestore.logicalBytes,baseBytes:base.bytes,overlayBytes:overlay.bytes,
        restore:restored.report,proofHash,retention:{weekly:plan.weekly,monthly:plan.monthly,
          kept:plan.keepGenerationIds,deleted,unmanagedPreserved:plan.unmanagedPreserved},
        budget:plain(budget.summary()),inventory:final,activationReady:false};
      await writeProof(path.join(dir,'receipt.json'),result);
      // Local scratch cleanup precedes settlement; an interrupted cleanup is not
      // silently treated as a completed run or an authorization to retry.
      for(const name of ['snapshot','overlay.mlvb','downloaded-base.mlvb','downloaded-overlay.mlvb','restored',...(newBase?['base.mlvb']:[])])
        await cleanupChild(dir,path.join(dir,name));
      await cleanupChild(dir,restored.scratchDirectory);
      catalog.finishRun(runId,{receipt:{status:'PASS',inventory:final},retireGenerationIds:plan.retireGenerationIds});
      return result;
    }finally{key?.fill(0);r2?.close();}
  });
}
