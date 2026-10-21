import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {canonicalJson,IntakeError} from './intake-store.mjs';
import {isBasicReferenceComposition} from './basic-reference-composition.mjs';
import {createBasicInstallation,releaseBasicInstallationSource} from './basic-installation.mjs';
import {createBasicInstallationRunner} from './basic-installation-runner.mjs';
import {createShopifyBasicTransport} from './shopify-basic-transport.mjs';
import {BASIC_THEME_PROGRESS_ROOT} from './basic-theme-progress.mjs';

// Private application bridge. No HTTP endpoint, credential discovery, automatic
// activation, retry, publication or expansion of the legacy hosted profile.
export const BASIC_REFERENCE_INSTALL_LIMITS=Object.freeze({graphQLRequests:700,mutations:130,stagedUploads:31,externalRequests:800,ownedBytes:8*1024*1024,elapsedMs:60*60*1000});
const TARGET='molyvi-still-dev.myshopify.com',SHOP='108668748113',LIVE='207379235153',LOCATION='125398417745';
const ENDPOINT=`https://${TARGET}/admin/api/2026-10/graphql.json`;
const hash=v=>crypto.createHash('sha256').update(canonicalJson(v)).digest('hex');
const sha=v=>crypto.createHash('sha256').update(v).digest('hex');
const fail=code=>{throw new IntakeError(`BASIC_REFERENCE_INSTALL_${code}`,422);};
const equal=(a,b)=>canonicalJson(a)===canonicalJson(b);
async function save(file,value){const raw=Buffer.from(JSON.stringify(value)+'\n');if(raw.length>256*1024)fail('RECORD_LIMIT');const h=await fs.open(file,'wx',0o600);try{await h.writeFile(raw);await h.sync();}finally{await h.close();}}

/** All arguments are supplied by trusted backend code. withResources must be
 * the resident application's preparation lease, including actual asynchronous
 * transport settlement after a runner timeout. A failed/uncertain installation
 * keeps its source hold and one-attempt journal; this bridge never resumes it.
 */
