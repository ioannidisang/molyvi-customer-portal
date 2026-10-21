import {permitsUndispatchedReferenceStep} from './basic-reference-resume.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {canonicalJson,IntakeError,WORKSPACE_ROOT} from './intake-store.mjs';
import {readBasicInstallation,claimBasicInstallationStep,recordBasicInstallationReceipt,reconcileBasicInstallationStep,getBasicInstallationRuntimeRegistry,BASIC_INSTALL_HOSTED_PROFILE,BASIC_INSTALL_HOSTED_REGISTRY,BASIC_INSTALL_HOSTED_ROOT,BASIC_INSTALL_PREPARED_PROFILE,BASIC_INSTALL_PREPARED_REGISTRY,BASIC_INSTALL_PREPARED_ROOT} from './basic-installation.mjs';
import {createBasicThemeProgress,BASIC_THEME_PROGRESS_INSTALLER_HOSTED_ROOT,BASIC_THEME_PROGRESS_PREPARED_HOSTED_ROOT} from './basic-theme-progress.mjs';

const kinds=new Set(['catalog','media','variant_media','collection','page','theme']);
const hash=value=>crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
const equal=(a,b)=>canonicalJson(a)===canonicalJson(b);
const fail=code=>{throw new IntakeError(`BASIC_INSTALL_RUNNER_${code}`,422);};
const id=value=>typeof value==='string'&&/^[1-9][0-9]{0,24}$/.test(value);
const domain=value=>typeof value==='string'&&/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$/.test(value);
const date=value=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value)&&Number.isFinite(Date.parse(value));
const inside=(parent,child)=>{const r=path.relative(parent,child);return r!==''&&r!=='..'&&!r.startsWith(`..${path.sep}`)&&!path.isAbsolute(r);};
const freeze=value=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};

async function registryPath(value){
  if(typeof value!=='string'||!value||/[\x00-\x1f]/.test(value))fail('TRUSTED_REGISTRY_REQUIRED');
  const absolute=path.resolve(value);
  if(!['briefs','customer-materials'].some(name=>inside(path.join(WORKSPACE_ROOT,name),absolute)))fail('TRUSTED_REGISTRY_REQUIRED');
  const parsed=path.parse(absolute);let current=parsed.root;
  for(const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)){
    current=path.join(current,part);const stat=await fs.lstat(current);
    if(!stat.isDirectory()||stat.isSymbolicLink())fail('UNSAFE_REGISTRY');
  }
  return absolute;
}
function binding(state){
  const i=state.intent;
  return {intentHash:state.intentHash,targetStore:i.targetStore,projectId:i.projectId,ownerHash:i.ownerHash,planHash:i.planHash,themeZipSha256:i.themeZipSha256,packageBytesHash:i.packageBytesHash};
}

/**
 * Bounded bridge between the private journal and a separately implemented,
 * trusted transport. This module has no network client or credentials. The
 * transport must independently resolve package bytes, enforce its own API
 * scopes and retain a definite create-response ID per attempt. A handle alone
 * is not a creation receipt. Its readback must be a fresh remote read by that
 * ID; the mutation response is never accepted as verification here.
 *
 * This factory does not authorize a new store, install, scope, or publication.
 * Local context/owner/plan binding is distinct from observed remote shop facts.
 * Journal evidence remains operator-attested, not independently certified by
 * this module. A hostile transport or local administrator is out of scope.
 */
