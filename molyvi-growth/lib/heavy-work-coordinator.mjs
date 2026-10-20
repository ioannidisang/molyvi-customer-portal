import {AsyncLocalStorage} from 'node:async_hooks';

const error=code=>Object.assign(new Error(code),{code});

// In-process exclusion only. The owner is private async context, never a value
// supplied by an HTTP caller. A failed drain keeps admission closed.
export function createHeavyWorkCoordinator({pause,waitOwned=async()=>{},drain,resume,drainTimeoutMs=30_000}={}){
  if([pause,waitOwned,drain,resume].some(fn=>typeof fn!=='function')||!Number.isSafeInteger(drainTimeoutMs)||drainTimeoutMs<1||drainTimeoutMs>30_000)throw error('HEAVY_COORDINATOR_CONFIG');
  const context=new AsyncLocalStorage();
  let phase='idle',stopping=false,production=null,operation=null,pendingDrain=null,owner=null,stopPromise;
  const acquireProduction=()=>{
    if(stopping||phase!=='idle'||production)throw error('HEAVY_RESOURCE_BUSY');
    let resolve;const done=new Promise(r=>{resolve=r;});production={done};
    let released=false;
    return ()=>{if(released)return;released=true;production=null;resolve();};
  };
  const runBackup=fn=>{
    if(typeof fn!=='function')throw error('HEAVY_CALLBACK_REQUIRED');
    if(stopping||phase!=='idle'||operation)throw error('HEAVY_RESOURCE_BUSY');
    phase='draining';
    const currentProduction=production?.done;
    // Admission closes and future worker ticks stop before any await.
    let lease;
    try{lease=pause();}catch(e){phase='blocked';throw e;}
    operation=(async()=>{
      let timer,drained=false;
      try{
        // Known production already admitted retains its own execution limits.
        // The residual drain timeout must not interrupt a healthy long install.
        pendingDrain=(async()=>{await currentProduction;await waitOwned(lease);})();
        await pendingDrain;
        pendingDrain=Promise.resolve().then(()=>drain(lease));
        await Promise.race([pendingDrain,new Promise((_,reject)=>{timer=setTimeout(()=>reject(error('HEAVY_DRAIN_TIMEOUT')),drainTimeoutMs);})]);
        drained=true;clearTimeout(timer);
        if(stopping)throw error('HEAVY_COORDINATOR_STOPPING');
        phase='backup';owner=Object.freeze({});
        return await context.run(owner,fn);
      }finally{
        clearTimeout(timer);owner=null;
        if(!drained){phase=stopping?'stopping':'blocked';}
        else if(stopping){phase='stopping';}
        else{
          try{resume(lease);phase='idle';}catch(e){phase='blocked';throw e;}
        }
      }
    })();
    const result=operation;
    // Keep a settled drain tracked until shutdown. In particular an operation
    // timeout must not imply the provider/handler it waited for has stopped.
    result.then(()=>{if(operation===result)operation=null;},()=>{if(operation===result)operation=null;});
    return result;
  };
  const stop=()=>{
    stopping=true;if(phase==='idle')phase='stopping';
    return stopPromise??=(async()=>{
      await Promise.allSettled([operation,production?.done].filter(Boolean));
      // The drain may have changed from owned-work waiting to residual waiting
      // after stop() was called. Consult its latest promise after the operation.
      await Promise.allSettled([pendingDrain].filter(Boolean));
      phase='stopped';
    })();
  };
  return Object.freeze({acquireProduction,runBackup,stop,
    ownsBackup:()=>Boolean(owner&&context.getStore()===owner&&phase==='backup'),
    status:()=>({phase,stopping,productionActive:Boolean(production),backupActive:phase==='backup'})});
}
