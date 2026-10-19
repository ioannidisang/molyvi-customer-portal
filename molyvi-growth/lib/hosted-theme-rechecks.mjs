import {canonicalJson,IntakeError} from './intake-store.mjs';

const equal=(left,right)=>canonicalJson(left)===canonicalJson(right);
const fail=code=>{throw new IntakeError(`HOSTED_THEME_RECHECKS_${code}`,422);};
const bindingKeys=['jobId','intentHash','attemptId','themeId','targetStore','shopId','appId','installId','liveThemeId'];
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value);
const date=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(Date.parse(value)).toISOString()===value;
const SOURCE_STATES=new Set(['waiting','checking','verified','stopped','unknown']);
const MAX_REMAINING_MS=15*60*1000;
const cloneFrozen=value=>Object.freeze(structuredClone(value));

function normalizeBinding(input){
  if(!input||typeof input!=='object'||Array.isArray(input)||!equal(Object.keys(input).sort(),bindingKeys.toSorted()))fail('BINDING_INVALID');
  const value=structuredClone(input);
  if(typeof value.jobId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value.jobId)||!hash(value.intentHash)||!uuid(value.attemptId)||typeof value.themeId!=='string'||!/^[1-9][0-9]{0,24}$/.test(value.themeId)||value.targetStore!=='molyvi-still-dev.myshopify.com'||value.shopId!=='108668748113'||value.appId!=='436878311425'||value.installId!=='1195450433873'||value.liveThemeId!=='207379235153'||['207379235153','208782819665'].includes(value.themeId))fail('BINDING_INVALID');
  return Object.freeze(value);
}

/**
 * One in-process lifecycle for one explicitly bound, already-created theme.
 * There is no scan, create, adoption, credential, network client or persistence
 * here. readDue supplies the durable authority and reconcileKnown must retain
 * its existing request/deadline limits. stopJob persists only a safe code.
 *
 * Lifecycle pause/stop do not abort an in-flight callback: drain waits for it.
 * A trusted runner must bound callback execution; this scheduler never starts
 * a replacement callback just because the previous one takes a long time.
 */
