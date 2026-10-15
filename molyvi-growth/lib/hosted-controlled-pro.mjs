import fs from 'node:fs/promises';
import path from 'node:path';
import {IntakeError,PRIVATE_ROOT} from './intake-store.mjs';
import {ordinaryFile} from './service-handoff.mjs';
import {serviceBusinessPacket,serviceProductionEligible} from './service-production-queue.mjs';

export const CONTROLLED_PRO_PROJECT='4923cd43-11b7-47ed-a912-1b06458a6557';
export const CONTROLLED_PRO_ORDER='SHOPIFY-TEST-8303701098833';
const SCOPE='molyvi_hosted_pro_business_v1',authorized=new WeakSet();
const uuid=v=>typeof v==='string'&&/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(v);
const hash=v=>typeof v==='string'&&/^[a-f\d]{64}$/.test(v);
const fail=code=>{throw new IntakeError(code,503);};
function exact(value,keys){return value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');}
async function directory(target,{create=false}={}){
  if(create)await fs.mkdir(target,{recursive:true,mode:0o700});
  const stat=await fs.lstat(target),base=await fs.realpath(PRIVATE_ROOT),real=await fs.realpath(target),relative=path.relative(base,real);
  if(stat.isSymbolicLink()||!stat.isDirectory()||!relative||relative.startsWith('..')||path.isAbsolute(relative))fail('CONTROLLED_PRO_PRIVATE_DIRECTORY_REQUIRED');
  return real;
}
async function privateJson(folder,name){
  const stat=await fs.lstat(path.join(folder,name));
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>32_768||process.platform!=='win32'&&(stat.mode&0o077))fail('CONTROLLED_PRO_PRIVATE_FILE_REQUIRED');
  return JSON.parse(await ordinaryFile(folder,name));
}
export function validateControlledProConfig(config){
  if(!exact(config,['scope','projectId','orderId','submissionHash','permitId','createdAt','expiresAt'])||config.scope!==SCOPE||
    config.projectId!==CONTROLLED_PRO_PROJECT||config.orderId!==CONTROLLED_PRO_ORDER||!hash(config.submissionHash)||!uuid(config.permitId))fail('CONTROLLED_PRO_SCOPE_INVALID');
  const created=Date.parse(config.createdAt),expires=Date.parse(config.expiresAt);
  if(!Number.isFinite(created)||!Number.isFinite(expires)||expires<=created||expires-created>20*60_000||created>Date.now()+60_000)fail('CONTROLLED_PRO_WINDOW_INVALID');
  return structuredClone(config);
}
export async function loadHostedControlledProConfig({enabled=false,folder=path.join(PRIVATE_ROOT,'molyvi-controlled-pro')}={}){
  if(!enabled)return null;
  return validateControlledProConfig(await privateJson(await directory(folder),'config.json'));
}
export function validateControlledProRequest(request){
  if(!exact(request,['schemaVersion','permitId','projectId','orderId','runId','inputHash','packet'])||request.schemaVersion!==1||
    request.projectId!==CONTROLLED_PRO_PROJECT||request.orderId!==CONTROLLED_PRO_ORDER||!uuid(request.permitId)||
    !/^production-[a-f\d-]{36}$/.test(request.runId??'')||!hash(request.inputHash)||request.packet?.kind!=='business'||request.packet.payloadHash!==request.inputHash||request.packet.assetEvidence?.length!==0)fail('CONTROLLED_PRO_REQUEST_INVALID');
  return request;
}
export const isHostedControlledPro=value=>authorized.has(value);

// A private operator handoff, never an HTTP inference endpoint. Authentication
// stays on the local machine; only this frozen business packet crosses over.
export async function createHostedControlledPro({config,storage,store,accounts,pollMs=250}={}){
  config=validateControlledProConfig(config);
  if(!store||!accounts||!Number.isInteger(pollMs)||pollMs<10||pollMs>1000)fail('CONTROLLED_PRO_CONFIG_INVALID');
  const root=await directory(storage,{create:true});
  async function source(){
    const record=JSON.parse(await ordinaryFile(await store.directory(config.projectId),'workspace.json'));
    const link=accounts.db.prepare('SELECT p.status,p.owner_id,a.email FROM payment_links p JOIN accounts a ON a.id=p.account_id WHERE p.project_id=?').get(config.projectId);
    if(!serviceProductionEligible(record)||record.order.id!==config.orderId||record.servicePurchase.intentScope!=='molyvi_hosted_test_v1'||
      record.tasks.business.submission?.hash!==config.submissionHash||link?.status!=='granted'||link.owner_id!==record.ownerId||link.email!=='aioannidis@kooqie.com')fail('CONTROLLED_PRO_SOURCE_NOT_AUTHORIZED');
    return record;
  }
  await source();
  const provider=async({packet,runId,signal})=>{
    await provider.preflight();const current=serviceBusinessPacket(await source());
    if(packet.payloadHash!==current.payloadHash||packet.submissionHash!==config.submissionHash)fail('CONTROLLED_PRO_SOURCE_CHANGED');
    const request=validateControlledProRequest({schemaVersion:1,permitId:config.permitId,projectId:config.projectId,orderId:config.orderId,runId,inputHash:packet.payloadHash,packet});
    const target=path.join(root,config.permitId);
    // Exactly one request per permit. An interrupted request is never rerun.
    await fs.mkdir(target,{mode:0o700});
    await fs.writeFile(path.join(target,'request.json'),JSON.stringify(request)+'\n',{flag:'wx',mode:0o600});
    const deadline=Math.min(Date.parse(config.expiresAt),Date.now()+9*60_000);
    while(Date.now()<deadline){
      if(signal?.aborted)fail('CONTROLLED_PRO_INTERRUPTED');
      let response;
      try{response=await privateJson(target,'response.json');}catch(error){if(error.code!=='ENOENT')throw error;}
      if(response){
        if(!exact(response,['schemaVersion','permitId','runId','inputHash','value'])||response.schemaVersion!==1||response.permitId!==config.permitId||
          response.runId!==runId||response.inputHash!==packet.payloadHash)fail('CONTROLLED_PRO_RESPONSE_MISMATCH');
        return response.value; // Queue validates model receipt and persists before import.
      }
      await new Promise(resolve=>setTimeout(resolve,pollMs));
    }
    fail('CONTROLLED_PRO_RESPONSE_TIMEOUT');
  };
  provider.preflight=async()=>{if(Date.now()>=Date.parse(config.expiresAt))fail('CONTROLLED_PRO_PERMIT_EXPIRED');await source();};
  const handle={provider,options:{projectIds:[config.projectId],taskIds:['business'],attemptLimit:1,timeoutMs:600_000,pollMs:1000}};
  authorized.add(handle);return handle;
}