export async function createBasicInstallationRunner({registryDirectory,runtimeProfile,trustedShop,transport,operatorId,timeoutMs=30_000,themeWaitMs=20_000,themeClock=Date.now,themeSleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),undispatchedAuthority}={}){
  if(runtimeProfile!==undefined&&![BASIC_INSTALL_HOSTED_PROFILE,BASIC_INSTALL_PREPARED_PROFILE].includes(runtimeProfile))fail('RUNTIME_PROFILE_INVALID');
  const registry=await registryPath(registryDirectory),shop=structuredClone(trustedShop);
  if(runtimeProfile===BASIC_INSTALL_HOSTED_PROFILE&&registry!==BASIC_INSTALL_HOSTED_REGISTRY)fail('RUNTIME_REGISTRY_MISMATCH');
  if(runtimeProfile===BASIC_INSTALL_PREPARED_PROFILE&&registry!==BASIC_INSTALL_PREPARED_REGISTRY)fail('RUNTIME_REGISTRY_MISMATCH');
  if(runtimeProfile===undefined&&[BASIC_INSTALL_HOSTED_ROOT,BASIC_INSTALL_PREPARED_ROOT].some(root=>registry===root||inside(root,registry)))fail('RUNTIME_PROFILE_REQUIRED');
  if(!shop||!id(shop.shopId)||!domain(shop.targetStore)||Object.keys(shop).some(key=>!['shopId','targetStore'].includes(key)))fail('TRUSTED_SHOP_REQUIRED');
  if(typeof operatorId!=='string'||!operatorId||operatorId.length>200||/[\x00-\x1f]/.test(operatorId))fail('OPERATOR_REQUIRED');
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<10||timeoutMs>60_000)fail('TIMEOUT_LIMIT');
  if(!Number.isSafeInteger(themeWaitMs)||themeWaitMs<0||themeWaitMs>60_000||typeof themeClock!=='function'||typeof themeSleep!=='function')fail('THEME_RECHECK_CONFIGURATION');
  if(!transport||!['preflight','apply','readback'].every(name=>typeof transport[name]==='function')||!Array.isArray(transport.supportedKinds)||!transport.supportedKinds.length||transport.supportedKinds.some(kind=>!kinds.has(kind))||new Set(transport.supportedKinds).size!==transport.supportedKinds.length)fail('TRANSPORT_REQUIRED');
  const allowed=new Set(transport.supportedKinds);
  const durableThemes=transport.themeProcessing==='durable_v1';
  // Capture methods once; changing caller-owned transport properties later
  // cannot substitute an implementation or broaden the supported operations.
  const methods=Object.fromEntries(['preflight','apply','readback'].map(name=>[name,transport[name].bind(transport)]));
  freeze(shop);

  async function load(options){
    await registryPath(registry);
    const state=await readBasicInstallation(options);
    if(state.intent.runtimeProfile!==runtimeProfile)fail('RUNTIME_PROFILE_MISMATCH');
    if(path.resolve(state.intent.registryDirectory)!==registry)fail('REGISTRY_MISMATCH');
    if(state.intent.targetStore!==shop.targetStore)fail('SHOP_SCOPE_MISMATCH');
    return state;
  }
  function stepFor(state,key){
    const step=state.intent.steps.find(item=>item.key===key);
    if(!step)fail('UNKNOWN_STEP');
    if(!allowed.has(step.kind))fail('UNSUPPORTED_STEP');
    return step;
  }
  function requestFor(state,step,attemptId,extra={}){
    return freeze(structuredClone({binding:binding(state),trustedShop:shop,step,dependencies:Object.fromEntries(step.dependsOn.map(key=>[key,state.steps[key].receipt])),attemptId,...extra}));
  }
  async function invoke(name,request,themeProgress){
    const controller=new AbortController();let timer;
    const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new IntakeError(`BASIC_INSTALL_RUNNER_${name.toUpperCase()}_TIMEOUT`,504));},timeoutMs);});
    try{
      // No retries, redirects or background reconciliation are initiated here.
      // Abort is advisory: a timed-out mutation can still have succeeded, so
      // its durable claim MUST remain unknown until a separate read resolves it.
      return await Promise.race([Promise.resolve().then(()=>methods[name](request,{signal:controller.signal,...(themeProgress?{themeProgress}:{})})),timeout]);
    }catch(error){
      if(error instanceof IntakeError&&error.code===`BASIC_INSTALL_RUNNER_${name.toUpperCase()}_TIMEOUT`)throw error;
      // Transport exceptions can contain credentials or raw response bodies.
      // Do not persist, return as details, or attach them as a cause.
      throw new IntakeError(`BASIC_INSTALL_RUNNER_${name.toUpperCase()}_FAILED`,502);
    }finally{clearTimeout(timer);}
  }
  async function preflight(state,step,attemptId,stage,themeProgress){
    const started=Date.now(),response=await invoke('preflight',requestFor(state,step,attemptId,{stage}),themeProgress);
    if(!response||response.shopId!==shop.shopId||response.targetStore!==shop.targetStore||response.currency!==state.intent.currency)fail('REMOTE_SHOP_MISMATCH');
    if(!Array.isArray(response.authorizedKinds)||!response.authorizedKinds.includes(step.kind)||response.authorizedKinds.some(kind=>!kinds.has(kind)))fail('REMOTE_CAPABILITY_MISSING');
    if(!date(response.observedAt)||Date.parse(response.observedAt)<started-5_000||Date.parse(response.observedAt)>Date.now()+5_000)fail('STALE_PREFLIGHT');
    // Only selected remote facts are retained in the evidence digest.
    return {shopId:response.shopId,targetStore:response.targetStore,currency:response.currency,authorizedKinds:[...response.authorizedKinds],observedAt:response.observedAt};
  }
  async function readback(state,step,attemptId,mode,remoteFacts,themeProgress){
    const readRequestId=crypto.randomUUID(),started=Date.now();
    const response=await invoke('readback',requestFor(state,step,attemptId,{readRequestId,mode}),themeProgress);
    if(!response||response.kind!=='molyvi_basic_installation_readback'||response.readRequestId!==readRequestId||response.shopId!==shop.shopId||response.targetStore!==shop.targetStore||response.key!==step.key||response.attemptId!==attemptId||response.payloadHash!==step.payloadHash)fail('READBACK_SCOPE_MISMATCH');
    if(!date(response.observedAt)||Date.parse(response.observedAt)<started-5_000||Date.parse(response.observedAt)>Date.now()+5_000)fail('STALE_READBACK');
    if(!equal(response.correlation,{intentHash:state.intentHash,attemptId,payloadHash:step.payloadHash}))fail('READBACK_CORRELATION_MISSING');
    if(themeProgress){
      const progress=await themeProgress.read();
      if(!progress?.themeId||progress.themeId!==response.remoteId)fail('THEME_CREATION_PROOF_REQUIRED');
      if(response.outcome==='pending'){
        if(step.kind!=='theme'||response.reason!=='theme_processing'||!date(response.nextCheckAt)||!date(response.deadlineAt)||response.nextCheckAt!==progress.nextEligibleAt||response.deadlineAt!==progress.deadlineAt)fail('THEME_PENDING_PROOF_INVALID');
        return {pending:true,progress};
      }
    }
    if(response.outcome!=='found')fail('READBACK_NOT_CONFIRMED');
    let provenanceSha256;
    if(themeProgress){
      if(!response.provenance||typeof response.provenance!=='object'||Array.isArray(response.provenance))fail('THEME_PROVENANCE_REQUIRED');
      const serialized=canonicalJson(response.provenance);
      if(Buffer.byteLength(serialized)>2*1024*1024)fail('THEME_PROVENANCE_LIMIT');
      provenanceSha256=hash(response.provenance);
    }
    const observed=structuredClone(response.observed);
    const evidence={operatorId,observedAt:response.observedAt,scopeConfirmed:true,evidenceSha256:hash({kind:response.kind,readRequestId,remoteFacts,shopId:response.shopId,targetStore:response.targetStore,key:step.key,attemptId,payloadHash:step.payloadHash,remoteId:response.remoteId,observed,correlation:response.correlation,observedAt:response.observedAt,...(provenanceSha256?{provenanceSha256}:{})})};
    return {receipt:{remoteId:response.remoteId,payloadHash:step.payloadHash,observed,evidence},evidence,provenanceSha256};
  }
  function progressFor(state,step,options){
    return createBasicThemeProgress({binding:{...binding(state),shopId:shop.shopId,appId:'436878311425',installId:'1195450433873',liveThemeId:state.intent.liveThemeId},attemptId:state.steps[step.key].attemptId,dependenciesHash:hash(Object.fromEntries(step.dependsOn.map(key=>[key,state.steps[key].receipt]))),journalDirectory:path.resolve(options.directory),registryKey:state.intent.registryKey,clock:themeClock,...(runtimeProfile?{runtimeProfile,rootDirectory:runtimeProfile===BASIC_INSTALL_PREPARED_PROFILE?BASIC_THEME_PROGRESS_PREPARED_HOSTED_ROOT:BASIC_THEME_PROGRESS_INSTALLER_HOSTED_ROOT}:{})});
  }
  const waitingState=(state,progress)=>({...state,duplicate:false,waiting:{kind:'shopify_theme_processing',stepKey:'theme',remoteId:progress.themeId,nextCheckAt:progress.nextEligibleAt,deadlineAt:progress.deadlineAt,automaticRechecks:true,backgroundSchedulerActive:false}});
  async function themeFailure(progress,error){
    // Stopping never removes a create reservation or a definite response ID.
    // The original journal claim remains authoritative if the progress write
    // itself is interrupted. No recovery may repeat apply.
    try{await progress.stop({code:'RUNNER_CHECK_STOPPED'});}catch{}
    throw error;
  }
  async function finishTheme(options,state,step,progress,{reconcile=false}={}){
    const attemptId=state.steps[step.key].attemptId,windowStarted=themeClock();
    let facts;
    try{
      for(let round=0;round<13;round++){
        let current=await progress.read();
        if(!current?.themeId||['stopped','verified'].includes(current.status))fail('THEME_CREATION_PROOF_REQUIRED');
        const now=themeClock(),remaining=themeWaitMs-(now-windowStarted),delay=current.nextEligibleAt?Math.max(0,Date.parse(current.nextEligibleAt)-now):0;
        if(!Number.isSafeInteger(now)||now<windowStarted)fail('THEME_CLOCK_INVALID');
        if(now>=Date.parse(current.deadlineAt))fail('THEME_DEADLINE_EXCEEDED');
        if(delay>0){
          if(delay>remaining)return waitingState(state,current);
          await themeSleep(delay);
          current=await progress.read();
          // A faulty/early wakeup is a pause, never a request before its due time.
          if(current.nextEligibleAt&&themeClock()<Date.parse(current.nextEligibleAt))return waitingState(state,current);
        }
        if(!facts)facts=await preflight(state,step,attemptId,reconcile?'reconcile':'before_readback',progress);
        const verified=await readback(state,step,attemptId,reconcile?'reconcile':'after_apply',facts,progress);
        if(verified.pending)continue;
        const final=reconcile?await reconcileBasicInstallationStep({...options,key:step.key,attemptId,receipt:verified.receipt,reconciliationEvidence:verified.evidence}):await recordBasicInstallationReceipt({...options,key:step.key,attemptId,receipt:verified.receipt});
        // Commit the authoritative installation receipt first. This auxiliary
        // marker never substitutes for independent remote verification.
        await progress.complete({proofSha256:verified.provenanceSha256});
        return final;
      }
      fail('THEME_RECHECK_LIMIT');
    }catch(error){return themeFailure(progress,error);}
  }
  async function locked(input,operation){
    // Snapshot user input before any await; do not accept a caller's registry
    // override. readBasicInstallation separately validates owner/plan/theme.
    const options=structuredClone({directory:input?.directory,context:input?.context}),key=input?.key;
    const initial=await load(options);stepFor(initial,key);
    const assertLegacyIdle=async()=>{try{await fs.lstat(path.join(registry,`${initial.intent.registryKey}.runner-lock`));fail('BUSY_OR_INTERRUPTED_LOCK');}catch(error){if(error.code!=='ENOENT')throw error;}};
    await assertLegacyIdle();
    // All current runners and continuation creation coordinate through the
    // same canonical lock, while retaining the original registry binding.
    // No transient runner lock is placed inside a sealed source registry.
    const lockRegistry=await registryPath(await getBasicInstallationRuntimeRegistry(runtimeProfile));
    const lock=path.join(lockRegistry,`${initial.intent.registryKey}.runner-lock`);
    try{await fs.mkdir(lock,{mode:0o700});}catch(error){if(error.code==='EEXIST')fail('BUSY_OR_INTERRUPTED_LOCK');throw error;}
    try{await assertLegacyIdle();return await operation(options,key,await load(options));}finally{await fs.rmdir(lock);}
  }
  async function runStep(input){
    return locked(input,async(options,key,state)=>{
      const step=stepFor(state,key),current=state.steps[key];
      if(current.status==='succeeded')return {...state,duplicate:true};
      if(permitsUndispatchedReferenceStep(undispatchedAuthority,state,key)){
        const attemptId=current.attemptId;
        if(step.kind!=='variant_media'||step.dependsOn.some(k=>state.steps[k].status!=='succeeded'))fail('RECONCILIATION_REQUIRED');
        await preflight(state,step,attemptId,'before_apply');
        await invoke('apply',requestFor(state,step,attemptId));
        const facts=await preflight(state,step,attemptId,'before_readback'),verified=await readback(state,step,attemptId,'after_apply',facts);
        return recordBasicInstallationReceipt({...options,key,attemptId,receipt:verified.receipt});
      }
      if(durableThemes&&step.kind==='theme'&&current.status==='claimed_outcome_unknown')return finishTheme(options,state,step,progressFor(state,step,options),{reconcile:true});
      if(current.status!=='pending'||Object.values(state.steps).some(item=>['claimed_outcome_unknown','blocked_no_automatic_retry'].includes(item.status)))fail('RECONCILIATION_REQUIRED');
      if(step.dependsOn.some(parent=>state.steps[parent].status!=='succeeded'))fail('DEPENDENCIES_INCOMPLETE');
      await preflight(state,step,null,'before_claim');
      state=await claimBasicInstallationStep({...options,key});
      if(state.duplicate)return state;
      const attemptId=state.steps[key].attemptId;
      if(durableThemes&&step.kind==='theme'){
        const progress=progressFor(state,step,options);
        await progress.begin();
        try{
          await preflight(state,step,attemptId,'before_apply',progress);
          await invoke('apply',requestFor(state,step,attemptId),progress);
        }catch(error){return themeFailure(progress,error);}
        return finishTheme(options,state,step,progress);
      }
      await preflight(state,step,attemptId,'before_apply');
      // Even a successful-looking receipt returned here is deliberately ignored.
      await invoke('apply',requestFor(state,step,attemptId));
      const remoteFacts=await preflight(state,step,attemptId,'before_readback');
      const verified=await readback(state,step,attemptId,'after_apply',remoteFacts);
      return recordBasicInstallationReceipt({...options,key,attemptId,receipt:verified.receipt});
    });
  }
  async function reconcileStep(input){
    return locked(input,async(options,key,state)=>{
      const step=stepFor(state,key),current=state.steps[key];
      if(current.status==='succeeded')return {...state,duplicate:true};
      if(current.status!=='claimed_outcome_unknown')fail('UNKNOWN_ATTEMPT_REQUIRED');
      if(durableThemes&&step.kind==='theme')return finishTheme(options,state,step,progressFor(state,step,options),{reconcile:true});
      const attemptId=current.attemptId,remoteFacts=await preflight(state,step,attemptId,'reconcile');
      const verified=await readback(state,step,attemptId,'reconcile',remoteFacts);
      // This entry point never calls apply. An absent/ambiguous remote result
      // remains unknown; it cannot reset a claim or start another attempt.
      return reconcileBasicInstallationStep({...options,key,attemptId,receipt:verified.receipt,reconciliationEvidence:verified.evidence});
    });
  }
  return Object.freeze({runStep,reconcileStep,read:input=>load(structuredClone({directory:input?.directory,context:input?.context}))});
}
