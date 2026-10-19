import crypto from 'node:crypto';
import {canonicalJson,IntakeError} from './intake-store.mjs';

const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const digest=value=>crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
const isHash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const fail=code=>{throw new IntakeError(`BASIC_PREPARATION_WORKER_${code}`,409);};
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');

// One fixed project, one immutable preparation request and one serial handoff.
// All callbacks are trusted server wiring, never values accepted over HTTP.
// onPrepared must consult its durable installer journal before any external
// operation, including after restart, and return verified only at completion.
export function createBasicPreparationWorker({enabled=false,permit,preparationService,listPending,acquireLease,onPrepared,pollMs=5000}={}){
  if(typeof enabled!=='boolean'||!Number.isSafeInteger(pollMs)||pollMs<1000||pollMs>60000)fail('CONFIG_INVALID');
  if(enabled&&(!exact(permit,['projectId','ownerHash'])||!uuid(permit.projectId)||!isHash(permit.ownerHash)||typeof preparationService?.status!=='function'||typeof preparationService?.prepare!=='function'||typeof listPending!=='function'||typeof acquireLease!=='function'||typeof onPrepared!=='function'))fail('CONFIG_INVALID');
  permit=permit?Object.freeze({...permit}):null;
  let lifecycle=enabled?'idle':'disabled',phase='idle',inFlight=null,timer=null,paused=false,stopped=false,terminal=false,lastCode=null,requestId=null;
  const clear=()=>{if(timer){clearTimeout(timer);timer=null;}};
  const status=()=>({enabled,lifecycle,phase,paused,inFlight:Boolean(inFlight),projectId:permit?.projectId??null,requestId,lastCode});
  const schedule=()=>{if(!enabled||paused||stopped||terminal||timer||inFlight)return;timer=setTimeout(()=>{timer=null;void runOnce();},pollMs);timer.unref?.();};
  function validateDescriptor(item){
    if(!exact(item,['session','requestId','sourceHash'])||!exact(item.session,['ownerId','projectId'])||!uuid(item.session.ownerId)||item.session.projectId!==permit.projectId||digest(item.session.ownerId)!==permit.ownerHash||!uuid(item.requestId)||!isHash(item.sourceHash))fail('PERMIT_MISMATCH');
    return structuredClone(item);
  }
  function validateReceipt(receipt,item){
    if(receipt?.projectId!==item.session.projectId||receipt.sourceHash!==item.sourceHash||receipt.readiness?.ready!==true||receipt.request?.requestId!==item.requestId||receipt.request?.sourceHash!==item.sourceHash)fail('SOURCE_CHANGED');
  }
  async function work(){
    let release=null;
    try{
      phase='listing';const pending=await listPending();
      if(!Array.isArray(pending)||pending.length>1)fail('PENDING_SCOPE');
      if(paused||stopped)return;
      if(!pending.length){phase='idle';return;}
      const item=validateDescriptor(pending[0]);requestId=item.requestId;
      phase='waiting_for_lease';release=await acquireLease();
      if(typeof release!=='function')fail('LEASE_INVALID');
      if(paused||stopped)return;
      phase='preflight';let receipt=await preparationService.status(item.session);validateReceipt(receipt,item);
      if(!['requested','prepared_for_installation_review'].includes(receipt.request.state))fail('ATTEMPT_REQUIRES_REVIEW');
      // A saved success is re-verified by prepare without reserving/rebuilding.
      // A partial or failed attempt can never reach this handoff automatically.
      phase='preparing';receipt=await preparationService.prepare(item.session,{requestId:item.requestId});validateReceipt(receipt,item);
      if(receipt.request.state!=='prepared_for_installation_review'||receipt.request.outputVerifiedNow!==true)fail('PREPARATION_NOT_VERIFIED');
      phase='handoff';const outcome=await onPrepared({...item,receipt});
      if(!['verified','already_verified'].includes(outcome?.status))fail('HANDOFF_NOT_VERIFIED');
      terminal=true;lifecycle='completed';phase='complete';lastCode=null;
    }catch(error){
      terminal=true;lifecycle='stopped_for_review';phase='stopped';
      lastCode=/^[A-Z0-9_]{1,100}$/.test(error?.code??'')?error.code:'BASIC_PREPARATION_WORKER_STOPPED';
    }finally{
      if(release){try{await release();}catch{terminal=true;lifecycle='stopped_for_review';phase='stopped';lastCode='BASIC_PREPARATION_WORKER_LEASE_RELEASE_FAILED';}}
    }
  }
  async function runOnce(){
    if(!enabled||paused||stopped||terminal)return status();
    if(inFlight){await inFlight;return status();}
    clear();lifecycle='running';inFlight=work();
    try{await inFlight;}finally{inFlight=null;if(!terminal){phase='idle';lifecycle=stopped?'stopped':paused?'paused':'waiting';}schedule();}
    return status();
  }
  function start(){if(!enabled||stopped||terminal)return status();paused=false;lifecycle='waiting';void runOnce();return status();}
  function pause(){paused=true;clear();if(!inFlight&&!terminal)lifecycle='paused';return status();}
  async function drain(){if(inFlight)await inFlight;return status();}
  function resume(){if(!enabled||stopped||terminal)return status();paused=false;lifecycle='waiting';schedule();return status();}
  async function stop(){stopped=true;paused=true;clear();await drain();if(!terminal){lifecycle=enabled?'stopped':'disabled';phase='idle';}return status();}
  return Object.freeze({start,pause,drain,resume,stop,status,runOnce});
}
