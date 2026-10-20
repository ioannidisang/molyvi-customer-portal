// Private LOCAL migration primitive. No CLI, provider, startup hook or activation.
// The trusted operator must keep the service persistently closed across errors
// and restarts. The existing backup coordinator alone is NOT that durable gate.
// Every original is retained. No unlink/rm, DB writes, overwrite or automatic retry.
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {prepareCanonicalDelivery} from '../lib/delivery-storage-prepare.mjs';
import {resolveDeliveryStorage,withDeliveryStorage} from '../lib/delivery-storage.mjs';

export const CANONICAL_MIGRATION_LIMITS=Object.freeze({sourceBytes:512_000_000,reserveBytes:12*1024*1024,
  diskHeadroom:512_000_000,files:100_000,metadataBytes:16*1024*1024,databaseRowBytes:4*1024*1024,chunkBytes:65536,deliveries:2});
const L=CANONICAL_MIGRATION_LIMITS,H=/^[a-f0-9]{64}$/,UUID=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const roots=new Set(['accounts','controlled-operations','controlled-photos','controlled-pro','deliveries','delivery-imports','gmail-journal','hosted-scope.json','mail','regeneration-import-1005-r1','workspaces']);
const dbName='accounts/customers.sqlite',dbFiles=new Set([dbName,dbName+'-wal',dbName+'-shm']);
const sha=b=>crypto.createHash('sha256').update(b).digest('hex'),json=v=>JSON.stringify(v);
const check=(v,c)=>{if(!v)throw Object.assign(Error(c),{code:c});};
const sig=s=>['dev','ino','size','mtimeNs','ctimeNs','nlink'].map(k=>s[k].toString()).join(':');
const exists=file=>fs.lstat(file).then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e;});
const keys=(v,k,c)=>check(v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===k.split(',').sort().join(','),c);
function scopeValue(v){keys(v,'serviceId,workspaceId','MIGRATION_SCOPE');for(const s of Object.values(v))check(typeof s==='string'&&/^[a-zA-Z0-9_-]{3,100}$/.test(s),'MIGRATION_SCOPE');return {serviceId:v.serviceId,workspaceId:v.workspaceId};}
function relative(v){
 check(typeof v==='string'&&v.length>0&&Buffer.byteLength(v)<=1024&&!/[\\:\x00-\x1f?#<>|"*]/.test(v)&&!path.isAbsolute(v),'MIGRATION_PATH');
 const bits=v.split('/');check(bits.length<=32&&bits.every(b=>b&&b!=='.'&&b!=='..'&&!/[. ]$/.test(b)&&!/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(b)),'MIGRATION_PATH');return v;
}
async function safe(file,directory=false){
 file=path.resolve(file);let at=path.parse(file).root;
 for(const bit of file.slice(at.length).split(path.sep).filter(Boolean)){
  at=path.join(at,bit);const s=await fs.lstat(at,{bigint:true});
  check(!s.isSymbolicLink()&&(at!==file||directory?s.isDirectory():s.isFile()&&s.nlink===1n),'MIGRATION_UNSAFE_PATH');
 }
 const real=await fs.realpath(file);check(process.platform==='win32'?real.toLowerCase()===file.toLowerCase():real===file,'MIGRATION_ALIAS');return file;
}
async function digest(file,{maximum=L.sourceBytes,read=false}={}){
 await safe(file);const before=await fs.lstat(file,{bigint:true});check(before.size>=0n&&before.size<=BigInt(maximum),'MIGRATION_FILE_LIMIT');
 const h=await fs.open(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0)),hash=crypto.createHash('sha256'),chunks=[];let bytes=0;
 try{
  check(sig(await h.stat({bigint:true}))===sig(before),'MIGRATION_FILE_CHANGED');
  while(bytes<Number(before.size)){
   const b=Buffer.alloc(Math.min(L.chunkBytes,Number(before.size)-bytes)),n=await h.read(b,0,b.length,bytes);
   check(n.bytesRead===b.length,'MIGRATION_FILE_CHANGED');bytes+=b.length;hash.update(b);if(read)chunks.push(b);
  }
  check((await h.read(Buffer.alloc(1),0,1,bytes)).bytesRead===0,'MIGRATION_FILE_CHANGED');await safe(file);
  check(sig(await h.stat({bigint:true}))===sig(before)&&sig(await fs.lstat(file,{bigint:true}))===sig(before),'MIGRATION_FILE_CHANGED');
  return {bytes,sha256:hash.digest('hex'),...(read?{raw:Buffer.concat(chunks)}:{})};
 }finally{await h.close();}
}
async function readJson(file,maximum=L.metadataBytes){const p=await digest(file,{maximum,read:true});return {...p,value:JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(p.raw))};}
async function syncDir(dir){if(process.platform!=='win32'){const h=await fs.open(dir,constants.O_RDONLY);try{await h.sync();}finally{await h.close();}}}
async function write(file,value){const raw=Buffer.from(json(value)+'\n');check(raw.length<=L.metadataBytes,'MIGRATION_METADATA_LIMIT');const h=await fs.open(file,'wx',0o600);try{await h.writeFile(raw);await h.sync();}finally{await h.close();}await syncDir(path.dirname(file));return sha(raw);}
async function inventory(root,{service=false}={}){
 await safe(root,true);const rows=[],seen=new Set();let total=0,metadataBytes=2;
 const add=row=>{metadataBytes+=Buffer.byteLength(json(row))+1;check(metadataBytes<=L.metadataBytes,'MIGRATION_METADATA_LIMIT');rows.push(row);};
 async function walk(prefix=''){
  const dir=path.join(root,prefix);await safe(dir,true);
  for await(const child of await fs.opendir(dir)){
   const file=relative(prefix?prefix+'/'+child.name:child.name),lower=file.toLowerCase();
   check(!seen.has(lower)&&rows.length<L.files,'MIGRATION_INVENTORY_LIMIT');seen.add(lower);
   if(service&&!prefix)check(roots.has(child.name),'MIGRATION_SERVICE_ROOT');
   const target=path.join(root,file);check(!child.isSymbolicLink(),'MIGRATION_UNSAFE_PATH');
   if(child.isDirectory()){add({file,kind:'directory'});await walk(file);}
   else {check(child.isFile(),'MIGRATION_UNSAFE_PATH');const p=await digest(target);total+=p.bytes;check(total<=L.sourceBytes,'MIGRATION_SOURCE_LIMIT');add({file,kind:'file',...p});}
  }
 }
 await walk();rows.sort((a,b)=>a.file<b.file?-1:1);check(Buffer.byteLength(json(rows))<=L.metadataBytes,'MIGRATION_METADATA_LIMIT');return {rows,bytes:total};
}
function database(file,identities){
 const db=new DatabaseSync(file,{readOnly:true});
 try{
  check(db.prepare('PRAGMA integrity_check').get().integrity_check==='ok'&&db.prepare('PRAGMA foreign_key_check').all().length===0,'MIGRATION_DATABASE_INVALID');
  const schemaBound=db.prepare('SELECT count(*) n,COALESCE(sum(length(CAST(type AS BLOB))+length(CAST(name AS BLOB))+length(CAST(tbl_name AS BLOB))+COALESCE(length(CAST(sql AS BLOB)),0)),0) bytes FROM sqlite_schema').get();
  check(schemaBound.n<=1024&&schemaBound.bytes<=L.metadataBytes,'MIGRATION_DATABASE_LIMIT');
  const schema=db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all(),tables=[];
  for(const {name}of schema.filter(r=>r.type==='table')){
   check(typeof name==='string'&&name.length<256&&tables.length<256,'MIGRATION_DATABASE_SCHEMA');const hash=crypto.createHash('sha256');let count=0;
   const quote=s=>'"'+s.replaceAll('"','""')+'"',table=quote(name),columns=db.prepare('PRAGMA table_info('+table+')').all();
   check(columns.length>0&&columns.length<=256&&columns.every(c=>typeof c.name==='string'&&c.name.length<256),'MIGRATION_DATABASE_SCHEMA');
   // SQLite computes byte lengths before JavaScript can materialize a large row.
   const rowBytes=columns.map(c=>'COALESCE(length(CAST('+quote(c.name)+' AS BLOB)),0)').join('+');
   check(!db.prepare('SELECT 1 FROM '+table+' WHERE '+rowBytes+'>? LIMIT 1').get(L.databaseRowBytes),'MIGRATION_DATABASE_ROW_LIMIT');
   const stmt=db.prepare('SELECT * FROM '+table+' ORDER BY rowid');stmt.setReadBigInts(true);
   for(const row of stmt.iterate()){
    const encoded=json(Object.fromEntries(Object.entries(row).map(([k,v])=>[k,typeof v==='bigint'?{integer:v.toString()}:v instanceof Uint8Array?{blob:Buffer.from(v).toString('base64')}:v])));
    check(Buffer.byteLength(encoded)<=L.metadataBytes&&++count<=1_000_000,'MIGRATION_DATABASE_LIMIT');hash.update(encoded+'\n');
   }
   tables.push({name,rows:count,sha256:hash.digest('hex')});
  }
  for(const d of identities){
   const row=db.prepare('SELECT project_id,manifest_hash,zip_hash FROM deliveries WHERE id=?').get(d.deliveryId),p=db.prepare('SELECT order_id FROM projects WHERE id=?').get(d.projectId);
   check(row&&row.project_id===d.projectId&&row.manifest_hash===d.manifestHash&&row.zip_hash===d.zipHash&&p?.order_id===d.orderId,'MIGRATION_DELIVERY_AUTHORITY');
  }
  return {schema,tables,userVersion:db.prepare('PRAGMA user_version').get().user_version};
 }finally{db.close();}
}
async function databaseState(source,identities){const file=path.join(source,dbName);await safe(file);return database(file,identities);}
function identitiesValue(value){
 check(Array.isArray(value)&&value.length===L.deliveries,'MIGRATION_EXACT_TWO_REQUIRED');
 const copied=value.map(v=>{
  keys(v,'deliveryId,manifestHash,zipHash,projectId,orderId','MIGRATION_IDENTITY');
  check(UUID.test(v.projectId)&&H.test(v.manifestHash)&&H.test(v.zipHash),'MIGRATION_IDENTITY');
  for(const k of ['deliveryId','orderId'])check(typeof v[k]==='string'&&v[k].length>0&&v[k].length<=200&&!/[\x00-\x1f]/.test(v[k]),'MIGRATION_IDENTITY');return {...v};
 });
 check(new Set(copied.map(v=>v.manifestHash)).size===2&&new Set(copied.map(v=>v.deliveryId)).size===2,'MIGRATION_DUPLICATE_DELIVERY');return copied;
}
function eligibleManifest(raw,d,original){
 const m=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));
 check(m?.schemaVersion===1&&m.kind==='molyvi_handoff_manifest'&&m.projectId===d.projectId&&m.serviceOrderId===d.orderId&&m.customerAccepted===false&&m.published===false&&Array.isArray(m.files),'MIGRATION_ORIGINAL_HANDOFF_REQUIRED');
 check(!['reviewId','previousDeliveryId','inheritedManifestHash','sourceExecutionId','sourceResultHash','revision'].some(k=>Object.hasOwn(m,k)),'MIGRATION_ORIGINAL_HANDOFF_REQUIRED');
 check(!m.files.some(e=>['inherited-resources.json','revision-review.json'].includes(e.file)),'MIGRATION_ORIGINAL_HANDOFF_REQUIRED');
 const expected=new Set(['delivery-manifest.json','Molyvi-Service-Delivery.zip']),dirs=new Set();
 for(const e of m.files){const file=relative(e.file);check(!expected.has(file),'MIGRATION_MANIFEST_CHANGED');expected.add(file);const bits=file.split('/');while(bits.length>1){bits.pop();dirs.add(bits.join('/'));}}
 equal(original.filter(r=>r.kind==='file').map(r=>r.file).sort(),[...expected].sort(),'MIGRATION_UNDECLARED_ORIGINAL');
 equal(original.filter(r=>r.kind==='directory').map(r=>r.file).sort(),[...dirs].sort(),'MIGRATION_UNDECLARED_ORIGINAL');
}
function withoutDb(rows){return rows.filter(r=>!dbFiles.has(r.file));}
function selected(file,ids){return ids.some(d=>file==='deliveries/'+d.manifestHash||file.startsWith('deliveries/'+d.manifestHash+'/'));}
function preserved(rows,ids){return withoutDb(rows).filter(r=>!selected(r.file,ids));}
const equal=(a,b,c)=>check(json(a)===json(b),c);
async function callbacks(args){
 check(typeof args.withExclusiveResources==='function'&&typeof args.assertExclusive==='function'&&typeof args.verifyApplication==='function','MIGRATION_OPERATOR_GATE_REQUIRED');
}
async function held(args){check(await args.assertExclusive()===true,'MIGRATION_EXCLUSIVITY_LOST');}
async function paths(source,output){
 check(typeof source==='string'&&typeof output==='string','MIGRATION_PATH');source=path.resolve(source);output=path.resolve(output);
 check(source!==output&&path.dirname(source)===path.dirname(output),'MIGRATION_SIBLING_OUTPUT_REQUIRED');
 await safe(source,true);await safe(path.dirname(output),true);
 check((await fs.stat(source,{bigint:true})).dev===(await fs.stat(path.dirname(output),{bigint:true})).dev,'MIGRATION_CROSS_DEVICE');return {source,output};
}
async function journal(output){
 const dir=path.join(output,'journal'),found=(await fs.readdir(dir)).sort();check(found.length<=64,'MIGRATION_JOURNAL_LIMIT');let previousHash=null;
 const events=[];
 for(let i=0;i<found.length;i++){
  check(found[i]===String(i).padStart(3,'0')+'.json','MIGRATION_JOURNAL_SEQUENCE');
  const p=await readJson(path.join(dir,found[i]),4096),r=p.value;
  keys(r,'schemaVersion,sequence,previousHash,event,index,planHash','MIGRATION_JOURNAL_FORMAT');
  check(r.schemaVersion===1&&r.sequence===i&&r.previousHash===previousHash&&H.test(r.planHash)&&['prepared','move_original_intent','move_original_done','install_intent','install_done','verified','failed','rollback_started','displace_intent','displace_done','restore_original_intent','restore_original_done','rolled_back'].includes(r.event)&&[null,0,1].includes(r.index),'MIGRATION_JOURNAL_FORMAT');
  previousHash=p.sha256;events.push(r);
 }
 return {events,previousHash};
}
async function append(output,planHash,event,index=null){
 const current=await journal(output);check(current.events.every(e=>e.planHash===planHash),'MIGRATION_PLAN_CHANGED');
 return write(path.join(output,'journal',String(current.events.length).padStart(3,'0')+'.json'),{schemaVersion:1,sequence:current.events.length,previousHash:current.previousHash,event,index,planHash});
}
async function move(from,to,args){
 await held(args);await safe(from,true);await safe(path.dirname(to),true);check(!await exists(to),'MIGRATION_RENAME_TARGET_EXISTS');
 check((await fs.stat(from,{bigint:true})).dev===(await fs.stat(path.dirname(to),{bigint:true})).dev,'MIGRATION_CROSS_DEVICE');
 // Trusted private filesystem + exclusive service boundary. Node has no portable
 // rename-no-replace syscall; the destination absence check is not an OS lock.
 await fs.rename(from,to);await syncDir(path.dirname(from));await syncDir(path.dirname(to));
}
async function verifyCanonical(root,d){
 const raw=(await digest(path.join(root,'delivery-manifest.json'),{maximum:1024*1024,read:true})).raw;
 const binding=await resolveDeliveryStorage({root,manifestRaw:raw,...d});check(binding,'MIGRATION_CANONICAL_MISSING');
 await withDeliveryStorage(binding,async reader=>{for(const e of reader.entries)await reader.digest(e.file,{bytes:e.bytes,sha256:e.sha256});});
}
async function applicationCheck(args,phase){await held(args);check(await args.verifyApplication({phase,source:args.source})===true,'MIGRATION_APPLICATION_READBACK');await held(args);}
async function verifySource(plan,expected){
 const current=await inventory(plan.source,{service:true});equal(withoutDb(current.rows),withoutDb(expected),'MIGRATION_SOURCE_CHANGED');
 equal(await databaseState(plan.source,plan.deliveries),plan.database,'MIGRATION_DATABASE_CHANGED');return current;
}

