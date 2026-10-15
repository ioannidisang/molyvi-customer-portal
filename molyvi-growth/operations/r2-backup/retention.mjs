import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';

export const RETENTION_POLICY='four-weekly-three-monthly-v1';
const assert=(v,m)=>{if(!v)throw Error(m);};
const hash=v=>crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const LEGACY=[
  {key:'snapshots/2026-10-15/basic-20261015-r1/service-backup.mlvb',bytes:202980242,sha256:'940a55685b645a507d56cf84b5804ada4276da8a3d6f638238d483221e19fe1b',verifiedAt:'2026-10-15T15:32:35.339Z',release:'d81c9d4f69f1afde682a2e812e0f676e0358012f'},
  {key:'snapshots/2026-10-15/auto-20261015154843-17ee7a49/service-backup.mlvb',bytes:202980193,sha256:'f5c6d610e44b28bf07848758e3f885fdfed6f2371fc0f4ac61a3783c535f5219',verifiedAt:'2026-10-15T15:49:57.754Z',release:'aed09a139096e55cd5c7a4039373bc81d4267f2d'}
];
export function retentionKey(key){
  assert(typeof key==='string'&&(key===LEGACY[0].key||/^snapshots\/\d{4}-\d{2}-\d{2}\/auto-\d{14}-[a-f0-9]{8}\/service-backup\.mlvb$/.test(key)),'RETENTION_KEY_SCOPE');return key;
}
function record(r){
  retentionKey(r.key);
  assert(Number.isSafeInteger(r.bytes)&&r.bytes>43&&r.bytes<=512_000_000&&/^[a-f0-9]{64}$/.test(r.sha256)&&/^[a-f0-9]{40}$/.test(r.release)&&typeof r.verifiedAt==='string'&&Number.isFinite(Date.parse(r.verifiedAt))&&new Date(r.verifiedAt).toISOString()===r.verifiedAt&&typeof r.etag==='string'&&r.etag.length>0&&r.etag.length<=200,'RETENTION_RECORD_INVALID');return r;
}
export function verifiedBackup(result){
  const r=result?.receipt;
  assert(result?.status==='PASS'&&result.upload?.status==='PASS'&&result.download?.status==='PASS'&&result.restore?.status==='PASS'&&result.restore.liveStorageOverwritten===false&&result.restore.mailSent===false&&result.restore.files>0&&result.restore.database?.integrity==='ok','RETENTION_RESTORE_REQUIRED');
  assert(result.upload.key===result.objectKey&&result.download.key===result.objectKey&&result.upload.sha256===r?.sha256&&result.download.sha256===r.sha256&&result.upload.bytes===r.bytes&&result.download.bytes===r.bytes,'RETENTION_TRANSFER_PROOF_REQUIRED');
  return record({key:result.objectKey,bytes:r.bytes,sha256:r.sha256,etag:result.upload.etag,verifiedAt:result.createdAt,release:result.release});
}
export function planRetention(records,newestKey){
  assert(Array.isArray(records)&&records.length>0&&records.length<=20,'RETENTION_INVENTORY_INVALID');
  const rows=records.map(r=>record(r)).sort((a,b)=>Date.parse(b.verifiedAt)-Date.parse(a.verifiedAt)||b.key.localeCompare(a.key));
  assert(new Set(rows.map(r=>r.key)).size===rows.length&&rows[0].key===newestKey,'RETENTION_NEWEST_REQUIRED');
  const weekly=rows.slice(0,4).map(r=>r.key),monthly=[],months=new Set();
  for(const r of rows){const month=r.verifiedAt.slice(0,7);if(months.has(month))continue;months.add(month);monthly.push(r.key);if(monthly.length===3)break;}
  const keep=new Set([...weekly,...monthly]);
  return {policy:RETENTION_POLICY,anchor:newestKey,weekly,monthly,keep:[...keep],remove:rows.filter(r=>!keep.has(r.key)).sort((a,b)=>Date.parse(a.verifiedAt)-Date.parse(b.verifiedAt))};
}
export class RetentionCatalog{
  constructor(file){this.file=path.resolve(file);}
  async ready(){
    let current=path.parse(this.file).root;
    for(const bit of this.file.slice(current.length).split(path.sep).filter(Boolean)){current=path.join(current,bit);try{assert(!(await fs.lstat(current)).isSymbolicLink(),'RETENTION_SYMLINK');}catch(e){if(e.code==='ENOENT')break;throw e;}}
    await fs.mkdir(path.dirname(this.file),{recursive:true,mode:0o700});this.db=new DatabaseSync(this.file);await fs.chmod(this.file,0o600);
    this.db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS backups(key TEXT PRIMARY KEY,bytes INTEGER NOT NULL,sha256 TEXT NOT NULL,etag TEXT NOT NULL,verified_at TEXT NOT NULL,release TEXT NOT NULL,proof_hash TEXT NOT NULL,status TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS plans(id TEXT PRIMARY KEY,at TEXT NOT NULL,plan TEXT NOT NULL,status TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS deletions(key TEXT PRIMARY KEY,plan_id TEXT NOT NULL,status TEXT NOT NULL);`);return this;
  }
  get(key){const r=this.db.prepare('SELECT * FROM backups WHERE key=?').get(key);return r?{key:r.key,bytes:r.bytes,sha256:r.sha256,etag:r.etag,verifiedAt:r.verified_at,release:r.release,proofHash:r.proof_hash,status:r.status}:null;}
  active(){return this.db.prepare("SELECT key FROM backups WHERE status='active'").all().map(r=>this.get(r.key));}
  add(value,proof){
    const r=record(value),proofHash=hash(proof),old=this.get(r.key);
    if(old){assert(old.status==='active'&&old.bytes===r.bytes&&old.sha256===r.sha256&&old.etag===r.etag&&old.verifiedAt===r.verifiedAt&&old.release===r.release,'RETENTION_EXISTING_RECORD_CHANGED');return old;}
    this.db.prepare("INSERT INTO backups VALUES(?,?,?,?,?,?,?,'active')").run(r.key,r.bytes,r.sha256,r.etag,r.verifiedAt,r.release,proofHash);return this.get(r.key);
  }
  assertSettled(){assert(this.db.prepare("SELECT count(*) n FROM deletions WHERE status!='confirmed_absent'").get().n===0&&this.db.prepare("SELECT count(*) n FROM plans WHERE status!='complete'").get().n===0,'RETENTION_RECONCILIATION_REQUIRED');}
  begin(plan){
    this.assertSettled();const id=hash(plan),old=this.db.prepare('SELECT status FROM plans WHERE id=?').get(id);if(old){assert(old.status==='complete','RETENTION_RECONCILIATION_REQUIRED');return id;}this.db.exec('BEGIN IMMEDIATE');
    try{this.db.prepare("INSERT INTO plans VALUES(?,?,?,'running')").run(id,new Date().toISOString(),JSON.stringify(plan));for(const r of plan.remove)this.db.prepare("INSERT INTO deletions VALUES(?,?,'planned')").run(r.key,id);this.db.exec('COMMIT');return id;}catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  deleting(key){assert(this.db.prepare("UPDATE deletions SET status='attempting' WHERE key=? AND status='planned'").run(key).changes===1,'RETENTION_DELETE_NOT_PLANNED');}
  deleted(key){this.db.exec('BEGIN IMMEDIATE');try{assert(this.db.prepare("UPDATE deletions SET status='confirmed_absent' WHERE key=? AND status='attempting'").run(key).changes===1,'RETENTION_DELETE_NOT_ATTEMPTED');assert(this.db.prepare("UPDATE backups SET status='deleted' WHERE key=? AND status='active'").run(key).changes===1,'RETENTION_DELETE_NOT_ACTIVE');this.db.exec('COMMIT');}catch(e){this.db.exec('ROLLBACK');throw e;}}
  complete(id){assert(this.db.prepare("SELECT count(*) n FROM deletions WHERE plan_id=? AND status!='confirmed_absent'").get(id).n===0,'RETENTION_DELETE_UNCONFIRMED');this.db.prepare("UPDATE plans SET status='complete' WHERE id=?").run(id);}
  close(){this.db?.close();this.db=null;}
}
export async function seedVerifiedLegacy(catalog,r2){
  catalog.assertSettled();
  for(const old of LEGACY){if(catalog.get(old.key))continue;const head=await r2.verify(old.key,old);catalog.add({...old,etag:head.ETag},{kind:'previous_real_download_and_restore',version:'20261015',key:old.key,sha256:old.sha256});}
}
export async function rotateVerifiedBackups({catalog,r2,result}){
  // This gate precedes every remote list or destructive operation.
  const newest=verifiedBackup(result);catalog.assertSettled();catalog.add(newest,result);
  const plan=planRetention(catalog.active(),newest.key),all=await r2.list();
  for(const r of catalog.active()){const found=all.find(x=>x.Key===r.key);assert(found&&found.Size===r.bytes&&found.ETag===r.etag,'RETENTION_REMOTE_CATALOG_MISMATCH');}
  // Verify all retained restore points remain remotely available before pruning.
  for(const key of plan.keep)await r2.verify(key,catalog.get(key));
  r2.requireDeleteBudget(plan.remove.length);
  const id=catalog.begin(plan),deleted=[];
  for(const r of plan.remove){catalog.deleting(r.key);await r2.deleteVerified(r);catalog.deleted(r.key);deleted.push(r.key);}
  const after=deleted.length?await r2.list():all;
  assert(plan.keep.every(key=>after.some(x=>x.Key===key))&&deleted.every(key=>!after.some(x=>x.Key===key)),'RETENTION_FINAL_INVENTORY_MISMATCH');
  catalog.complete(id);
  return {status:'PASS',policy:RETENTION_POLICY,anchor:plan.anchor,weekly:plan.weekly,monthly:plan.monthly,kept:plan.keep,deleted,unmanagedPreserved:after.filter(x=>!plan.keep.includes(x.Key)).map(x=>x.Key),storedBytes:after.reduce((n,x)=>n+x.Size,0),objects:after.length};
}
