import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {snapshot,encryptSnapshot,restoreSnapshot,inventory} from './backup.mjs';
import {R2Budget} from './r2-budget.mjs';
import {createR2Transport,r2Options} from './r2-transport.mjs';
import {BackupScheduler} from './scheduler.mjs';
import {RetentionCatalog,RETENTION_POLICY,seedVerifiedLegacy,rotateVerifiedBackups} from './retention.mjs';
import {createReferenceBackupRun,AUTOMATIC_REFERENCE_POLICY} from './automatic-run.mjs';
const BASE='/opt/render/project/src/briefs',CONTROL=BASE+'/molyvi-r2-access';
const SOURCE=BASE+'/molyvi-hosted-staging',ROOT=BASE+'/molyvi-r2-automatic';
const KEY=BASE+'/molyvi-r2-recovery/20261015-r1/recovery-key.bin';
const KEY_HASH='7a9e0977332bf8d1a1411790d2aff1a3963eb2a0828546ab3b6ed57a8b9b2852';
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const assert=(v,m)=>{if(!v)throw Error(m);};
async function writeProof(file,value){
  const h=await fs.open(file,'wx',0o600);try{await h.writeFile(JSON.stringify(value,null,2)+'\n');await h.sync();}finally{await h.close();}
  if(process.platform!=='win32'){const d=await fs.open(path.dirname(file),'r');try{await d.sync();}finally{await d.close();}}
}
async function privatePath(file){
  let current=path.parse(file).root;
  for(const bit of file.slice(current.length).split(path.sep).filter(Boolean)){current=path.join(current,bit);assert(!(await fs.lstat(current)).isSymbolicLink(),'BACKUP_PRIVATE_PATH_SYMLINK');}
}
export function validateReferenceBackupActivation(value){
  assert(value&&Object.keys(value).sort().join(',')==='enabled,format,schemaVersion,selection'&&value.enabled===true&&
    Object.entries(AUTOMATIC_REFERENCE_POLICY).every(([k,v])=>value[k]===v),'BACKUP_REFERENCE_ACTIVATION_INVALID');
  return Object.freeze({...value});
}
async function referenceActivation(){
  const file=CONTROL+'/reference-format.json';
  try{
    await privatePath(file);const stat=await fs.lstat(file);
    assert(stat.isFile()&&stat.nlink===1&&stat.size<=4096,'BACKUP_REFERENCE_ACTIVATION_INVALID');
    return validateReferenceBackupActivation(JSON.parse(await fs.readFile(file,'utf8')));
  }catch(e){if(e.code==='ENOENT')return null;throw e;}
}
export async function createAutomaticBackups({storage,release,withBackupResources,quietSnapshot,transport}){
  const configFile=CONTROL+'/automatic.json';
  let config;try{await privatePath(configFile);config=JSON.parse(await fs.readFile(configFile,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}
  assert(process.env.RENDER_SERVICE_ID==='srv-db7othjrjlhs73cg7lf0'&&path.resolve(storage)===SOURCE&&/^[a-f0-9]{40}$/.test(release),'BACKUP_SERVICE_SCOPE_REQUIRED');
  assert(Object.keys(config).sort().join(',')==='enabled,firstAt,notifyOwner'&&config.enabled===true&&typeof config.notifyOwner==='boolean','BACKUP_ACTIVATION_REQUIRED');
  assert(typeof withBackupResources==='function'&&typeof quietSnapshot==='function','BACKUP_RESOURCE_COORDINATION_REQUIRED');
  // Missing format opt-in preserves V1 encoding, schedule and limits.
  // Both formats now hold the application's full-phase production exclusion.
  // Malformed/present opt-in fails closed; it never silently falls back.
  const reference=await referenceActivation();
  await privatePath(KEY);assert(hash(await fs.readFile(KEY))===KEY_HASH,'BACKUP_INDEPENDENT_KEY_MISMATCH');
  await privatePath(CONTROL+'/r2-config.json');const access=JSON.parse(await fs.readFile(CONTROL+'/r2-config.json','utf8'));r2Options(access);
  assert(access.accountId==='59923a6c35aa9cd4f5be4c09e726f0df','BACKUP_ACCOUNT_SCOPE_REQUIRED');
  const require=createRequire(CONTROL+'/runtime/package.json');
  assert(require('@aws-sdk/client-s3/package.json').version==='3.1152.0','BACKUP_SDK_VERSION_REQUIRED');const sdk=require('@aws-sdk/client-s3');
  await fs.mkdir(ROOT,{recursive:true,mode:0o700});await privatePath(ROOT);
  let catalog;
  try{
    const file=CONTROL+'/retention.json';await privatePath(file);const policy=JSON.parse(await fs.readFile(file,'utf8'));
    assert(Object.keys(policy).sort().join(',')==='enabled,policy,schemaVersion'&&policy.schemaVersion===1&&policy.enabled===true&&policy.policy===RETENTION_POLICY,'RETENTION_ACTIVATION_INVALID');
    catalog=await new RetentionCatalog(ROOT+'/retention.sqlite').ready();
  }catch(e){if(e.code!=='ENOENT')throw e;}
  const budget=await new R2Budget(CONTROL+'/budget.sqlite').ready();
  const r2=await createR2Transport(access,{sdk,budget});
  const scheduler=await new BackupScheduler({file:ROOT+'/schedule.sqlite',firstAt:Date.parse(config.firstAt),
    notify:config.notifyOwner&&transport?({messageId,code})=>transport.send({messageId,payload:{to:'aioannidis@kooqie.com',kind:'backup_alert',subject:'Molyvi · Χρειάζεται έλεγχος αντιγράφων ασφαλείας',text:'Η αυτόματη δημιουργία αντιγράφων ασφαλείας σταμάτησε με ασφάλεια.\nΈνδειξη: '+code+'\nΤα όρια κόστους δεν αυξήθηκαν.\nΑπαιτείται έλεγχος πριν από νέα προσπάθεια.'}}):null,
    perform:reference?createReferenceBackupRun({source:SOURCE,root:ROOT,keyFile:KEY,keyHash:KEY_HASH,release,withBackupResources,quietSnapshot,r2,budget,catalog,seedLegacy:true}):runId=>withBackupResources(async()=>{
      const dir=ROOT+'/'+runId;assert(/^auto-[0-9]{14}-[a-f0-9]{8}$/.test(runId),'BACKUP_RUN_ID');
      if(catalog)await seedVerifiedLegacy(catalog,r2);
      // Local disk guard, before copying. No resize or paid resource is created.
      const sourceBytes=(await inventory(SOURCE,{skipSqliteSidecars:true})).reduce((n,e)=>n+e.bytes,0);
      const disk=await fs.statfs(ROOT);assert(disk.bavail*disk.bsize>=sourceBytes*4+512_000_000,'BACKUP_LOCAL_DISK_LIMIT');
      assert(sourceBytes<=512_000_000,'BACKUP_SOURCE_SIZE_LIMIT');
      const usage=budget.summary();assert(usage.requests+5<=200&&usage.uploadBytes+sourceBytes+1_000_000<=2_000_000_000&&usage.downloadBytes+sourceBytes+1_000_000<=2_000_000_000,'BACKUP_TRANSFER_BUDGET_STOP');
      await fs.mkdir(dir,{mode:0o700});let key;
      try{
        const manifest=await quietSnapshot(()=>snapshot({source:SOURCE,output:dir+'/snapshot',release}));
        key=await fs.readFile(KEY);assert(hash(key)===KEY_HASH,'BACKUP_INDEPENDENT_KEY_MISMATCH');
        const receipt=await encryptSnapshot({root:dir+'/snapshot',manifest,key,file:dir+'/service-backup.mlvb'});
        assert(receipt.bytes<=512_000_000,'BACKUP_ENCRYPTED_SIZE_LIMIT');
        const objectKey='snapshots/'+new Date().toISOString().slice(0,10)+'/'+runId+'/service-backup.mlvb';
        const upload=await r2.upload({file:dir+'/service-backup.mlvb',key:objectKey,receipt});
        const download=await r2.download({file:dir+'/downloaded.mlvb',key:objectKey,receipt});
        const restored=await restoreSnapshot({file:dir+'/downloaded.mlvb',key,output:dir+'/restored',expectedSha256:receipt.sha256});
        const result={status:'PASS',createdAt:new Date().toISOString(),runId,release,objectKey,receipt,upload,download,restore:restored.report,budget:budget.summary(),remoteDeletion:false};
        // A recoverable proof is durable before any rotation or deletion begins.
        await writeProof(dir+'/backup-verified.json',result);
        if(catalog){result.retention=await rotateVerifiedBackups({catalog,r2,result});result.remoteDeletion=result.retention.deleted.length>0;result.budget=budget.summary();}
        await writeProof(dir+'/receipt.json',result);
        // Only this fresh run's scratch children. Receipts and R2 objects remain.
        for(const name of ['snapshot','restored'])await fs.rm(path.join(dir,name),{recursive:true});
        for(const name of ['service-backup.mlvb','downloaded.mlvb'])await fs.unlink(path.join(dir,name));
        return result;
      }finally{key?.fill(0);}
    })
  }).ready();
  const stop=scheduler.stop.bind(scheduler);scheduler.stop=async()=>{await stop();r2.close();budget.close();catalog?.close();};return scheduler;
}

export async function reportBackupStartupFailure(transport){
  // A broken backup configuration must not take down login or silently disappear.
  // One durable alert attempt, including across restarts; no secret/error contents.
  try{
    const file=CONTROL+'/automatic.json';await privatePath(file);
    const c=JSON.parse(await fs.readFile(file,'utf8'));if(c.notifyOwner!==true||!transport)return;
    await fs.mkdir(ROOT,{recursive:true,mode:0o700});await privatePath(ROOT);
    const id=crypto.randomUUID(),marker=ROOT+'/startup-alert.json';
    await fs.writeFile(marker,JSON.stringify({messageId:id,status:'attempting'})+'\n',{flag:'wx',mode:0o600});
    await transport.send({messageId:id,payload:{to:'aioannidis@kooqie.com',kind:'backup_alert',subject:'Molyvi · Η εκκίνηση των αντιγράφων χρειάζεται έλεγχο',text:'Η εφαρμογή λειτουργεί, αλλά τα αυτόματα αντίγραφα ασφαλείας δεν μπόρεσαν να ενεργοποιηθούν. Χρειάζεται έλεγχος της ρύθμισης. Τα όρια κόστους δεν αυξήθηκαν.'}});
    await fs.writeFile(marker,JSON.stringify({messageId:id,status:'accepted'})+'\n',{mode:0o600});
  }catch{console.error('MOLYVI_BACKUP_STARTUP_ALERT_NOT_CONFIRMED');}
}
