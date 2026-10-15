import fs from 'node:fs/promises';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {PRIVATE_ROOT} from '../lib/intake-store.mjs';
import {ordinaryFile} from '../lib/service-handoff.mjs';
import {validateControlledProRequest} from '../lib/hosted-controlled-pro.mjs';
import {createCodexProductProvider} from '../lib/codex-product-provider.mjs';
const {values}=parseArgs({options:{request:{type:'string'},out:{type:'string'},storage:{type:'string'}}});
const within=file=>{const r=path.relative(PRIVATE_ROOT,path.resolve(file));return r&&!r.startsWith('..')&&!path.isAbsolute(r);};
if(!values.request||!values.out||!values.storage||![values.request,values.out,values.storage].every(within))throw Error('PRIVATE_OPERATOR_PATHS_REQUIRED');
const request=validateControlledProRequest(JSON.parse(await ordinaryFile(path.dirname(values.request),path.basename(values.request))));
const provider=createCodexProductProvider({storage:values.storage});
const login=await provider.preflight();
// Reserve output before inference, preventing an accidental second execution.
const output=await fs.open(values.out,'wx',0o600);
try{
  const value=await provider({packet:request.packet,runId:request.runId});
  await output.writeFile(JSON.stringify({schemaVersion:1,permitId:request.permitId,runId:request.runId,inputHash:request.inputHash,value},null,2)+'\n');await output.sync();
  console.log(JSON.stringify({status:'LOCAL_PRO_RESULT_READY',projectId:request.projectId,runId:request.runId,inputHash:request.inputHash,login:login.auth,cliVersion:login.version,durationMs:value.execution.durationMs,tokens:value.execution.usage,apiCalls:0,incrementalApiCostEur:0,allocatedProCostEur:null}));
}catch(error){await output.writeFile(JSON.stringify({status:'PAUSED_DO_NOT_RERUN',code:error.code??'PROVIDER_FAILED'})+'\n');throw error;}finally{await output.close();}
