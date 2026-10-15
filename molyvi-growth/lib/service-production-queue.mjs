import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {canonicalJson,IntakeError} from './intake-store.mjs';
import {claimJob,finishJob,releaseTaskDependencies} from './task-workspace.mjs';
import {validateSessionExecution} from './session-execution.mjs';
import {validateBusinessDirection} from './codex-product-provider.mjs';
import {brandPresentation} from './brand-presentation.mjs';
import {readLogo} from './logo-assets.mjs';
import {readPhoto} from './product-assets.mjs';
import {photoPresentationPlan,productPhotoPlan} from './product-photo-plan.mjs';
import {initializeGallery} from './product-gallery.mjs';
import {SERVICE_OPERATION_TASK_IDS,serviceOperationReady,serviceOperationPreflight,buildServiceOperation,storeServiceOperation} from './service-operations.mjs';

const sha=value=>crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
const uuid=value=>/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(value??'');
const fail=code=>{throw new IntakeError(code,503);};
// Server-written verified receipts only. No HTTP route accepts provider evidence.
export function serviceProductionEligible(record){
  const purchase=record.servicePurchase,receipt=purchase?.receipt;
  return record.order.status==='verified_paid'&&record.order.paymentMode==='shopify_test'&&purchase?.evidenceMode==='shopify_test'
    &&purchase.shopDomain==='molyvi-still-dev.myshopify.com'&&receipt?.shopDomain===purchase.shopDomain
    &&receipt.provider==='shopify'&&receipt.mode==='test'&&receipt.evidenceMode==='shopify_test'&&receipt.verifiedBy==='raw_body_hmac_sha256'
    &&/^[a-f\d]{64}$/.test(receipt.bodyHash??'')&&record.order.id===`SHOPIFY-TEST-${receipt.orderId}`;
}
export function serviceBusinessPacket(record){
  if(!serviceProductionEligible(record)||!record.tasks.business.submission)fail('SERVICE_PRODUCTION_NOT_ELIGIBLE');
  const submission=record.tasks.business.submission;
  const content={kind:'business',assetEvidence:[],submissionHash:submission.hash,source:structuredClone(submission.answers)};
  return {...content,payloadHash:sha(content)};
}
function validateReceipt(job,packet,value){
  validateBusinessDirection(value?.result);validateSessionExecution(value?.evidence,packet.payloadHash);
  const execution=value.execution;
  if(execution?.route!=='codex_cli_chatgpt'||execution.runId!==job.providerRunId||!/^[a-f\d]{64}$/.test(execution.resultSha256??'')
    ||!Array.isArray(execution.inspectedSha256)||execution.inspectedSha256.length||!Number.isSafeInteger(execution.durationMs)||execution.durationMs<0
    ||!execution.usage||Object.keys(execution.usage).some(key=>!['input_tokens','cached_input_tokens','output_tokens','reasoning_output_tokens'].includes(key)||!Number.isSafeInteger(execution.usage[key])||execution.usage[key]<0))fail('SERVICE_PROVIDER_RECEIPT_INVALID');
}
// Saved provider output can be applied after restart without another model call.
export function applyServiceBusinessResult(record,jobId){
  const job=record.jobs[jobId],packet=serviceBusinessPacket(record);
  if(!job||job.taskId!=='business'||job.phase!=='work'||job.inputs?.submissionHash!==packet.submissionHash
    ||job.providerInputHash!==packet.payloadHash||!job.providerResult)fail('SERVICE_RESULT_SOURCE_CHANGED');
  validateReceipt(job,packet,job.providerResult);
  const output={delivery:'pro_business_direction',...job.providerResult.result},hash=sha(output);
  if(job.status==='succeeded'){if(job.result?.hash!==hash)fail('SERVICE_RESULT_CONFLICT');return {duplicate:true};}
  if(!['running','result_ready'].includes(job.status))fail('SERVICE_RESULT_STATE_CONFLICT');
  if(job.estimate!==0)fail('SERVICE_RESULT_RESERVATION_CONFLICT');
  job.result={hash,output};job.status='succeeded';job.lease=null;
  job.usage.push({attempt:job.attempts,billingMode:'chatgpt_session',cost:null,allocatedCostEur:null,incrementalApiCostEur:0,
    apiCalls:0,executionId:job.providerResult.evidence.executionId,tokens:structuredClone(job.providerResult.execution.usage),durationMs:job.providerResult.execution.durationMs});
  releaseTaskDependencies(record);
  return {duplicate:false};
}