export function createHostedThemeRechecks({binding,readDue,reconcileKnown,stopJob,pollIntervalMs=1000,clock=Date.now,timers=globalThis}={}){
  const expected=normalizeBinding(binding);
  if(![readDue,reconcileKnown,stopJob,clock].every(value=>typeof value==='function')||!Number.isSafeInteger(pollIntervalMs)||pollIntervalMs<1000||pollIntervalMs>60000||typeof timers?.setTimeout!=='function'||typeof timers?.clearTimeout!=='function')fail('CONFIGURATION_INVALID');
  const callbacks={readDue,reconcileKnown,stopJob},setTimer=timers.setTimeout.bind(timers),clearTimer=timers.clearTimeout.bind(timers);
  let lifecycle='idle',timer=null,inFlight=null,failurePromise=null,drainPromise=null,generation=0,lastClock=null,deadlineAt=null,lastDueAt=null,lastReconciledDueAt=null;
  let lastCode=null,failurePersisted=null,checksStarted=0,terminalSourceStatus=null;
  const status=()=>cloneFrozen({lifecycle,jobId:expected.jobId,themeId:expected.themeId,inFlight:inFlight!==null,draining:drainPromise!==null,timerScheduled:timer!==null,lastCode,failurePersisted,checksStarted,terminalSourceStatus});
  function time(){
    const observed=clock();if(!Number.isSafeInteger(observed)||observed<0||observed>8_000_000_000_000_000)fail('CLOCK_INVALID');
    if(lastClock!==null&&observed<lastClock)fail('CLOCK_ROLLBACK');lastClock=observed;return observed;
  }
  function cancelTimer(){if(timer!==null){clearTimer(timer);timer=null;}}
  async function fatal(code){
    if(failurePromise)return failurePromise;
    lifecycle='failed';lastCode=code;generation++;cancelTimer();
    // Catch persistence failures too: raw callback errors may contain tokens.
    failurePromise=Promise.resolve().then(()=>callbacks.stopJob(expected,Object.freeze({code}))).then(()=>{failurePersisted=true;},()=>{failurePersisted=false;});
    await failurePromise;
  }
  function errorCode(error,fallback){
    // Only this module's known codes are exposed. Never echo provider messages,
    // causes, arbitrary error.code values, callback results or raw records.
    const allowed=['CLOCK_INVALID','CLOCK_ROLLBACK','SOURCE_INVALID','BINDING_CHANGED','DEADLINE_CHANGED','DEADLINE_EXCEEDED','DEADLINE_LIMIT','DUE_TIME_REGRESSED','CHECK_OUTSIDE_DEADLINE','IN_FLIGHT_OUTCOME_UNKNOWN','UNKNOWN_OUTCOME','PROGRESS_NOT_ADVANCED'];
    const code=typeof error?.code==='string'?error.code.replace(/^HOSTED_THEME_RECHECKS_/,''):null;
    return allowed.includes(code)&&error instanceof IntakeError?code:fallback;
  }
  function source(input,observed){
    if(!input||typeof input!=='object'||Array.isArray(input)||!SOURCE_STATES.has(input.status)||!date(input.deadlineAt)||!(input.nextCheckAt===null||date(input.nextCheckAt)))fail('SOURCE_INVALID');
    if(!equal(input.binding,expected))fail('BINDING_CHANGED');
    if(deadlineAt!==null&&input.deadlineAt!==deadlineAt)fail('DEADLINE_CHANGED');
    const deadline=Date.parse(input.deadlineAt);
    if(deadline-observed>MAX_REMAINING_MS)fail('DEADLINE_LIMIT');
    deadlineAt=input.deadlineAt;
    if(['verified','stopped'].includes(input.status))return {status:input.status,nextCheckAt:input.nextCheckAt,deadlineAt};
    if(observed>=deadline)fail('DEADLINE_EXCEEDED');
    if(input.status==='checking')fail('IN_FLIGHT_OUTCOME_UNKNOWN');
    if(input.status==='unknown')fail('UNKNOWN_OUTCOME');
    if(input.nextCheckAt===null)fail('SOURCE_INVALID');
    const due=Date.parse(input.nextCheckAt);
    if(due>deadline)fail('CHECK_OUTSIDE_DEADLINE');
    if(lastDueAt!==null&&due<lastDueAt)fail('DUE_TIME_REGRESSED');
    if(lastReconciledDueAt!==null&&due<=lastReconciledDueAt)fail('PROGRESS_NOT_ADVANCED');
    lastDueAt=due;
    return {status:input.status,nextCheckAt:input.nextCheckAt,deadlineAt};
  }
  async function cycle(epoch){
    let stage='READ_SOURCE_FAILED';
    try{
      time();const raw=await callbacks.readDue(expected);
      // A paused or stopped reader cannot start a new reconciliation later.
      if(lifecycle!=='running'||generation!==epoch)return;
      const observed=time(),current=source(raw,observed);
      if(['verified','stopped'].includes(current.status)){
        lifecycle='completed';terminalSourceStatus=current.status;generation++;cancelTimer();return;
      }
      if(observed<Date.parse(current.nextCheckAt))return;
      stage='RECONCILE_FAILED';lastReconciledDueAt=Date.parse(current.nextCheckAt);checksStarted++;
      await callbacks.reconcileKnown(expected);
      // Sampling again detects a rollback even if no subsequent timer starts.
      time();
    }catch(error){await fatal(errorCode(error,stage));}
  }
  function arm(){
    if(lifecycle!=='running'||timer!==null||inFlight!==null)return;
    const epoch=generation;
    try{
      timer=setTimer(()=>{
        timer=null;if(lifecycle!=='running'||generation!==epoch||inFlight!==null)return;
        const active=cycle(epoch);inFlight=active;
        active.then(()=>{if(inFlight===active)inFlight=null;arm();},()=>{if(inFlight===active)inFlight=null;void fatal('INTERNAL_FAILURE');});
      },pollIntervalMs);
      timer?.unref?.();
    }catch{timer=null;void fatal('TIMER_FAILED');}
  }
  function start(){
    if(lifecycle==='running')return status();
    if(lifecycle!=='idle')fail('START_STATE_INVALID');
    lifecycle='running';generation++;arm();return status();
  }
  function pause(){
    if(lifecycle==='running'||lifecycle==='idle'){lifecycle='paused';generation++;cancelTimer();}
    return status();
  }
  function drain(){
    if(drainPromise)return drainPromise;
    pause();
    drainPromise=Promise.resolve().then(async()=>{if(inFlight)await inFlight;if(failurePromise)await failurePromise;}).then(()=>{drainPromise=null;return status();},()=>{drainPromise=null;return status();});
    return drainPromise;
  }
  function resume(){
    if(drainPromise)fail('DRAIN_IN_PROGRESS');
    if(lifecycle==='running')return status();
    if(lifecycle!=='paused')fail('RESUME_STATE_INVALID');
    lifecycle='running';generation++;arm();return status();
  }
  async function stop(){
    if(!['failed','completed','stopped'].includes(lifecycle)){lifecycle='stopped';generation++;cancelTimer();}
    if(inFlight)await inFlight;if(failurePromise)await failurePromise;return status();
  }
  return Object.freeze({start,pause,drain,resume,stop,status});
}