export async function installPreparedBasicReference({preparation,session,confirmation,withResources,directory,registryDirectory,
  authorizationSha256,preflightEvidence,operatorId,accessToken,fetchImpl,uploadFetch,decodeImage,onStep=async()=>{}}={}){
  if(!preparation||typeof preparation.loadPrepared!=='function'||typeof withResources!=='function'||typeof fetchImpl!=='function'||typeof uploadFetch!=='function'||typeof decodeImage!=='function'||typeof onStep!=='function')fail('PRIVATE_DEPENDENCIES_REQUIRED');
  const expected=structuredClone(confirmation),owner=structuredClone(session);
  if(!expected||expected.projectId!==owner?.projectId||expected.ownerHash!==hash(owner?.ownerId)||!/^[a-f0-9]{64}$/.test(authorizationSha256??''))fail('CONFIRMATION_REQUIRED');
  const location=path.resolve(directory),registry=path.resolve(registryDirectory);
  return withResources(async()=>{
    const loaded=await preparation.loadPrepared(owner,{requestId:expected.requestId});
    if(!equal(loaded.confirmation,expected)||!isBasicReferenceComposition(loaded.referenceComposition)||loaded.prepared!==undefined)fail('CONFIRMATION_CHANGED');
    const {referenceComposition,theme}=loaded,plan=referenceComposition.plan;
    if(plan.targetStore!==TARGET||plan.projectId!==owner.projectId||plan.planHash!==expected.planHash||sha(theme.zipBytes)!==expected.themeZipSha256)fail('SOURCE_BINDING');
    const context={...owner,targetStore:TARGET,planHash:plan.planHash,themeZipSha256:expected.themeZipSha256};
    const state=await createBasicInstallation({directory:location,registryDirectory:registry,referenceComposition,retainSource:true,theme,context,
      authorization:{projectId:owner.projectId,ownerHash:expected.ownerHash,targetStore:TARGET,planHash:plan.planHash,createOnly:true,publicationAuthorized:false,newChargesAuthorized:false,referenceSha256:authorizationSha256},
      preflightEvidence,liveThemeId:LIVE,inventoryLocationId:LOCATION,currency:'EUR'});
    const root=location+'.bridge';await fs.mkdir(root,{mode:0o700});
    const counters={graphQLRequests:0,mutations:0,stagedUploads:0,externalRequests:0},pending=new Set();let sequence=0,head=hash(expected),queue=Promise.resolve();
    const started=Date.now(),deadline=started+BASIC_REFERENCE_INSTALL_LIMITS.elapsedMs;
    const binding={intentHash:state.intentHash,targetStore:TARGET,projectId:owner.projectId,ownerHash:expected.ownerHash,planHash:plan.planHash,themeZipSha256:expected.themeZipSha256,packageBytesHash:state.intent.packageBytesHash};
    await save(path.join(root,'binding.json'),{schemaVersion:1,kind:'molyvi_reference_preparation_installation',confirmation:expected,binding,limits:BASIC_REFERENCE_INSTALL_LIMITS,startedAt:new Date(started).toISOString(),deadlineAt:new Date(deadline).toISOString(),publicationAuthorized:false,newChargesAuthorized:false});
    async function storage(){
      let bytes=theme.zipBytes.length; // Count retained ZIP even though no copy is written here.
      async function walk(dir){for(const e of await fs.readdir(dir,{withFileTypes:true})){const f=path.join(dir,e.name),s=await fs.lstat(f);if(s.isSymbolicLink())fail('UNSAFE_STORAGE');if(s.isDirectory())await walk(f);else{if(!s.isFile()||s.nlink!==1)fail('UNSAFE_STORAGE');bytes+=s.size;if(bytes>BASIC_REFERENCE_INSTALL_LIMITS.ownedBytes-256*1024)fail('STORAGE_LIMIT');}}}
      await walk(location);await walk(root);
      try{await walk(path.join(BASIC_THEME_PROGRESS_ROOT,state.intentHash));}catch(e){if(e.code!=='ENOENT')throw e;}
      bytes+=(await fs.stat(path.join(registry,state.intent.registryKey+'.json'))).size;
      if(bytes>BASIC_REFERENCE_INSTALL_LIMITS.ownedBytes-256*1024)fail('STORAGE_LIMIT');return bytes;
    }
    async function reserve(kind){
      const task=queue.then(async()=>{
        if(Date.now()>=deadline)fail('DEADLINE');await storage();
        const next={...counters};if(kind==='query'||kind==='mutation')next.graphQLRequests++;if(kind==='mutation')next.mutations++;if(kind==='upload')next.stagedUploads++;if(kind==='upload'||kind==='download')next.externalRequests++;
        for(const key of Object.keys(next))if(next[key]>BASIC_REFERENCE_INSTALL_LIMITS[key])fail('BUDGET_EXHAUSTED');
        const body={sequence:sequence+1,previousHash:head,intentHash:state.intentHash,kind,counters:next,at:new Date().toISOString()},eventHash=hash(body);
        await save(path.join(root,`${String(sequence+1).padStart(6,'0')}.json`),{...body,eventHash});Object.assign(counters,next);head=eventHash;sequence++;
      });queue=task;return task;
    }
    const track=fn=>(...args)=>{const p=Promise.resolve().then(()=>fn(...args));pending.add(p);p.then(()=>pending.delete(p),()=>pending.delete(p));return p;};
    const graphql=async(url,init)=>{
      if(url!==ENDPOINT||init?.method!=='POST'||typeof init.body!=='string'||Buffer.byteLength(init.body)>1024*1024)fail('REQUEST_SCOPE');
      const body=JSON.parse(init.body);if(!/^(query|mutation)\s+MolyviBasic\w+\b/.test(body.query??''))fail('REQUEST_SCOPE');
      init.signal?.throwIfAborted();await reserve(body.query.startsWith('mutation')?'mutation':'query');init.signal?.throwIfAborted();return fetchImpl(url,init);
    };
    const external=async(url,init)=>{if(!['POST','GET'].includes(init?.method)||init.redirect!=='error')fail('REQUEST_SCOPE');init.signal?.throwIfAborted();await reserve(init.method==='POST'?'upload':'download');init.signal?.throwIfAborted();return uploadFetch(url,init);};
    const transport=createShopifyBasicTransport({referenceComposition,theme,binding,liveThemeId:LIVE,inventoryLocationId:LOCATION,accessToken,
      fetchImpl:graphql,uploadFetch:external,decodeImage,networkEnabled:true,recordReadbackEvidence:async value=>{
        await storage();await save(path.join(root,`readback-${value.readRequestId}.json`),{intentHash:state.intentHash,key:value.key,attemptId:value.attemptId,remoteId:value.remoteId,readRequestId:value.readRequestId,sha256:hash(value)});
      }});
    const wrapped={...transport,...Object.fromEntries(['preflight','apply','readback'].map(key=>[key,track(transport[key])]))};
    const runner=await createBasicInstallationRunner({registryDirectory:registry,trustedShop:{shopId:SHOP,targetStore:TARGET},transport:wrapped,operatorId,timeoutMs:60000,themeWaitMs:0});
    try{
      let result=state;const steps=[];
      for(const step of state.intent.steps){
        if(Date.now()>=deadline)fail('DEADLINE');await onStep({phase:'before',key:step.key,kind:step.kind});const at=Date.now();
        result=await runner.runStep({directory:location,context,key:step.key});steps.push({key:step.key,kind:step.kind,elapsedMs:Date.now()-at});
        await onStep({phase:'after',key:step.key,kind:step.kind});if(result.waiting)fail('KNOWN_THEME_WAITING');
      }
      if(result.installationStatus!=='installed_operator_attested'||Object.values(result.steps).some(s=>s.status!=='succeeded'))fail('INCOMPLETE');
      await referenceComposition.revalidate();const release=await releaseBasicInstallationSource({directory:location,context,referenceComposition});
      const output={status:'verified',intentHash:result.intentHash,journalHead:result.head,eventCount:result.eventCount,confirmation:expected,counters,steps,sourceRelease:release,ownedBytes:await storage(),publicationAuthorized:false,newChargesAuthorized:false};
      await save(path.join(root,'complete.json'),output);return output;
    }finally{
      // A runner timeout does not prove that an HTTP mutation stopped. Do not
      // release the application lease while any underlying method still runs.
      while(pending.size)await Promise.allSettled([...pending]);await queue.catch(()=>{});
    }
  });
}