// Bounded local operator pilot: one task type, explicit projects, one persisted
// provider attempt by default. Not production authentication/distributed leasing.
export function createServiceProductionQueue({store,provider,enabled=false,projectIds=[],taskIds=['business'],attemptLimit=1,timeoutMs=180000,pollMs=1000}={}){
  if(!store||typeof enabled!=='boolean'||!Array.isArray(projectIds)||projectIds.some(id=>!uuid(id))||new Set(projectIds).size!==projectIds.length
    ||!Array.isArray(taskIds)||!taskIds.length||taskIds.some(id=>!['business','branding','photos','catalog',...SERVICE_OPERATION_TASK_IDS].includes(id))||new Set(taskIds).size!==taskIds.length
    ||enabled&&(!provider||!projectIds.length)||!Number.isSafeInteger(attemptLimit)||attemptLimit<1||attemptLimit>5
    ||!Number.isSafeInteger(timeoutMs)||timeoutMs<1000||timeoutMs>600000||!Number.isSafeInteger(pollMs)||pollMs<20)fail('SERVICE_WORKER_CONFIG_INVALID');
  const lock=path.join(store.storage,'.service-production-worker.lock'),token=crypto.randomUUID();
  let initialized=false,ownsLock=false,interval,inflight,controller,outstanding=null,stopped=false,suspended=false,lastError=null;
  const read=async id=>{const directory=await store.directory(id),file=path.join(directory,'workspace.json');if((await fs.lstat(file)).isSymbolicLink())fail('UNSAFE_STORAGE');const candidate=JSON.parse(await fs.readFile(file,'utf8'));return store.read(id,candidate.ownerId);};
  const initialize=async()=>{
    if(initialized)return;
    try{await fs.mkdir(lock);ownsLock=true;await fs.writeFile(path.join(lock,'owner.json'),JSON.stringify({token,pid:process.pid}),{flag:'wx'});}
    catch(error){if(error.code==='EEXIST')fail('SERVICE_WORKER_LOCKED');throw error;}
    for(const id of projectIds){const record=await read(id);await store.transact(id,record.ownerId,current=>{
      for(const job of Object.values(current.jobs))if(job.taskId==='business'&&job.phase==='work'&&job.providerRunId&&job.status==='running'){
        job.status=job.providerResult?'result_ready':'paused_unknown';job.pauseReason=job.providerResult?null:'interrupted_attempt';
      }
    });}
    initialized=true;
  };
  const one=async()=>{
    if(!enabled||stopped||outstanding)return false;
    await initialize();
    const records=await Promise.all(projectIds.map(read));
    const attempts=records.reduce((sum,record)=>sum+Object.values(record.jobs).filter(job=>job.providerRunId).reduce((n,job)=>n+job.attempts,0),0);
    for(const record of records){
      if(serviceProductionEligible(record)){
        for(const candidate of Object.values(record.jobs).filter(job=>SERVICE_OPERATION_TASK_IDS.includes(job.taskId)&&taskIds.includes(job.taskId)&&job.status==='queued')){
          if(!serviceOperationReady(record,candidate))continue;
          try{
            const {result:processed}=await store.transact(record.id,record.ownerId,current=>{
              if(!serviceProductionEligible(current))return false;
              const saved=current.jobs[candidate.id];
              if(saved?.status!=='queued'||!serviceOperationReady(current,saved))return false;
              const prepared=saved.phase==='work'?buildServiceOperation(current,saved):null;
              const output=prepared?.output??serviceOperationPreflight(current,saved);
              const claimed=claimJob(current,{jobId:saved.id});if(!claimed)return false;
              if(prepared)storeServiceOperation(current,prepared);
              const finished=finishJob(current,{jobId:saved.id,leaseToken:claimed.lease.token,success:true,costEur:0,output});
              if(finished.status!=='succeeded')fail('SERVICE_OPERATION_RESULT_NOT_SAVED');
              return true;
            });
            if(processed)return true;
          }catch(error){
            await store.transact(record.id,record.ownerId,current=>{const saved=current.jobs[candidate.id];if(saved?.status==='queued'){saved.status='paused_unknown';saved.pauseReason=error.code??'operation_plan_unavailable';}});
            lastError=error.code??'SERVICE_OPERATION_FAILED';return true;
          }
        }
      }
      if(serviceProductionEligible(record)){
        const candidates=Object.values(record.jobs).filter(job=>['photos','catalog'].includes(job.taskId)&&taskIds.includes(job.taskId)&&job.status==='queued'&&(job.taskId==='photos'||job.scope==='product'));
        // Presentation is processed first; individual products remain independent.
        candidates.sort((a,b)=>(a.taskId==='photos'?-1:1)-(b.taskId==='photos'?-1:1));
        for(const candidate of candidates){
          if(candidate.taskId==='catalog'&&candidate.phase==='work'){
            const photoSubmission=record.tasks.photos.submission,photoJob=photoSubmission&&record.jobs[`${photoSubmission.hash}:work`];
            if(photoJob?.status!=='succeeded')continue;
          }
          try{
            if(candidate.taskId==='catalog')for(const ref of record.productTasks[candidate.productId].submission.photoEvidence)await readPhoto(store,{projectId:record.id,ownerId:record.ownerId},ref.id);
            await store.transact(record.id,record.ownerId,current=>{
              if(!serviceProductionEligible(current))return;
              const output=candidate.phase==='preflight'?{validated:true,submissionHash:candidate.id.split(':')[0],message:'Τα στοιχεία του προϊόντος και οι αρχικές φωτογραφίες έχουν αποθηκευτεί.'}
                :candidate.taskId==='photos'?photoPresentationPlan(current):productPhotoPlan(current,candidate.productId);
              const job=claimJob(current,{jobId:candidate.id});if(!job)return;
              finishJob(current,{jobId:job.id,leaseToken:job.lease.token,success:true,costEur:0,output});
              if(candidate.taskId==='catalog'&&candidate.phase==='work')initializeGallery(current,{productId:candidate.productId});
            });return true;
          }catch(error){
            await store.transact(record.id,record.ownerId,current=>{const job=current.jobs[candidate.id];if(job.status==='queued'){job.status='paused_unknown';job.pauseReason=error.code??'product_plan_unavailable';}});
            lastError=error.code??'PRODUCT_PLAN_FAILED';return true;
          }
        }
      }
      if(serviceProductionEligible(record)&&taskIds.includes('branding')&&record.tasks.branding.submission){
        const submission=record.tasks.branding.submission,pre=record.jobs[`${submission.hash}:preflight`],work=record.jobs[`${submission.hash}:work`];
        if(pre?.status==='queued'){
          await store.transact(record.id,record.ownerId,current=>{if(!serviceProductionEligible(current))return;const job=claimJob(current,{jobId:pre.id});if(job)finishJob(current,{jobId:job.id,leaseToken:job.lease.token,success:true,costEur:0,output:{validated:true,submissionHash:submission.hash,message:'Η επιλογή εμφάνισης αποθηκεύτηκε.'}});});return true;
        }
        if(work?.status==='queued'){
          try{
            if(submission.answers.logoMode==='existing')await readLogo(store,{projectId:record.id,ownerId:record.ownerId},submission.answers.logoReference);
            await store.transact(record.id,record.ownerId,current=>{
              if(!serviceProductionEligible(current))return;
              const output=brandPresentation(current),job=claimJob(current,{jobId:work.id});if(!job)return;
              finishJob(current,{jobId:job.id,leaseToken:job.lease.token,success:true,costEur:0,output});
            });return true;
          }catch(error){
            await store.transact(record.id,record.ownerId,current=>{const saved=current.jobs[work.id];if(saved.status==='queued'){saved.status='paused_unknown';saved.pauseReason=error.code??'branding_material_unavailable';}});
            lastError=error.code??'BRAND_PRESENTATION_FAILED';return true;
          }
        }
      }
      if(!taskIds.includes('business'))continue;
      if(!serviceProductionEligible(record)||!record.tasks.business.submission)continue;
      const packet=serviceBusinessPacket(record),prefix=packet.submissionHash,pre=record.jobs[`${prefix}:preflight`],work=record.jobs[`${prefix}:work`];
      if(work?.status==='result_ready'){await store.transact(record.id,record.ownerId,current=>applyServiceBusinessResult(current,work.id));return true;}
      if(pre?.status==='queued'){
        await store.transact(record.id,record.ownerId,current=>{
          if(!serviceProductionEligible(current))return;
          const job=claimJob(current,{jobId:pre.id});if(!job)return;
          finishJob(current,{jobId:job.id,leaseToken:job.lease.token,success:true,costEur:0,output:{validated:true,submissionHash:prefix,message:'Τα απαραίτητα στοιχεία έχουν υποβληθεί.'}});
        });return true;
      }
      if(work?.status!=='queued'||attempts>=attemptLimit)continue;
      // Login/version check is not inference. Reject API-key auth before reserving.
      await provider.preflight?.();
      const {result:job}=await store.transact(record.id,record.ownerId,current=>{
        if(!serviceProductionEligible(current)||serviceBusinessPacket(current).payloadHash!==packet.payloadHash)return null;
        const claimed=claimJob(current,{jobId:work.id,leaseMs:timeoutMs+60000});if(!claimed)return null;
        const saved=current.jobs[claimed.id];saved.providerRunId=`production-${crypto.randomUUID()}`;saved.providerInputHash=packet.payloadHash;
        return structuredClone(saved);
      });
      if(!job)return false;
      controller=new AbortController();let timer;
      try{
        outstanding=Promise.resolve().then(()=>provider({packet,runId:job.providerRunId,signal:controller.signal}));
        const pending=outstanding;pending.finally(()=>{if(outstanding===pending)outstanding=null;}).catch(()=>{});
        const value=await Promise.race([pending,new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new IntakeError('SERVICE_PROVIDER_TIMEOUT',503));},timeoutMs);})]);
        validateReceipt(job,packet,value);
        // Persist before import; a crash here recovers this exact result, never repeats inference.
        await store.transact(record.id,record.ownerId,current=>{
          const saved=current.jobs[job.id];if(saved.status!=='running'||saved.providerRunId!==job.providerRunId||serviceBusinessPacket(current).payloadHash!==packet.payloadHash)fail('SERVICE_RESULT_SOURCE_CHANGED');
          saved.providerResult=structuredClone(value);saved.status='result_ready';
        });
        await store.transact(record.id,record.ownerId,current=>applyServiceBusinessResult(current,job.id));
        return true;
      }catch(error){
        await store.transact(record.id,record.ownerId,current=>{const saved=current.jobs[job.id];if(saved.status==='running'){saved.status='paused_unknown';saved.pauseReason=error.code??'provider_failed';}});
        lastError=error.code??'SERVICE_PROVIDER_FAILED';return false;
      }finally{clearTimeout(timer);controller=null;}
    }
    return false;
  };
  const tick=()=>{
    if(suspended)return Promise.resolve(false);
    if(inflight)return inflight;
    inflight=one().catch(error=>{lastError=error.code??'SERVICE_WORKER_FAILED';return false;}).finally(()=>{inflight=null;});return inflight;
  };
  const start=async()=>{if(!enabled||stopped)return;await initialize();if(!interval){interval=setInterval(()=>{void tick();},pollMs);interval.unref();}void tick();};
  const stop=async()=>{
    stopped=true;clearInterval(interval);controller?.abort();if(inflight)await inflight;
    if(ownsLock&&!outstanding){const ownerFile=path.join(lock,'owner.json');const owner=JSON.parse(await fs.readFile(ownerFile,'utf8'));if(owner.token===token){await fs.unlink(ownerFile);await fs.rmdir(lock);ownsLock=false;}}
  };
  return {start,tick,stop,suspend:()=>{suspended=true;return ()=>{suspended=false;};},drain:async()=>{for(let i=0;i<64;i++)if(!await tick())break;},status:()=>({enabled,taskIds:[...taskIds],attemptLimit,lastError,active:Boolean(inflight)})};
}
