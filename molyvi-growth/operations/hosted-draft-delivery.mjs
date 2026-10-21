import fs from 'node:fs/promises';
import path from 'node:path';
import {canonicalJson} from '../lib/intake-store.mjs';
import {sha256} from '../lib/service-handoff.mjs';
import {prepareDraftDelivery} from '../lib/draft-delivery.mjs';
import {writeRevisionFile} from '../lib/delivery-revision.mjs';

export const DRAFT_HANDOFF_ROOT='/opt/render/project/src/briefs/molyvi-draft-handoff-20261021-r1';
const SOURCE='/opt/render/project/src/briefs/molyvi-hosted-staging';
const CONTROL=SOURCE+'/controlled-operations/basic-reference-1005-r2';
const BUILD=CONTROL+'/builds/4923cd43-11b7-47ed-a912-1b06458a6557-6532aa49-229d-4a59-b6b8-3ec6e4e5afcb';
const need=(v,c)=>{if(!v)throw Error(c);};
const authorities=new WeakSet(),hash=v=>sha256(canonicalJson(v)),save=(root,file,v)=>writeRevisionFile(root,file,Buffer.from(JSON.stringify(v,null,2)+'\n'));
export function validateDraftHandoffPermit(p,{release,serviceId,source,now=Date.now()}={}){
 need(p?.schemaVersion===1&&p.kind==='molyvi_draft_delivery_1005_v1'&&p.release===release&&/^[a-f0-9]{40}$/.test(release??'')&&p.serviceId===serviceId&&serviceId==='srv-db7othjrjlhs73cg7lf0'&&source===SOURCE,'DRAFT_HANDOFF_SCOPE');
 const {permitHash,...body}=p;need(hash(body)===permitHash,'DRAFT_HANDOFF_PERMIT_HASH');
 need(p.publicationAuthorized===false&&p.newChargesAuthorized===false&&p.notificationsEnabled===false,'DRAFT_HANDOFF_SCOPE');
 const s=p.scope;need(s.projectId==='4923cd43-11b7-47ed-a912-1b06458a6557'&&s.accountId==='d01d2b55-1f1b-42e9-bff7-6a9573b4892e'&&s.ownerId==='a83f86bc-85dd-41cb-9f08-9db072c695b9'&&s.orderId==='SHOPIFY-TEST-8303701098833'&&s.store==='molyvi-still-dev.myshopify.com'&&s.themeId==='209012687185'&&s.sourceHash==='6f4ef8317979612e1fcbcb39c5e78b430ee10de543d3d252b2e42131a882f385'&&s.planHash==='9acbe7f1c765ca10c7bae66d573ff87150383c2a86d267c7bd9dc06ce7ac753a','DRAFT_HANDOFF_IDENTITY');
 need(s.previousDeliveries?.length===2&&s.previousDeliveries[0].id==='548c1930-5fc5-4064-a72a-56e08499bb91'&&s.previousDeliveries[1].id==='09f75e0f-20a8-4ce8-9dca-04e1e45bcf8a','DRAFT_HANDOFF_HISTORY');
 need(Array.isArray(s.inputs)&&s.inputs.length>=14&&s.inputs.every(e=>[BUILD+'/package',BUILD+'/theme',CONTROL+'/resume-r7',DRAFT_HANDOFF_ROOT,'/opt/render/project/src/briefs'].includes(e.root)&&/^[a-f0-9]{64}$/.test(e.sha256)&&Number.isSafeInteger(e.bytes)&&e.bytes>=0),'DRAFT_HANDOFF_PINS');
 need(Number.isFinite(Date.parse(p.expiresAt))&&Date.parse(p.expiresAt)>Date.parse(p.createdAt)&&Date.parse(p.expiresAt)-Date.parse(p.createdAt)<=2*3600000,'DRAFT_HANDOFF_WINDOW');
 return{source,controlRoot:DRAFT_HANDOFF_ROOT,packageRoot:BUILD+'/package',themeRoot:BUILD+'/theme',completionFile:CONTROL+'/resume-r7/complete.json',reviewFile:DRAFT_HANDOFF_ROOT+'/visual-review.json',handbookFile:DRAFT_HANDOFF_ROOT+'/Molyvi-Service-Handbook.pdf',scope:s,permitHash,expiresAt:p.expiresAt,release};
}
export async function loadHostedDraftHandoff({source,release,serviceId}){
 let raw;try{raw=await fs.readFile(DRAFT_HANDOFF_ROOT+'/permit.json');}catch(e){if(e.code==='ENOENT')return null;throw e;}
 need(raw.length<=32768,'DRAFT_HANDOFF_PERMIT_SIZE');const config=validateDraftHandoffPermit(JSON.parse(raw),{source,release,serviceId});authorities.add(config);return config;
}
// Completion is bound to the durable delivery row and archive. An interrupted
// operation is preserved for operator reconciliation, never replayed.
export async function runHostedDraftHandoff({app,config}){
 need(authorities.has(config),'DRAFT_HANDOFF_AUTHORITY');
 return app.withStartupPreparationResources(async()=>{
  let done;try{done=JSON.parse(await fs.readFile(config.controlRoot+'/complete.json'));}catch(e){if(e.code!=='ENOENT')throw e;}
  if(done){const {receiptHash,...body}=done;need(hash(body)===receiptHash&&done.permitHash===config.permitHash&&done.result?.status==='PASS','DRAFT_HANDOFF_COMPLETION');const row=app.accounts.delivery(config.scope.accountId,done.result.deliveryId);need(row.project_id===config.scope.projectId&&row.manifest_hash===done.result.manifestHash&&row.zip_hash===done.result.zip.sha256,'DRAFT_HANDOFF_COMPLETION');await app.deliveries.verify(row);return{status:'SKIP_VERIFIED_PASS',allowAutomaticStart:true};}
  need(Date.now()<Date.parse(config.expiresAt),'DRAFT_HANDOFF_EXPIRED');
  await save(config.controlRoot,'attempt.json',{permitHash:config.permitHash,release:config.release,pid:process.pid,startedAt:new Date().toISOString()});
  let samples=0,peak=0,stop=false;const sample=()=>{samples++;peak=Math.max(peak,process.memoryUsage().rss);if(peak>416*1024*1024)stop=true;};sample();const timer=setInterval(sample,100);
  const guard=()=>{sample();need(!stop,'DRAFT_HANDOFF_MEMORY_LIMIT');need(Date.now()<Date.parse(config.expiresAt),'DRAFT_HANDOFF_EXPIRED');};
  try{const result=await prepareDraftDelivery({app,config:{...config,guard}});guard();result.memory={samples,peakRss:peak,kernelMaxRssKiB:process.resourceUsage().maxRSS,rssLimit:416*1024*1024};const body={permitHash:config.permitHash,result};await save(config.controlRoot,'complete.json',{...body,receiptHash:hash(body)});return result;}
  catch(error){await save(config.controlRoot,'failure.json',{permitHash:config.permitHash,code:/^[A-Z0-9_]+$/.test(error.message)?error.message:'DRAFT_HANDOFF_FAILED',at:new Date().toISOString(),samples,peakRss:peak});throw error;}
  finally{clearInterval(timer);}
 });
}
