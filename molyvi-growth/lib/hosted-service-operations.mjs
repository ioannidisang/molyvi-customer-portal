import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {PRIVATE_ROOT,canonicalJson,IntakeError} from './intake-store.mjs';
import {ordinaryFile} from './service-handoff.mjs';
import {CONTROLLED_PRO_PROJECT,CONTROLLED_PRO_ORDER} from './hosted-controlled-pro.mjs';
import {createServiceProductionQueue,serviceProductionEligible} from './service-production-queue.mjs';
import {SERVICE_OPERATION_TASK_IDS,readServiceOperation} from './service-operations.mjs';

const digest=x=>crypto.createHash('sha256').update(canonicalJson(x)).digest('hex');
const fail=code=>{throw new IntakeError(code,503);};
const exact=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).sort().join(',')===[...keys].sort().join(',');
const hash=x=>typeof x==='string'&&/^[a-f\d]{64}$/.test(x);
export function hostedOperationsPreservedHash(p){
  return digest(Object.fromEntries(['order','servicePurchase','assets','generatedAssets','productTasks','productGalleries','productTexts','photoReviews','productProductionQueue','creditLedger'].map(k=>[k,p[k]??null])));
}
export function validateHostedOperationsConfig(c){
  if(!exact(c,['scope','runId','createdAt','expiresAt','projectId','orderId','businessHash','approvedBrandHash','preservedHash','submissions'])||c.scope!=='molyvi_hosted_service_operations_v1'||
    !/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(c.runId??'')||c.projectId!==CONTROLLED_PRO_PROJECT||c.orderId!==CONTROLLED_PRO_ORDER||
    !hash(c.businessHash)||!hash(c.approvedBrandHash)||!hash(c.preservedHash)||!exact(c.submissions,SERVICE_OPERATION_TASK_IDS)||Object.values(c.submissions).some(v=>!hash(v)))fail('HOSTED_OPERATIONS_SCOPE_INVALID');
  const start=Date.parse(c.createdAt),end=Date.parse(c.expiresAt);
  if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start||end-start>1200000||start>Date.now()+60000||end<=Date.now())fail('HOSTED_OPERATIONS_WINDOW_INVALID');
  return structuredClone(c);
}
async function privateDirectory(folder,{create=false}={}){
  if(create)await fs.mkdir(folder,{recursive:true,mode:0o700});
  const stat=await fs.lstat(folder),real=await fs.realpath(folder),base=await fs.realpath(PRIVATE_ROOT),rel=path.relative(base,real);
  if(!stat.isDirectory()||stat.isSymbolicLink()||!rel||rel.startsWith('..')||path.isAbsolute(rel))fail('HOSTED_OPERATIONS_PRIVATE_DIRECTORY_REQUIRED');return real;
}
async function privateJson(folder,file){
  const stat=await fs.lstat(path.join(folder,file));
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>65536||process.platform!=='win32'&&(stat.mode&0o077))fail('HOSTED_OPERATIONS_PRIVATE_FILE_REQUIRED');
  return JSON.parse(await ordinaryFile(folder,file));
}
export async function loadHostedOperationsConfig({enabled=false,folder=path.join(PRIVATE_ROOT,'molyvi-hosted-operations')}={}){
  return enabled?validateHostedOperationsConfig(await privateJson(await privateDirectory(folder),'config.json')):null;
}

// Before HTTP listeners: only deterministic work from six already-final tasks.
// Never submits answers, calls a model, activates payments or writes to Shopify.
export async function runHostedOperations({config,store,accounts,storage}={}){
  const c=validateHostedOperationsConfig(config),p=JSON.parse(await ordinaryFile(await store.directory(c.projectId),'workspace.json'));
  const link=accounts.db.prepare('SELECT p.status,p.owner_id,a.email FROM payment_links p JOIN accounts a ON a.id=p.account_id WHERE p.project_id=?').get(c.projectId);
  if(!serviceProductionEligible(p)||p.order.id!==c.orderId||p.servicePurchase.intentScope!=='molyvi_hosted_test_v1'||link?.status!=='granted'||link.owner_id!==p.ownerId||link.email!=='aioannidis@kooqie.com'||
    p.tasks.business.submission?.hash!==c.businessHash||p.tasks.branding.approvedHash!==c.approvedBrandHash||hostedOperationsPreservedHash(p)!==c.preservedHash||
    SERVICE_OPERATION_TASK_IDS.some(id=>p.tasks[id].submission?.hash!==c.submissions[id]))fail('HOSTED_OPERATIONS_SOURCE_NOT_AUTHORIZED');
  const folder=await privateDirectory(path.join(storage,c.runId),{create:true}),business=canonicalJson(p.jobs[c.businessHash+':work']),tasks=canonicalJson(p.tasks);
  const queue=createServiceProductionQueue({store,provider:async()=>fail('HOSTED_OPERATIONS_INFERENCE_FORBIDDEN'),enabled:true,projectIds:[p.id],taskIds:[...SERVICE_OPERATION_TASK_IDS],attemptLimit:1});
  try{await queue.drain();if(queue.status().lastError)fail('HOSTED_OPERATIONS_PROCESSING_FAILED');}finally{await queue.stop();}
  const after=await store.read(p.id,p.ownerId);
  if(hostedOperationsPreservedHash(after)!==c.preservedHash||canonicalJson(after.tasks)!==tasks||canonicalJson(after.jobs[c.businessHash+':work'])!==business)fail('HOSTED_OPERATIONS_PRESERVATION_FAILED');
  const artifacts=SERVICE_OPERATION_TASK_IDS.map(id=>{const artifact=readServiceOperation(after,id);if(!artifact)fail('HOSTED_OPERATIONS_RESULT_PENDING');return {taskId:id,artifactHash:digest(artifact)};});
  for(const id of SERVICE_OPERATION_TASK_IDS)for(const phase of ['preflight','work']){const job=after.jobs[c.submissions[id]+':'+phase];if(job?.status!=='succeeded'||job.attempts!==1||job.providerRunId)fail('HOSTED_OPERATIONS_ATTEMPT_CONFLICT');}
  const receipt={schemaVersion:1,status:'OPERATIONS_READY',runId:c.runId,projectId:p.id,orderId:p.order.id,configHash:digest(c),artifacts,completedJobs:12,apiCalls:0,incrementalApiCostEur:0,creditsUnchanged:true,productsUnchanged:true,storeApplied:false,publicationAuthorized:false,legalCertification:false};
  try{const old=await privateJson(folder,'receipt.json');if(canonicalJson(old)!==canonicalJson(receipt))fail('HOSTED_OPERATIONS_RECEIPT_CONFLICT');}
  catch(e){if(e.code!=='ENOENT')throw e;await fs.writeFile(path.join(folder,'receipt.json'),JSON.stringify(receipt)+'\n',{flag:'wx',mode:0o600});}
  return receipt;
}