export async function migrateCanonicalDeliveries(input){
 await callbacks(input);const scope=scopeValue(input.scope),deliveries=identitiesValue(input.deliveries),p=await paths(input.source,input.output),args={...input,...p};
 check(!await exists(p.output),'MIGRATION_OUTPUT_EXISTS');
 let planHash=null,made=false;
 return input.withExclusiveResources(async()=>{
  try{
   await held(args);check(!await exists(p.output),'MIGRATION_OUTPUT_EXISTS');
   const before=await inventory(p.source,{service:true});check(before.bytes+L.reserveBytes<=L.sourceBytes,'MIGRATION_SOURCE_LIMIT');
   const db=await databaseState(p.source,deliveries);await applicationCheck(args,'before');
   const details=[];let required=L.diskHeadroom+L.reserveBytes;
   for(const d of deliveries){
    const root=path.join(p.source,'deliveries',d.manifestHash),raw=(await digest(path.join(root,'delivery-manifest.json'),{maximum:1024*1024,read:true})).raw;
    check(sha(raw)===d.manifestHash,'MIGRATION_MANIFEST_CHANGED');
    check(!await exists(path.join(root,'.delivery-storage-v1.json')),'MIGRATION_ALREADY_CANONICAL');
    const original=(await inventory(root)).rows;eligibleManifest(raw,d,original);
    const zip=(await fs.stat(path.join(root,'Molyvi-Service-Delivery.zip'))).size;check(zip>=22&&zip<=128*1024*1024,'MIGRATION_ZIP_LIMIT');
    required+=zip+raw.length+4096;details.push({d,root,raw,original});
   }
   const disk=await fs.statfs(path.dirname(p.output));check(disk.bavail*disk.bsize>=required,'MIGRATION_DISK_HEADROOM');
   await held(args);await fs.mkdir(p.output,{mode:0o700});made=true;
   for(const child of ['staged','originals','reverted','journal'])await fs.mkdir(path.join(p.output,child),{mode:0o700});
   // Persist the new rollback directory's own name in its existing parent before
   // any source can be moved beneath it. Child journal fsync alone is not enough.
   await syncDir(p.output);await syncDir(path.dirname(p.output));
   const pins=[];
   for(const {d,root,raw,original}of details){
    await held(args);const destination=path.join(p.output,'staged',d.manifestHash);
    const receipt=await prepareCanonicalDelivery({source:root,destination,manifestRaw:raw,...d});
    pins.push({identity:d,original,canonical:(await inventory(destination)).rows,receipt});
   }
   const plan={schemaVersion:1,format:'molyvi_canonical_migration_v1',scope,...p,deliveries,sourceInventory:before.rows,sourceBytes:before.bytes,database:db,pins};
   await verifySource(plan,before.rows);planHash=await write(path.join(p.output,'plan.json'),plan);await append(p.output,planHash,'prepared');
   const after=before.rows.filter(r=>!selected(r.file,deliveries));
   for(const pin of pins){after.push({file:'deliveries/'+pin.identity.manifestHash,kind:'directory'},...pin.canonical.map(r=>({...r,file:'deliveries/'+pin.identity.manifestHash+'/'+r.file})));}
   after.sort((a,b)=>a.file<b.file?-1:1);
   for(let i=0;i<deliveries.length;i++){
    const d=deliveries[i],from=path.join(p.source,'deliveries',d.manifestHash),original=path.join(p.output,'originals',d.manifestHash),staged=path.join(p.output,'staged',d.manifestHash);
    equal((await inventory(from)).rows,pins[i].original,'MIGRATION_SOURCE_CHANGED');equal((await inventory(staged)).rows,pins[i].canonical,'MIGRATION_STAGE_CHANGED');
    await append(p.output,planHash,'move_original_intent',i);await move(from,original,args);await append(p.output,planHash,'move_original_done',i);
    await append(p.output,planHash,'install_intent',i);await move(staged,from,args);await append(p.output,planHash,'install_done',i);
    await verifyCanonical(from,d);equal((await inventory(original)).rows,pins[i].original,'MIGRATION_ORIGINAL_CHANGED');
   }
   const final=await verifySource(plan,after);await applicationCheck(args,'after');await verifySource(plan,after);
   await append(p.output,planHash,'verified');
   return {status:'PASS_CANONICAL_MIGRATION',output:p.output,planHash,sourceBytesBefore:before.bytes,sourceBytesAfter:final.bytes,
    sourceBytesReduced:before.bytes-final.bytes,originalsRetained:true,originalBytesRetained:pins.reduce((n,p)=>n+p.original.reduce((m,e)=>m+(e.bytes??0),0),0),
    diskBytesReclaimed:0,databaseUnchanged:true,otherFilesUnchanged:true,providerCalls:0,activationReady:false,requiresMaintenance:false};
  }catch(error){
   if(made&&planHash)await append(p.output,planHash,'failed').catch(()=>{});
   error.migration={output:p.output,planHash,requiresMaintenance:true,originalsRetained:true};throw error;
  }
 });
}

