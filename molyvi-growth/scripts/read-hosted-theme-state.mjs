// Read-only, local filesystem evidence. No app imports, credentials, network or file writes.
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';

const SERVICE='srv-db7othjrjlhs73cg7lf0';
const BASE='/opt/render/project/src/briefs';
const STORAGE=BASE+'/molyvi-hosted-staging';
const PROJECT='4923cd43-11b7-47ed-a912-1b06458a6557';
const CODE='/opt/render/project/src/molyvi-growth/operations/r2-backup';
const MAX_SCAN_BYTES=768_000_000,MAX_FILES=20_000,MAX_FILE_BYTES=512_000_000;
const MAX_DB_ROWS=50_000,MAX_DB_BYTES=32_000_000;
const STABLE_TABLES=Object.freeze(['accounts','projects','deliveries','reviews','payment_links','delivery_feedback','feedback_operator_grants','feedback_replies','adjustment_proposals','adjustment_approvals','adjustment_executions','adjustment_final_reviews','adjustment_release_members']);
const VOLATILE_TABLES=Object.freeze(['codes','sessions','attempts','audit','mail_outbox','code_requests']);
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const fail=code=>{throw Object.assign(new Error(code),{safeCode:code});};
const need=(value,code)=>{if(!value)fail(code);};
const canonical=value=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':value!==null&&typeof value==='object'?'{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}':JSON.stringify(value);
const digest=value=>sha(canonical(value));
const iso=value=>Number.isSafeInteger(value)&&value>0?new Date(value).toISOString():null;
const safeCode=value=>value===null?null:typeof value==='string'&&/^[A-Z0-9_]{1,100}$/.test(value)?value:'REDACTED_UNRECOGNIZED_VALUE';
const identity=s=>[s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].map(String).join(':');
const timebox=()=>({deadline:Date.now()+120_000,bytes:0,files:0});
const withinTime=budget=>need(Date.now()<=budget.deadline,'READ_TIMEOUT');

async function safePath(file,{directory=false}={}){
  const absolute=path.resolve(file),root=path.parse(absolute).root;
  let current=root;
  for(const part of absolute.slice(root.length).split(path.sep).filter(Boolean)){
    current=path.join(current,part);const st=await fs.lstat(current);
    need(!st.isSymbolicLink(),'SYMLINK_REFUSED');
    need(current===absolute?!directory||st.isDirectory():st.isDirectory(),'PATH_TYPE_REFUSED');
  }
  need(await fs.realpath(absolute)===absolute,'REALPATH_MISMATCH');
  return absolute;
}

export async function hashOrdinaryFile(file,budget=timebox(),limit=MAX_FILE_BYTES){
  withinTime(budget);await safePath(file);
  const before=await fs.lstat(file,{bigint:true});
  need(before.isFile()&&!before.isSymbolicLink()&&before.size>=0n&&before.size<=BigInt(limit),'FILE_LIMIT_OR_TYPE');
  need(++budget.files<=MAX_FILES&&budget.bytes+Number(before.size)<=MAX_SCAN_BYTES,'SCAN_LIMIT');
  const handle=await fs.open(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
  try{
    need(identity(await handle.stat({bigint:true}))===identity(before),'FILE_CHANGED_BEFORE_READ');
    const hash=crypto.createHash('sha256');let size=0;
    for await(const chunk of handle.createReadStream({autoClose:false,highWaterMark:128*1024})){
      withinTime(budget);size+=chunk.length;need(size<=limit&&budget.bytes+size<=MAX_SCAN_BYTES,'SCAN_LIMIT');hash.update(chunk);
    }
    need(BigInt(size)===before.size&&identity(await handle.stat({bigint:true}))===identity(before),'FILE_CHANGED_DURING_READ');
    need(identity(await fs.lstat(file,{bigint:true}))===identity(before),'FILE_REPLACED_DURING_READ');
    budget.bytes+=size;return {bytes:size,sha256:hash.digest('hex'),identity:identity(before)};
  }finally{await handle.close();}
}

export async function hashTree(root,budget=timebox()){
  await safePath(root,{directory:true});const files=[],directories=[];
  async function walk(directory){
    withinTime(budget);const entries=(await fs.readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);
    const names=entries.map(e=>[e.name,e.isDirectory()?'directory':e.isFile()?'file':'other']);directories.push({directory,names});
    for(const e of entries){
      need(!e.isSymbolicLink()&&(e.isDirectory()||e.isFile()),'TREE_ENTRY_REFUSED');
      const file=path.join(directory,e.name);
      if(e.isDirectory())await walk(file);
      else{
        // These volatile SQLite sidecars are not application payloads.
        need(!/\.sqlite(?:-wal|-shm|-journal)?$/.test(e.name),'DATABASE_UNEXPECTED_IN_PAYLOAD_TREE');
        const result=await hashOrdinaryFile(file,budget),relative=path.relative(root,file).split(path.sep).join('/');
        files.push({file,relative,...result});
      }
    }
  }
  await walk(root);
  for(const row of files){withinTime(budget);need(identity(await fs.lstat(row.file,{bigint:true}))===row.identity,'TREE_CHANGED_DURING_SCAN');}
  for(const row of directories){
    const current=(await fs.readdir(row.directory,{withFileTypes:true})).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0).map(e=>[e.name,e.isDirectory()?'directory':e.isFile()?'file':'other']);
    need(canonical(current)===canonical(row.names),'TREE_INVENTORY_CHANGED');
  }
  const redacted=files.map(row=>({pathSha256:sha(row.relative),bytes:row.bytes,sha256:row.sha256}));
  return {files:redacted.length,bytes:redacted.reduce((n,row)=>n+row.bytes,0),manifestSha256:digest(redacted),entries:redacted};
}

