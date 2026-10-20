// Read-only pre-start admission. A reviewed idle state is not a process lock:
// the caller must stop the old instance before the strict assertion is used.
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {inventory} from './r2-backup/backup.mjs';
import {canonicalJson} from '../lib/intake-store.mjs';

const sha=b=>crypto.createHash('sha256').update(b).digest('hex'),hash=v=>sha(canonicalJson(v));
const H=/^[a-f0-9]{64}$/,U=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const numeric=v=>typeof v==='string'&&/^[1-9][0-9]{0,24}$/.test(v),time=v=>typeof v==='string'&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
const check=(v,c)=>{if(!v)throw Object.assign(Error('MIGRATION_READINESS_'+c),{code:'MIGRATION_READINESS_'+c});};
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const exists=f=>fs.lstat(f).then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e;});
const WORKER_LOCKS=['.photo-review-worker.lock','.product-production-worker.lock','.service-production-worker.lock'].map(n=>'workspaces/'+n);
const ignored=f=>WORKER_LOCKS.some(n=>f===n+'/owner.json');
async function ordinary(file,directory=false){
 file=path.resolve(file);let at=path.parse(file).root;
 for(const bit of file.slice(at.length).split(path.sep).filter(Boolean)){at=path.join(at,bit);const s=await fs.lstat(at);check(!s.isSymbolicLink()&&(at!==file||directory?s.isDirectory():s.isFile()&&s.nlink===1),'UNSAFE_PATH');}
 const real=await fs.realpath(file);check(process.platform==='win32'?real.toLowerCase()===file.toLowerCase():real===file,'ALIASED_PATH');
}
async function bounded(file,max){
 await ordinary(file);const original=await fs.lstat(file),handle=await fs.open(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0));let raw,before;
 try{
  before=await handle.stat();check(original.dev===before.dev&&original.ino===before.ino&&original.ctimeMs===before.ctimeMs,'FILE_CHANGED');check(before.isFile()&&before.nlink===1&&before.size>0&&before.size<=max,'RECORD_LIMIT');raw=Buffer.alloc(before.size);let offset=0;
  while(offset<raw.length){const result=await handle.read(raw,offset,Math.min(65536,raw.length-offset),offset);check(result.bytesRead>0,'FILE_CHANGED');offset+=result.bytesRead;}
  const extra=Buffer.alloc(1);check((await handle.read(extra,0,1,offset)).bytesRead===0,'FILE_CHANGED');const after=await handle.stat();
  check(before.dev===after.dev&&before.ino===after.ino&&before.size===after.size&&before.mtimeMs===after.mtimeMs&&before.ctimeMs===after.ctimeMs&&after.nlink===1,'FILE_CHANGED');
 }finally{await handle.close();}
 await ordinary(file);const end=await fs.lstat(file);check(before.dev===end.dev&&before.ino===end.ino&&before.size===end.size&&before.mtimeMs===end.mtimeMs&&before.ctimeMs===end.ctimeMs,'FILE_CHANGED');return raw;
}
async function read(file,max=1024*1024){
 const raw=await bounded(file,max);return {value:JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw)),sha256:sha(raw)};
}
function database(file,block){
 const db=new DatabaseSync(file,{readOnly:true});try{
  check(same(db.prepare('PRAGMA integrity_check').all().map(r=>r.integrity_check),['ok']),'DATABASE_INTEGRITY');
  check(db.prepare('PRAGMA foreign_key_check').all().length===0,'DATABASE_FOREIGN_KEYS');
  const counts=(table,column)=>{const rows=db.prepare(`SELECT ${column} status,count(*) count FROM ${table} GROUP BY ${column} ORDER BY ${column} LIMIT 33`).all().map(r=>({...r}));check(rows.length<=32,'DATABASE_STATUS_LIMIT');return rows;};
  const mail=counts('mail_outbox','status'),executions=counts('adjustment_executions','state'),reviews=counts('adjustment_final_reviews','state');
  const allowed={mail:new Set(['sent','expired','superseded','failed']),executions:new Set(['planned','prepared']),reviews:new Set(['ready','delivered'])};
  for(const [name,rows]of Object.entries({mail,executions,reviews}))for(const row of rows)if(!allowed[name].has(row.status))block('DATABASE_UNSETTLED',`accounts/customers.sqlite:${name}`,row.status);
  return {integrity:'ok',foreignKeyViolations:0,mail,executions,reviews};
 }finally{db.close();}
}
async function scheduler(root,now,block){
 await ordinary(root,true);const file=path.join(root,'schedule.sqlite');await ordinary(file);
 for(const suffix of ['-wal','-journal'])if(await exists(file+suffix))block('SCHEDULER_SIDECAR','schedule.sqlite'+suffix,'unreviewed');
 const before=await bounded(file,16*1024*1024),db=new DatabaseSync(file,{readOnly:true});let rows;
 try{check(same(db.prepare('PRAGMA integrity_check').all().map(r=>r.integrity_check),['ok']),'SCHEDULER_INTEGRITY');check(db.prepare('SELECT coalesce(max(length(CAST(last_result AS BLOB))),0) n FROM schedule').get().n<=1024*1024,'SCHEDULER_RECORD_LIMIT');rows=db.prepare('SELECT id,next_at,status,run_id,last_result,error,alert_id,alert_status FROM schedule LIMIT 2').all().map(r=>({...r}));}finally{db.close();}
 check(rows.length===1&&rows[0].id===1,'SCHEDULER_SCHEMA');const row=rows[0];
 if(row.status!=='waiting'||row.error!==null||row.alert_id!==null||row.alert_status!==null)block('SCHEDULER_UNSETTLED','schedule.sqlite',row.status);
 if(!Number.isSafeInteger(row.next_at)||row.next_at<=now+15*60*1000)block('SCHEDULER_DUE_SOON','schedule.sqlite','less_than_15_minutes');
 const after=await bounded(file,16*1024*1024);check(before.equals(after),'SCHEDULER_CHANGED');
 // Preserve the result bytes by pin, but do not copy its payload into diagnostics.
 return {file:'schedule.sqlite',bytes:before.length,sha256:sha(before),status:row.status,nextAt:row.next_at,runId:row.run_id,lastResultHash:row.last_result===null?null:sha(row.last_result),error:row.error,alertStatus:row.alert_status};
}
async function chain(directory,initial,block,kind){
 await ordinary(directory,true);const names=(await fs.readdir(directory)).sort(),events=names.filter(n=>/^\d{6}\.json$/.test(n));
 const allowed=new Set(['head.json',...(kind==='journal'?['intent.json']:[]),...events]);
 check(events.length<=1600&&names.every(n=>allowed.has(n))&&names.includes('head.json'),'JOURNAL_CONTENT');
 let head=initial,sequence=0;const records=[];
 for(const name of events){check(name===`${String(sequence+1).padStart(6,'0')}.json`,'JOURNAL_SEQUENCE');const {eventHash,...body}=(await read(path.join(directory,name))).value;check(H.test(eventHash)&&eventHash===hash(body)&&body.previousHash===head&&body.sequence===sequence+1,'JOURNAL_CHAIN');head=eventHash;sequence++;records.push(body);}
 const saved=(await read(path.join(directory,'head.json'))).value;check(saved.eventHash===head&&saved.sequence===sequence,'JOURNAL_HEAD');
 return {head,sequence,records,intentHash:saved.intentHash};
}
// Equivalent receipt/visibility semantics to the ordinary installer reader,
// without its filesystem write lock, runtime creation, or provider callbacks.
function evidence(value){
 check(value&&typeof value.operatorId==='string'&&value.operatorId.length>0&&value.operatorId.length<=200&&!/[\x00-\x1f]/.test(value.operatorId)&&H.test(value.evidenceSha256)&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value.observedAt??'')&&Number.isFinite(Date.parse(value.observedAt))&&value.scopeConfirmed===true,'JOURNAL_EVIDENCE');
 return {operatorId:value.operatorId,evidenceSha256:value.evidenceSha256,observedAt:value.observedAt,scopeConfirmed:true,verification:'operator_attested_not_independent_remote_verification'};
}
function checkedReceipt(intent,states,step,value){
 check(value&&numeric(value.remoteId)&&value.payloadHash===step.payloadHash&&value.observed,'JOURNAL_RECEIPT');const e=step.expected,o=value.observed;let expected;
 if(step.kind==='catalog'){
  const {variants,...fields}=o,{variants:planned,...planFields}=e;check(same(fields,planFields)&&Array.isArray(variants)&&Array.isArray(planned)&&variants.length===planned.length,'JOURNAL_RECEIPT');
  for(let i=0;i<variants.length;i++){const {remoteId,...fields}=variants[i];check(numeric(remoteId)&&same(fields,planned[i]),'JOURNAL_RECEIPT');}
 }else if(step.kind==='media')expected={parentRemoteId:states.get(e.parentKey)?.receipt?.remoteId,position:e.position,sourceSha256:e.sourceSha256,alt:e.alt,loaded:true};
 else if(step.kind==='variant_media'){
  const parent=states.get(e.parentKey)?.receipt;check(parent&&value.remoteId===parent.remoteId&&Array.isArray(e.associations),'JOURNAL_RECEIPT');expected={parentRemoteId:parent.remoteId,associations:e.associations.map(a=>({variantRemoteId:parent.observed.variants.find(v=>v.localId===a.localId)?.remoteId,mediaRemoteId:states.get(a.mediaKey)?.receipt?.remoteId}))};
 }else if(step.kind==='collection')expected={title:e.title,handle:e.handle,productRemoteIds:e.productKeys.map(k=>states.get(k)?.receipt?.remoteId),channels:[]};
 else if(step.kind==='page')expected=e;
 else if(step.kind==='theme')expected={zipSha256:e.zipSha256,status:'Draft',liveThemeIdUnchanged:intent.liveThemeId};
 else check(false,'JOURNAL_STEP_KIND');
 if(expected)check(same(o,expected),'JOURNAL_RECEIPT');
 check(same(value,{remoteId:value.remoteId,payloadHash:value.payloadHash,observed:o,evidence:evidence(value.evidence)}),'JOURNAL_RECEIPT');
 const ids=(s,r)=>[{kind:s.kind,remoteId:r.remoteId},...(s.kind==='catalog'?r.observed.variants.map(v=>({kind:'variant',remoteId:v.remoteId})):[])];
 const reserved=[...intent.preexistingResources,{kind:'theme',remoteId:intent.liveThemeId}];for(const s of intent.steps)if(states.get(s.key)?.receipt)reserved.push(...ids(s,states.get(s.key).receipt));
 const seen=new Set(reserved.map(r=>r.kind+':'+r.remoteId));for(const r of ids(step,value)){const key=r.kind+':'+r.remoteId;check(!seen.has(key),'JOURNAL_REMOTE_ID');seen.add(key);}return value;
}
function visibilityScope(intent,states){
 check([...states.values()].every(s=>s.status==='succeeded'),'JOURNAL_VISIBILITY');const id=k=>states.get(k)?.receipt?.remoteId;
 return {targetStore:intent.targetStore,projectId:intent.projectId,intentHash:intent.intentHash,products:intent.steps.filter(s=>s.kind==='catalog').map(s=>id(s.key)),collection:id('collection'),pages:intent.steps.filter(s=>s.kind==='page').map(s=>id(s.key)),theme:id('theme'),liveThemeId:intent.liveThemeId};
}
async function settledInstaller(source,kind,projectId,configHash,block){
 check(U.test(projectId)&&['basic-installer','basic-prepared-installer'].includes(kind)&&H.test(configHash),'INSTALLER_SCOPE');
 const relative=`controlled-operations/${kind}/jobs/${projectId}`,directory=path.join(source,relative),record=await read(path.join(directory,'config.json')),c=record.value;
 check(record.sha256===configHash&&c.projectId===projectId&&H.test(c.intentHash)&&c.publicationAuthorized===false&&c.newChargesAuthorized===false&&c.identity?.targetStore==='molyvi-still-dev.myshopify.com','INSTALLER_CONFIG');
 const operations=await chain(path.join(directory,'operations'),hash(c),block,'operations');check(operations.intentHash===c.intentHash&&operations.records.every(e=>e.intentHash===c.intentHash),'INSTALLER_CHAIN_BINDING');
 check(time(c.preparedAt)&&time(c.deadlineAt),'OPERATIONS_TIME');let phase='prepared',lastObservedAt=c.preparedAt,waiting=null;const counters={graphQLRequests:0,mutations:0,stagedUploads:0,externalRequests:0};
 for(const event of operations.records){
  check(time(event.observedAt)&&Date.parse(event.observedAt)>=Date.parse(lastObservedAt)&&(event.type==='stop'||Date.parse(event.observedAt)<Date.parse(c.deadlineAt)),'OPERATIONS_TIME');lastObservedAt=event.observedAt;
  check(!['verified','stopped'].includes(phase),'OPERATIONS_TERMINAL');
  if(event.type==='install'){check(phase==='prepared','OPERATIONS_TRANSITION');phase='installing';}
  else if(event.type==='reserve'){
   check(['installing','rechecking'].includes(phase)&&['graphql','mutation','upload','external'].includes(event.kind),'OPERATIONS_TRANSITION');
   if(['graphql','mutation'].includes(event.kind))counters.graphQLRequests++;if(event.kind==='mutation')counters.mutations++;if(event.kind==='upload'){counters.stagedUploads++;counters.externalRequests++;}if(event.kind==='external')counters.externalRequests++;
   for(const [key,count]of Object.entries(counters))check(Number.isSafeInteger(c.limits?.[key])&&count<=c.limits[key],'OPERATIONS_LIMIT');
  }else if(event.type==='wait'){
   const w=event.waiting;check(['installing','rechecking'].includes(phase)&&numeric(w?.themeId)&&!['207379235153','208782819665'].includes(w.themeId)&&U.test(w.attemptId)&&time(w.nextCheckAt)&&time(w.deadlineAt)&&Date.parse(w.nextCheckAt)<=Date.parse(w.deadlineAt),'OPERATIONS_WAIT');
   if(waiting)check(waiting.themeId===w.themeId&&waiting.attemptId===w.attemptId&&waiting.deadlineAt===w.deadlineAt&&Date.parse(w.nextCheckAt)>Date.parse(waiting.nextCheckAt),'OPERATIONS_WAIT');waiting=w;phase='waiting';
  }else if(event.type==='recheck'){check(phase==='waiting'&&Date.parse(event.observedAt)>=Date.parse(waiting.nextCheckAt),'OPERATIONS_TRANSITION');phase='rechecking';}
  else if(event.type==='verify'){check(['installing','rechecking','waiting'].includes(phase),'OPERATIONS_TRANSITION');phase='verified';}
  else if(event.type==='stop'){check(typeof event.code==='string'&&/^[A-Z][A-Z0-9_]{2,99}$/.test(event.code),'OPERATIONS_STOP');phase='stopped';}
  else check(false,'OPERATIONS_EVENT');
 }
 const terminal=operations.records.at(-1)?.type??'prepared';if(phase!=='verified')block('ACTIVE_INSTALLER_UNSETTLED',relative,phase);
 const intent=(await read(path.join(directory,'journal','intent.json'),4*1024*1024)).value,{intentHash,...body}=intent;
 check(intentHash===c.intentHash&&hash(body)===intentHash&&intent.projectId===projectId&&intent.targetStore==='molyvi-still-dev.myshopify.com'&&Array.isArray(intent.steps)&&intent.steps.length>=10&&intent.steps.length<=64&&numeric(intent.liveThemeId)&&Array.isArray(intent.preexistingResources),'INSTALLER_INTENT');
 const seenSteps=new Set();for(const s of intent.steps){check(typeof s.key==='string'&&!seenSteps.has(s.key)&&['catalog','media','variant_media','collection','page','theme'].includes(s.kind)&&s.action===(s.kind==='variant_media'?'link_new_resources':'create')&&Array.isArray(s.dependsOn)&&s.dependsOn.every(k=>seenSteps.has(k))&&s.payloadHash===hash(s.expected),'INSTALLER_INTENT');seenSteps.add(s.key);}
 const journal=await chain(path.join(directory,'journal'),intentHash,block,'journal');check(journal.intentHash===intentHash&&journal.records.every(e=>e.intentHash===intentHash),'INSTALLER_CHAIN_BINDING');
 const states=new Map(intent.steps.map(s=>[s.key,{status:'pending'}]));check(states.size===intent.steps.length,'INSTALLER_STEPS');let visibility='not_started',visibilityBinding;
 for(const e of journal.records){
  if(e.type==='visibility_claim'){visibilityBinding=visibilityScope(intent,states);check(visibility==='not_started'&&same(e.scope,visibilityBinding)&&e.authorization?.scopeHash===hash(visibilityBinding)&&H.test(e.authorization.referenceSha256)&&e.authorization.temporaryOnly===true&&e.authorization.restoreRequired===true&&e.authorization.themePublishAuthorized===false,'JOURNAL_VISIBILITY');evidence(e.evidence);visibility='restoration_required';continue;}
  if(e.type==='restoration'){check(visibility==='restoration_required','JOURNAL_TRANSITION');const s=visibilityBinding,expected={products:s.products.map(remoteId=>({remoteId,status:'DRAFT',channels:[]})),collection:{remoteId:s.collection,channels:[]},pages:s.pages.map(remoteId=>({remoteId,visibility:'Hidden'})),theme:{remoteId:s.theme,status:'Draft'},liveThemeId:s.liveThemeId};check(same(e.observed,expected),'JOURNAL_RESTORATION');evidence(e.evidence);visibility='restored_operator_attested';continue;}
  const prior=states.get(e.key),step=intent.steps.find(s=>s.key===e.key);check(prior,'JOURNAL_STEP');
  if(e.type==='claim'){check(prior.status==='pending'&&U.test(e.attemptId)&&step.dependsOn.every(k=>states.get(k)?.status==='succeeded'),'JOURNAL_TRANSITION');states.set(e.key,{status:'claimed_outcome_unknown',attemptId:e.attemptId});}
  else if(['receipt','reconcile','block'].includes(e.type)){
   check(prior.status==='claimed_outcome_unknown'&&e.attemptId===prior.attemptId,'JOURNAL_TRANSITION');
   if(e.type==='block'){check(['confirmed_absent','needs_investigation'].includes(e.reason),'JOURNAL_BLOCK');evidence(e.evidence);states.set(e.key,{...prior,status:'blocked'});}
   else{const receipt=checkedReceipt(intent,states,step,e.receipt);if(e.type==='reconcile')evidence(e.reconciliationEvidence);states.set(e.key,{...prior,status:'succeeded',receipt});}
  }
  else check(false,'JOURNAL_EVENT');
 }
 if([...states.values()].some(s=>s.status!=='succeeded')||visibility==='restoration_required')block('ACTIVE_JOURNAL_UNSETTLED',relative,visibility==='restoration_required'?visibility:'incomplete_steps');
 return {kind,projectId,configSha256:configHash,intentHash,operationsHead:operations.head,journalHead:journal.head,total:states.size,succeeded:[...states.values()].filter(s=>s.status==='succeeded').length,visibility,terminal};
}
async function activeOperations(source,block){
 const operations=path.join(source,'controlled-operations'),result=[],legacy=path.join(operations,'basic-installer','activation.json'),pipeline=path.join(operations,'basic-pipeline','permit.json');
 if(await exists(legacy)){
  const a=(await read(legacy)).value;check(a.schemaVersion===1&&a.mode==='real_basic_draft_test','INSTALLER_ACTIVATION');
  check(U.test(a.projectId)&&U.test(a.jobId)&&H.test(a.packageSha256)&&H.test(a.receiverSha256),'INSTALLER_ACTIVATION');
  const config=(await read(path.join(operations,'basic-installer','jobs',a.projectId,'config.json'))).value;
  check(config.jobId===a.jobId&&config.bundleSha256===a.packageSha256,'INSTALLER_ACTIVATION');result.push(await settledInstaller(source,'basic-installer',a.projectId,a.configSha256,block));
 }
 if(await exists(pipeline)){
  const folder=path.dirname(pipeline),p=(await read(pipeline)).value,{permitHash,...permitBody}=p;
  check(H.test(permitHash)&&hash(permitBody)===permitHash&&U.test(p.projectId)&&p.targetStore==='molyvi-still-dev.myshopify.com'&&p.publicationAuthorized===false&&p.newChargesAuthorized===false,'PIPELINE_PERMIT');
  if(!await exists(path.join(folder,'completion.json'))){block('ACTIVE_PIPELINE_UNSETTLED','controlled-operations/basic-pipeline','completion_missing');return result;}
  const h=(await read(path.join(folder,'handoff.json'))).value,c=(await read(path.join(folder,'completion.json'))).value,{completionHash,...completedBody}=c;
  const expected=path.join(operations,'basic-prepared-installer','jobs',p.projectId,'config.json');
  check(H.test(completionHash)&&hash(completedBody)===completionHash&&h.permitHash===permitHash&&h.configFile===expected&&c.permitHash===permitHash&&c.configSha256===h.configSha256&&c.confirmationHash===h.confirmationHash&&c.sourceHash===p.sourceHash&&c.published===false,'PIPELINE_COMPLETION');
  const config=(await read(expected)).value;
  check(config.jobId===p.jobId&&config.authorizationSha256===p.authorizationSha256&&config.runtimeProfile==='hosted_prepared_basic_v1'&&config.confirmation?.projectId===p.projectId&&config.confirmation.ownerHash===hash(p.ownerId)&&config.confirmation.sourceHash===p.sourceHash&&hash(config.confirmation)===h.confirmationHash,'PIPELINE_CONFIG');
  const settled=await settledInstaller(source,'basic-prepared-installer',p.projectId,h.configSha256,block);
  check(c.intentHash===settled.intentHash&&settled.total>=14&&settled.total<=59&&c.counts?.total===settled.total&&c.counts?.succeeded===settled.succeeded&&Array.isArray(c.resources)&&c.resources.length===settled.total&&c.resources.filter(r=>r.kind==='theme').length===1&&c.resources.find(r=>r.kind==='theme').remoteId===c.themeId&&numeric(c.themeId)&&c.themeId!=='207379235153','PIPELINE_COUNTS');
  result.push({...settled,completionHash});
 }else if(!await exists(legacy)&&await exists(path.join(operations,'theme-rechecks','activation.json')))block('ACTIVE_THEME_RECHECK_REQUIRES_REVIEW','controlled-operations/theme-rechecks/activation.json','active');
 return result;
}