export async function rollbackCanonicalDeliveryMigration(input){
 await callbacks(input);const scope=scopeValue(input.scope),p=await paths(input.source,input.output),args={...input,...p};
 check(H.test(input.planHash),'MIGRATION_PLAN_PIN_REQUIRED');await safe(p.output,true);
 return input.withExclusiveResources(async()=>{
  try{
   await held(args);const read=await readJson(path.join(p.output,'plan.json'));check(read.sha256===input.planHash,'MIGRATION_PLAN_CHANGED');const plan=read.value;
   keys(plan,'schemaVersion,format,scope,source,output,deliveries,sourceInventory,sourceBytes,database,pins','MIGRATION_PLAN_FORMAT');
   check(plan.schemaVersion===1&&plan.format==='molyvi_canonical_migration_v1'&&plan.source===p.source&&plan.output===p.output,'MIGRATION_PLAN_FORMAT');
   equal(plan.scope,scope,'MIGRATION_SCOPE');const ids=identitiesValue(plan.deliveries);check(plan.pins.length===2,'MIGRATION_PLAN_FORMAT');
   const j=await journal(p.output);check(j.events.length&&j.events[0].event==='prepared'&&j.events.every(e=>e.planHash===input.planHash)&&!j.events.some(e=>e.event==='rolled_back'),'MIGRATION_ROLLBACK_STATE');
   equal((await fs.readdir(p.output)).sort(),['journal','originals','plan.json','reverted','staged'],'MIGRATION_OUTPUT_CHANGED');
   const known=new Set(ids.map(d=>d.manifestHash));for(const dir of ['originals','staged','reverted'])check((await fs.readdir(path.join(p.output,dir))).every(n=>known.has(n)),'MIGRATION_OUTPUT_CHANGED');
   const states=[];
   for(let i=0;i<2;i++){
    const pin=plan.pins[i],d=ids[i];equal(pin.identity,d,'MIGRATION_PLAN_FORMAT');
    const locations={source:path.join(p.source,'deliveries',d.manifestHash),original:path.join(p.output,'originals',d.manifestHash),staged:path.join(p.output,'staged',d.manifestHash),reverted:path.join(p.output,'reverted',d.manifestHash)},present={};
    for(const [name,file]of Object.entries(locations))present[name]=await exists(file)?(await inventory(file)).rows:null;
    const original=(rows)=>rows&&json(rows)===json(pin.original),canonical=(rows)=>rows&&json(rows)===json(pin.canonical);let state;
    if(original(present.source)&&canonical(present.staged)&&!present.original&&!present.reverted)state='untouched';
    else if(!present.source&&original(present.original)&&canonical(present.staged)&&!present.reverted)state='gap';
    else if(canonical(present.source)&&original(present.original)&&!present.staged&&!present.reverted)state='installed';
    else if(!present.source&&original(present.original)&&!present.staged&&canonical(present.reverted))state='rollback_gap';
    else if(original(present.source)&&!present.original&&!present.staged&&canonical(present.reverted))state='reverted';
    check(state,'MIGRATION_AMBIGUOUS_RECOVERY');states.push({state,locations,pin});
   }
   const current=await inventory(p.source,{service:true});equal(preserved(current.rows,ids),preserved(plan.sourceInventory,ids),'MIGRATION_SOURCE_CHANGED');
   equal(await databaseState(p.source,ids),plan.database,'MIGRATION_DATABASE_CHANGED');await append(p.output,input.planHash,'rollback_started');
   for(let i=1;i>=0;i--){
    const s=states[i];if(s.state==='installed'){
     await append(p.output,input.planHash,'displace_intent',i);await move(s.locations.source,s.locations.reverted,args);await append(p.output,input.planHash,'displace_done',i);
    }
    if(['installed','gap','rollback_gap'].includes(s.state)){
     await append(p.output,input.planHash,'restore_original_intent',i);await move(s.locations.original,s.locations.source,args);await append(p.output,input.planHash,'restore_original_done',i);
    }
   }
   await verifySource(plan,plan.sourceInventory);await applicationCheck(args,'rolled_back');await verifySource(plan,plan.sourceInventory);await append(p.output,input.planHash,'rolled_back');
   return {status:'PASS_CANONICAL_ROLLBACK',output:p.output,planHash:input.planHash,originalsRestored:true,canonicalCopiesRetained:true,databaseUnchanged:true,providerCalls:0,requiresMaintenance:false};
  }catch(error){error.migration={output:p.output,planHash:input.planHash,requiresMaintenance:true,originalsRetained:true};throw error;}
 });
}