async function safeJson(file,budget){
  const proof=await hashOrdinaryFile(file,budget,64*1024),bytes=await fs.readFile(file);
  need(sha(bytes)===proof.sha256,'JSON_CHANGED');
  let value;try{value=JSON.parse(bytes.toString('utf8'));}catch{fail('JSON_INVALID');}
  need(value&&typeof value==='object'&&!Array.isArray(value),'JSON_OBJECT_REQUIRED');
  return {value,file:{bytes:proof.bytes,sha256:proof.sha256}};
}

const sqlIdentifier=value=>{need(/^[a-z][a-z0-9_]*$/.test(value),'TABLE_NAME_REFUSED');return '"'+value+'"';};
function cell(value){
  if(value===null)return ['null'];
  if(typeof value==='bigint')return ['integer',String(value)];
  if(typeof value==='number'){need(Number.isFinite(value),'DB_NONFINITE_VALUE');return ['real',String(value)];}
  if(typeof value==='string')return ['text',value];
  if(value instanceof Uint8Array)return ['blob',value.length,sha(value)];
  fail('DB_VALUE_TYPE_REFUSED');
}
function tableSummary(db,table,budget){
  const statement=db.prepare('SELECT * FROM '+sqlIdentifier(table));statement.setReadBigInts(true);
  const rows=[];let bytes=0;
  for(const row of statement.iterate()){
    withinTime(budget);need(rows.length<MAX_DB_ROWS,'DB_ROWS_LIMIT');
    const serialized=canonical(Object.keys(row).sort().map(k=>[k,cell(row[k])]));
    bytes+=Buffer.byteLength(serialized);need(bytes<=MAX_DB_BYTES,'DB_BYTES_LIMIT');rows.push(sha(serialized));
  }
  rows.sort();return {rows:rows.length,sha256:digest(rows)};
}
export async function readDatabase(file,allowedTables,volatileTables=[],extra=()=>({}),budget=timebox()){
  await safePath(file);const stat=await fs.lstat(file);need(stat.isFile()&&stat.size<=64_000_000,'DB_FILE_LIMIT');
  // SQLite can consult existing WAL/SHM itself. Validate those paths without
  // copying, checkpointing, hashing or printing their volatile contents.
  const header=Buffer.alloc(100),handle=await fs.open(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
  try{need((await handle.read(header,0,100,0)).bytesRead===100&&header.subarray(0,16).toString('binary')==='SQLite format 3\u0000','DB_HEADER_INVALID');}finally{await handle.close();}
  const walMode=header[18]===2||header[19]===2;
  for(const suffix of ['-wal','-shm','-journal']){
    try{await safePath(file+suffix);need((await fs.lstat(file+suffix)).isFile(),'DB_SIDECAR_TYPE');}
    catch(error){if(error.code!=='ENOENT')throw error;need(!walMode||suffix==='-journal','LIVE_WAL_SIDECARS_REQUIRED');}
  }
  const db=new DatabaseSync(file,{readOnly:true,enableExtensions:false});
  try{
    // BEGIN holds one read snapshot. No table creation, checkpoint, journal mode or app constructor.
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=5000; BEGIN;');
    const schema=db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    need(schema.length<=64,'DB_SCHEMA_LIMIT');
    const names=schema.map(r=>r.name),known=new Set([...allowedTables,...volatileTables]);
    need(names.every(n=>known.has(n)),'DB_UNREVIEWED_TABLE');
    const stable={},volatileCounts={};
    for(const table of allowedTables)stable[table]=names.includes(table)?tableSummary(db,table,budget):{present:false};
    for(const table of volatileTables)if(names.includes(table))volatileCounts[table]=db.prepare('SELECT count(*) AS n FROM '+sqlIdentifier(table)).get().n;
    const result={schemaSha256:digest(schema),stable,stableSha256:digest(stable),volatileCounts,...extra(db)};
    db.exec('ROLLBACK;');return result;
  }finally{db.close();}
}

export async function collectHostedState(){
  need(process.platform==='linux'&&process.env.RENDER_SERVICE_ID===SERVICE,'EXACT_RENDER_SERVICE_REQUIRED');
  need(/^[a-f0-9]{40}$/.test(process.env.RENDER_GIT_COMMIT??''),'RELEASE_COMMIT_REQUIRED');
  need(process.env.MOLYVI_PRIVATE_STORAGE===STORAGE,'EXACT_STORAGE_REQUIRED');
  const budget=timebox(),startedAt=new Date().toISOString();
  const workspaces=await hashTree(STORAGE+'/workspaces',budget),deliveries=await hashTree(STORAGE+'/deliveries',budget);
  const protectedWorkspace=await hashOrdinaryFile(STORAGE+'/workspaces/'+PROJECT+'/workspace.json',budget,16_000_000);
  const accounts=await readDatabase(STORAGE+'/accounts/customers.sqlite',STABLE_TABLES,VOLATILE_TABLES,db=>({
    protectedProject:{id:PROJECT,exists:db.prepare('SELECT count(*) AS n FROM projects WHERE id=?').get(PROJECT).n===1,
      deliveries:db.prepare('SELECT count(*) AS n FROM deliveries WHERE project_id=?').get(PROJECT).n}
  }),budget);
  const scope=await safeJson(STORAGE+'/hosted-scope.json',budget),scopeFlags={};
  for(const key of ['realEmailEnabled','testPaymentsEnabled','controlledLocalProEnabled','photoStartupOperationEnabled','operationsStartupEnabled','catalogExtensionEnabled','aiWorkersEnabled','realPaymentsEnabled','cloudArchiveActive','themeRecheckProbeConfigured','themeRecheckStartupBlocked','shopifyInstallerWorkerEnabled']){
    if(Object.hasOwn(scope.value,key)){need(typeof scope.value[key]==='boolean','SCOPE_FLAG_TYPE');scopeFlags[key]=scope.value[key];}
  }
  need(scope.value.mode==='hosted_staging','SCOPE_MODE_REQUIRED');
  const backup={files:{},config:{},databases:{},moduleHashes:{}};
  for(const name of ['automatic.json','retention.json']){
    const item=await safeJson(BASE+'/molyvi-r2-access/'+name,budget);backup.files[name]=item.file;
    if(name==='automatic.json'){
      need(Object.keys(item.value).sort().join(',')==='enabled,firstAt,notifyOwner'&&typeof item.value.enabled==='boolean'&&typeof item.value.notifyOwner==='boolean'&&Number.isFinite(Date.parse(item.value.firstAt)),'AUTOMATIC_CONFIG_INVALID');
      backup.config.automatic={enabled:item.value.enabled,firstAt:new Date(item.value.firstAt).toISOString(),notifyOwner:item.value.notifyOwner};
    }else{
      need(Object.keys(item.value).sort().join(',')==='enabled,policy,schemaVersion'&&item.value.schemaVersion===1&&typeof item.value.enabled==='boolean'&&item.value.policy==='four-weekly-three-monthly-v1','RETENTION_CONFIG_INVALID');backup.config.retention=item.value;
    }
  }
  const dbSpecs=[
    ['budget',BASE+'/molyvi-r2-access/budget.sqlite',['reservations'],db=>({totals:db.prepare('SELECT count(*) reservations,COALESCE(sum(requests),0) requests,COALESCE(sum(upload_bytes),0) uploadBytes,COALESCE(sum(download_bytes),0) downloadBytes FROM reservations').get()})],
    ['schedule',BASE+'/molyvi-r2-automatic/schedule.sqlite',['schedule'],db=>{
      const row=db.prepare('SELECT * FROM schedule WHERE id=1').get();need(row&&['waiting','running','paused'].includes(row.status),'SCHEDULE_INVALID');
      return {summary:{status:row.status,nextAt:iso(row.next_at),error:safeCode(row.error),alertStatus:row.alert_status===null?null:['pending','attempting','accepted','failed_or_unknown'].includes(row.alert_status)?row.alert_status:'REDACTED',lastResultSha256:row.last_result===null?null:sha(row.last_result)}};
    }],
    ['retention',BASE+'/molyvi-r2-automatic/retention.sqlite',['backups','plans','deletions'],db=>({totals:db.prepare("SELECT count(*) objects,COALESCE(sum(bytes),0) storedBytes FROM backups WHERE status='active'").get()})]
  ];
  for(const [name,file,tables,extra]of dbSpecs){
    const before=await hashOrdinaryFile(file,budget,64_000_000);backup.databases[name]=await readDatabase(file,tables,[],extra,budget);
    const after=await hashOrdinaryFile(file,budget,64_000_000);need(before.sha256===after.sha256,'BACKUP_DB_CHANGED_DURING_READ');
    backup.files[name+'.sqlite']={bytes:after.bytes,sha256:after.sha256};
  }
  for(const name of ['backup.mjs','automatic.mjs','r2-budget.mjs','scheduler.mjs','retention.mjs']){
    const result=await hashOrdinaryFile(CODE+'/'+name,budget,256_000);backup.moduleHashes[name]=result.sha256;
  }
  const flags={};
  for(const key of ['MOLYVI_HOSTED_ENABLED','MOLYVI_REAL_EMAIL_ENABLED','MOLYVI_PAYMENT_RECEIVER_ENABLED','MOLYVI_AI_WORKERS_ENABLED','MOLYVI_BACKUP_UPLOAD_ENABLED','MOLYVI_HOSTED_TEST_PAYMENTS_ENABLED','MOLYVI_HOSTED_CONTROLLED_PRO_ENABLED','MOLYVI_HOSTED_PHOTO_IMPORT_ENABLED','MOLYVI_HOSTED_OPERATIONS_ENABLED','MOLYVI_HOSTED_CATALOG_EXTENSION_ENABLED','MOLYVI_HOSTED_THEME_RECHECKS_ENABLED']){
    const value=process.env[key];need(value===undefined||value==='true'||value==='false','ENV_FLAG_VALUE_REFUSED');flags[key]=value??null;
  }
  return {schemaVersion:1,status:'READ_ONLY_STATE_CAPTURED',startedAt,finishedAt:new Date().toISOString(),service:{id:SERVICE,release:process.env.RENDER_GIT_COMMIT,node:process.versions.node,platform:process.platform,storage:STORAGE,flags},workspaces,deliveries,
    protected1005:{projectId:PROJECT,workspaceSha256:protectedWorkspace.sha256,workspaceBytes:protectedWorkspace.bytes},accounts,
    hostedScope:{file:scope.file,mode:'hosted_staging',flags:scopeFlags},backup,
    declaredExistingLimits:{sourceAndObjectBytes:512_000_000,requests31days:200,uploadBytes31days:2_000_000_000,downloadBytes31days:2_000_000_000,storedBytes:2_000_000_000,objects:20,weekly:4,monthly:3},
    inspection:{hashedFileBytes:budget.bytes,hashedFileReads:budget.files,fileWriteCalls:0,databaseWriteStatements:0,databaseOpenedReadOnly:true,networkRequests:0,credentialsRead:false,rawCustomerValuesEmitted:false,pathNamesRedacted:true,volatileAccountTablesExcludedFromStableHash:VOLATILE_TABLES,sqliteSidecarsHashed:false,sqliteReadViewMayIncludeWal:true,sqliteMayUseExistingSharedMemory:true,globallyAtomicSnapshot:false,backupLimitsChanged:false,planVerifiedByThisScript:false}};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    need(process.argv.length===3&&process.argv[2]==='--read-only','READ_ONLY_ARGUMENT_REQUIRED');
    console.log(JSON.stringify(await collectHostedState()));
  }catch(error){console.log(JSON.stringify({status:'STOP',code:error?.safeCode??'READ_ONLY_STATE_FAILED',fileWrites:0,networkRequests:0}));process.exitCode=1;}
}