export async function collectReviewedReadiness({source,schedulerRoot,now=Date.now(),requireStopped=false}={}){
 check(typeof source==='string'&&path.isAbsolute(source)&&typeof schedulerRoot==='string'&&path.isAbsolute(schedulerRoot)&&Number.isSafeInteger(now),'ARGUMENTS');
 source=path.resolve(source);schedulerRoot=path.resolve(schedulerRoot);check(path.dirname(source)===path.dirname(schedulerRoot)&&path.basename(schedulerRoot)==='molyvi-r2-automatic','SCHEDULER_SCOPE');
 await ordinary(source,true);const blockers=[],block=(code,file,state)=>blockers.push({code,file,state});
 const observedWorkerLocks=[];
 for(const name of WORKER_LOCKS){const full=path.join(source,name);if(await exists(full)){await ordinary(full,true);check(same((await fs.readdir(full)).sort(),['owner.json']),'WORKER_LOCK_CONTENT');await ordinary(path.join(full,'owner.json'));observedWorkerLocks.push(name);if(requireStopped)block('WORKER_LOCK_REMAINS',name,'present');}}
 const before=await inventory(source),readinessPins=before.filter(e=>(e.file.startsWith('controlled-')||e.file.startsWith('workspaces/'))&&!ignored(e.file));
 check(readinessPins.length>0&&readinessPins.length<=10000,'INVENTORY_LIMIT');
 for(const p of readinessPins)if(/(^|\/)(?:\.writer-lock|[^/]+\.runner-lock)(\/|$)/.test(p.file)||/(^|\/)pending-[^/]+\.json$/.test(p.file)||p.file.endsWith('/head.next.json'))block('UNFINISHED_FILE',p.file,'present');
 let visited=0;async function lockDirectories(folder,prefix){if(!await exists(folder))return;await ordinary(folder,true);for(const e of await fs.readdir(folder,{withFileTypes:true})){check(++visited<=20000,'DIRECTORY_LIMIT');if(e.isDirectory()){const rel=prefix+'/'+e.name;if(e.name==='.writer-lock'||e.name.endsWith('.runner-lock'))block('UNFINISHED_DIRECTORY',rel,'present');else if(!WORKER_LOCKS.includes(rel))await lockDirectories(path.join(folder,e.name),rel);}}}
 await lockDirectories(path.join(source,'controlled-operations'),'controlled-operations');await lockDirectories(path.join(source,'workspaces'),'workspaces');
 const scope=(await read(path.join(source,'hosted-scope.json'))).value;
 const flags=['controlledLocalProEnabled','photoStartupOperationEnabled','operationsStartupEnabled','catalogExtensionEnabled','aiWorkersEnabled','realPaymentsEnabled','themeRecheckStartupBlocked','basicInstallerStartupBlocked','basicPipelineStartupBlocked'];
 for(const flag of flags)check(scope[flag]===undefined||typeof scope[flag]==='boolean','STARTUP_FLAG');
 const dbFile=path.join(source,'accounts/customers.sqlite');await ordinary(dbFile);const db=database(dbFile,block),workspaces=[],workspaceHashes=new Map();
 for(const pin of readinessPins.filter(p=>/^workspaces\/[a-f0-9-]+\/workspace\.json$/.test(p.file))){
  const p=(await read(path.join(source,pin.file),16*1024*1024)).value;check(U.test(p.id)&&pin.file===`workspaces/${p.id}/workspace.json`,'WORKSPACE_BINDING');
  workspaceHashes.set(p.id,hash(p));
  if(p.budget?.unknown===true||Number(p.budget?.reserved??0)!==0)block('WORKSPACE_BUDGET_UNSETTLED',pin.file,'unknown_or_reserved');
  const counts={};
  for(const [queue,jobs]of [['jobs',p.jobs],['productProductionQueue',p.productProductionQueue?.jobs],['photoReviewQueue',p.photoReviewQueue?.jobs]]){
   counts[queue]={};for(const job of Object.values(jobs??{})){check(job&&typeof job.status==='string','WORKSPACE_JOB');counts[queue][job.status]=(counts[queue][job.status]??0)+1;
    const allowed=queue==='jobs'?['waiting','queued','succeeded','failed','paused_budget','cancelled']:['queued','completed','cancelled'];
    if(!allowed.includes(job.status)||job.lease)block('WORKSPACE_JOB_UNSETTLED',pin.file,queue+':'+job.status);
   }
  }
  workspaces.push({projectId:p.id,queues:counts});
 }
 const activeInstallers=await activeOperations(source,block);
 // Only current request attempts are interpreted; old unactivated build folders
 // remain opaque pinned history. An attempt without a result is always ambiguous.
 for(const p of readinessPins.filter(p=>/^controlled-operations\/basic-preparation\/[^/]+\/[^/]+\/attempt\.json$/.test(p.file))){
  const dir=path.dirname(path.join(source,p.file)),a=(await read(path.join(dir,'attempt.json'))).value,result=path.join(dir,'result.json');
  check(U.test(a.projectId)&&U.test(a.requestId)&&H.test(a.sourceHash)&&p.file===`controlled-operations/basic-preparation/${a.projectId}/${a.requestId}/attempt.json`,'PREPARATION_SCOPE');
  if(workspaceHashes.get(a.projectId)!==a.sourceHash)continue;
  if(!await exists(result)){block('PREPARATION_ATTEMPT_UNKNOWN',p.file,'result_missing');continue;}
  const request=(await read(path.join(dir,'request.json'))).value,{recordHash:requestHash,...requestBody}=request,{recordHash:attemptHash,...attemptBody}=a;
  const r=(await read(result)).value,{recordHash,...body}=r;check(H.test(recordHash)&&hash(body)===recordHash&&H.test(attemptHash)&&hash(attemptBody)===attemptHash&&H.test(requestHash)&&hash(requestBody)===requestHash&&a.requestHash===requestHash&&r.attemptHash===attemptHash&&r.requestHash===a.requestHash&&r.projectId===a.projectId&&r.requestId===a.requestId&&['prepared','failed'].includes(r.state),'PREPARATION_RESULT');
 }
 const schedule=await scheduler(schedulerRoot,now,block),after=await inventory(source),afterPins=after.filter(e=>(e.file.startsWith('controlled-')||e.file.startsWith('workspaces/'))&&!ignored(e.file));
 check(same(readinessPins,afterPins),'INVENTORY_CHANGED');blockers.sort((a,b)=>canonicalJson(a).localeCompare(canonicalJson(b)));
 const readiness={schemaVersion:1,kind:'molyvi_canonical_readiness_v1',source,schedulerRoot,database:db,workspaces,activeInstallers,scheduler:schedule,startupFlags:Object.fromEntries(flags.map(f=>[f,scope[f]??null])),ready:blockers.length===0,blockers};
 return {readinessPins,readiness,observedWorkerLocks};
}

export async function assertReviewedReadiness({source,permit,now=Date.now()}){
 check(permit?.readiness?.schemaVersion===1&&permit.readiness.kind==='molyvi_canonical_readiness_v1'&&permit.readiness.source===path.resolve(source)&&permit.readiness.ready===true&&same(permit.readiness.blockers,[]),'REVIEW_REQUIRED');
 const actual=await collectReviewedReadiness({source,schedulerRoot:permit.readiness.schedulerRoot,now,requireStopped:true});
 check(actual.readiness.ready,'UNSETTLED_WORK');check(same(actual.readinessPins,permit.readinessPins)&&same(actual.readiness,permit.readiness),'REVIEW_CHANGED');return true;
}