// Startup replay is read-only. The plan pin comes from the trusted gate receipt,
// not from this directory. Legitimate subsequent customers may change unrelated
// files and DB rows, so this checks only the completed migration's own bindings.
export async function verifyCompletedCanonicalMigration({source,output,scope,planHash,deliveries}){
 scope=scopeValue(scope);deliveries=identitiesValue(deliveries);const p=await paths(source,output);
 check(H.test(planHash),'MIGRATION_PLAN_PIN_REQUIRED');await safe(p.output,true);
 const read=await readJson(path.join(p.output,'plan.json'));check(read.sha256===planHash,'MIGRATION_PLAN_CHANGED');const plan=read.value;
 keys(plan,'schemaVersion,format,scope,source,output,deliveries,sourceInventory,sourceBytes,database,pins','MIGRATION_PLAN_FORMAT');
 check(plan.schemaVersion===1&&plan.format==='molyvi_canonical_migration_v1'&&plan.source===p.source&&plan.output===p.output&&Array.isArray(plan.pins)&&plan.pins.length===2,'MIGRATION_PLAN_FORMAT');
 equal(plan.scope,scope,'MIGRATION_SCOPE');equal(plan.deliveries,deliveries,'MIGRATION_DELIVERY_AUTHORITY');
 const j=await journal(p.output),sequence=[['prepared',null],...deliveries.flatMap((_,i)=>[['move_original_intent',i],['move_original_done',i],['install_intent',i],['install_done',i]]),['verified',null]];
 check(j.events.every(e=>e.planHash===planHash),'MIGRATION_PLAN_CHANGED');equal(j.events.map(e=>[e.event,e.index]),sequence,'MIGRATION_NOT_VERIFIED');
 equal((await fs.readdir(p.output)).sort(),['journal','originals','plan.json','reverted','staged'],'MIGRATION_OUTPUT_CHANGED');
 equal(await fs.readdir(path.join(p.output,'staged')),[],'MIGRATION_OUTPUT_CHANGED');equal(await fs.readdir(path.join(p.output,'reverted')),[],'MIGRATION_OUTPUT_CHANGED');
 equal((await fs.readdir(path.join(p.output,'originals'))).sort(),deliveries.map(d=>d.manifestHash).sort(),'MIGRATION_OUTPUT_CHANGED');
 const file=path.join(p.source,dbName);await safe(file);const db=new DatabaseSync(file,{readOnly:true});
 try{
  for(const d of deliveries){
   const row=db.prepare('SELECT project_id,manifest_hash,zip_hash FROM deliveries WHERE id=?').get(d.deliveryId),project=db.prepare('SELECT order_id FROM projects WHERE id=?').get(d.projectId);
   check(row&&row.project_id===d.projectId&&row.manifest_hash===d.manifestHash&&row.zip_hash===d.zipHash&&project?.order_id===d.orderId,'MIGRATION_DELIVERY_AUTHORITY');
  }
 }finally{db.close();}
 for(let i=0;i<2;i++){
  const d=deliveries[i],pin=plan.pins[i],target=path.join(p.source,'deliveries',d.manifestHash),original=path.join(p.output,'originals',d.manifestHash);
  equal(pin.identity,d,'MIGRATION_PLAN_FORMAT');equal((await inventory(target)).rows,pin.canonical,'MIGRATION_TARGET_CHANGED');
  equal((await inventory(original)).rows,pin.original,'MIGRATION_ORIGINAL_CHANGED');await verifyCanonical(target,d);
 }
 return true;
}
