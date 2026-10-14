import crypto from 'node:crypto';
import {canonicalJson,IntakeError} from './intake-store.mjs';
import {productLimit,productLocked} from './product-materials.mjs';
import {validateSessionExecution} from './session-execution.mjs';
import {packageForOrder} from './service-offer.mjs';

export const TEXT_VARIANT_LIMIT=5;
const variantLimit=project=>packageForOrder(project.order).entitlements.aiTextVersionsPerField;
const fields=['title','description'];
const uuid=value=>typeof value==='string'&&/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(value);
const fail=(code,status=409)=>{throw new IntakeError(code,status,{field:'products'});};
const flag=field=>field==='title'?'improveTitle':'improveDescription';
const products=project=>(project.tasks.catalog.submission?.answers??project.tasks.catalog.draft).products??[];
function productFor(project,productId,field,editable=true){
  if(project.order.status!=='verified_paid')fail('PAYMENT_REQUIRED',402);
  if(!fields.includes(field))fail('INVALID_TEXT_FIELD',400);
  if(editable&&productLocked(project,productId))fail(project.tasks.catalog.submission?'TASK_LOCKED':'PRODUCT_LOCKED');
  return products(project).find(product=>product.id===productId)??fail('PRODUCT_NOT_FOUND',404);
}
function sourceFor(project,product,field){
  return {field,title:product.title,description:product.description,
    ...(product.category!==undefined?{category:product.category}:{}),
    ...(product.facts!==undefined?{facts:structuredClone(product.facts)}:{}),
    ...(product.variants?{variants:structuredClone(product.variants)}:{}),
    business:structuredClone(project.tasks.business.submission?.answers??project.tasks.business.draft),
    branding:structuredClone(project.tasks.branding.submission?.answers??project.tasks.branding.draft)};
}
const hash=source=>crypto.createHash('sha256').update(canonicalJson(source)).digest('hex');
const ledger=(project,productId,field)=>project.productTexts?.[productId]?.[field];
const countedRequests=state=>(state?.requests??[]).filter(request=>request.allowanceReleased!==true);
function provablyUnstarted(project,productId,field,request){
  const matching=Object.values(project.productProductionQueue?.jobs??{}).filter(job=>job.kind==='text'&&job.productId===productId&&job.field===field&&job.requestId===request.id&&job.sourceHash===request.inputHash);
  const prepared=Object.values(project.productPilotPackets??{}).some(packet=>packet.kind==='text'&&packet.productId===productId&&packet.field===field&&packet.requestId===request.id);
  return matching.length===1&&matching[0].status==='queued'&&!matching[0].attemptStartedAt&&!prepared;
}

// A changed draft makes the previous pending output unusable. Preserve history;
// only a provably undispatched reservation releases its allowance.
// Unknown usage and review holds remain explicit; cancellation is not a refund.
export function cancelStaleTextRequests(project,{productId}={}){
  let cancelled=0;
  for(const [id,states]of Object.entries(project.productTexts??{})){
    if(productId!==undefined&&id!==productId||productLocked(project,id))continue;
    const product=products(project).find(item=>item.id===id);
    for(const field of fields){
      const state=states[field];if(!state)continue;
      const currentHash=product?hash(sourceFor(project,product,field)):null;
      for(const request of state.requests)if(request.status==='awaiting_provider'&&(!product||!product[flag(field)]||request.inputHash!==currentHash)){
        // Only durable queue evidence can establish that no dispatch began.
        // A prepared operator packet or ambiguous attempt still consumes its slot.
        if(provablyUnstarted(project,id,field,request))request.allowanceReleased=true;
        request.status='cancelled_stale';request.cancelledAt=new Date().toISOString();
        request.cancellationReason=!product?'product_removed':!product[flag(field)]?'opt_out':'source_changed';cancelled++;
      }
    }
  }
  return {cancelled};
}

// Durable reservation only: no provider call or charge is made by this local prototype.
export function requestTextVariant(project,{productId,field,requestId}){
  const product=productFor(project,productId,field);
  if(!uuid(requestId))fail('INVALID_REQUEST',400);
  if(!product[flag(field)])fail('TEXT_OPT_IN_REQUIRED',422);
  if(!product.title||!product.description)fail('INPUT_INCOMPLETE',422);
  cancelStaleTextRequests(project,{productId});
  const source=sourceFor(project,product,field),inputHash=hash(source),old=ledger(project,productId,field);
  const repeated=old?.requests.find(request=>request.id===requestId);
  if(repeated){if(repeated.inputHash!==inputHash)fail('TEXT_REQUEST_STALE');return structuredClone(repeated);}
  const pending=old?.requests.find(request=>request.status==='awaiting_provider');
  if(pending)return structuredClone(pending); // Repeated clicks with unchanged inputs share one outstanding request.
  if(old?.requests.some(request=>['paused_unknown','needs_review'].includes(request.status)))fail('TEXT_REVIEW_REQUIRED');
  if(countedRequests(old).length>=variantLimit(project))fail('TEXT_VARIANT_LIMIT');
  // A deleted/recreated product must not reset the paid project's total allowance.
  const total=Object.values(project.productTexts??{}).flatMap(product=>Object.values(product)).reduce((sum,state)=>sum+countedRequests(state).length,0);
  if(total>=productLimit(project)*fields.length*variantLimit(project))fail('TEXT_PROJECT_LIMIT');
  project.productTexts??={};project.productTexts[productId]??={};
  const state=project.productTexts[productId][field]??={requests:[],selected:'original',selectionConfirmed:false};
  const request={id:requestId,inputHash,source,status:'awaiting_provider',requestedAt:new Date().toISOString(),costEur:null,text:null};
  state.requests.push(request);return structuredClone(request);
}

// Trusted adapter completion only. Never exposed as a browser/client result endpoint.
// The future adapter must use budgeted execution, measured usage and factual validation.
export function recordTextVariant(project,{productId,field,requestId,inputHash,text,costEur,factsVerified,executionEvidence}){
  if(!fields.includes(field))fail('INVALID_TEXT_FIELD',400);
  const request=ledger(project,productId,field)?.requests.find(request=>request.id===requestId);
  if(!request||request.inputHash!==inputHash)fail('TEXT_REQUEST_STALE');
  if(request.status!=='awaiting_provider')return structuredClone(request); // A repeated completion cannot double-record usage.
  const sessionEvidence=executionEvidence===undefined?null:validateSessionExecution(executionEvidence);
  if(sessionEvidence&&costEur!==null)fail('SESSION_ALLOCATION_MUST_REMAIN_UNKNOWN',422);
  request.completedAt=new Date().toISOString();
  if(!sessionEvidence&&(typeof costEur!=='number'||!Number.isFinite(costEur)||costEur<0)){request.status='paused_unknown';return structuredClone(request);}
  request.costEur=costEur;
  if(sessionEvidence)request.executionEvidence=sessionEvidence;
  if(factsVerified!==true||typeof text!=='string'||!text.trim()||text.length>(field==='title'?200:4000)||/[<>\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)){
    request.status='needs_review';return structuredClone(request);
  }
  request.text=text.trim();request.status='completed';return structuredClone(request);
}

export function selectTextVariant(project,{productId,field,variantId}){
  const product=productFor(project,productId,field);
  cancelStaleTextRequests(project,{productId});
  project.productTexts??={};project.productTexts[productId]??={};
  const state=project.productTexts[productId][field]??={requests:[],selected:'original',selectionConfirmed:false};
  if(variantId==='original'){state.selected='original';state.selectionConfirmed=true;return {selected:'original'};}
  if(!product[flag(field)])fail('TEXT_OPT_IN_REQUIRED',422);
  const candidate=state?.requests.find(request=>request.id===variantId&&request.status==='completed');
  if(!candidate)fail('TEXT_VARIANT_NOT_FOUND',404);
  if(candidate.inputHash!==hash(sourceFor(project,product,field)))fail('TEXT_REQUEST_STALE');
  state.selected=variantId;state.selectionConfirmed=true;return {selected:variantId}; // Selection creates no request and calls no provider.
}

export function publicProductTexts(project){
  return {limit:variantLimit(project),products:Object.fromEntries(products(project).map(product=>[product.id,
    Object.fromEntries(fields.map(field=>{
      const state=ledger(project,product.id,field),inputHash=hash(sourceFor(project,product,field));
      const selected=state?.requests.find(request=>request.id===state.selected&&request.status==='completed'&&request.inputHash===inputHash);
      return [field,{selected:product[flag(field)]&&selected?selected.id:'original',selectionConfirmed:state?.selectionConfirmed===true,used:countedRequests(state).length,
        requests:(state?.requests??[]).map(({id,status,inputHash:sourceHash,text})=>({id,status,text,current:inputHash===sourceHash}))}];
    }))] ))};
}

// A separate immutable final-copy snapshot preserves the customer's source fields.
export function finalizeProductTexts(project,finalProducts){
  return finalProducts.map(product=>({productId:product.id,...Object.fromEntries(fields.map(field=>{
    const state=ledger(project,product.id,field);
    if(state?.requests.some(request=>!['completed','cancelled_stale'].includes(request.status)))fail('TEXT_REVIEW_REQUIRED',422);
    if(product[flag(field)]&&!state?.selectionConfirmed)fail('TEXT_SELECTION_REQUIRED',422);
    const candidate=state?.requests.find(request=>request.id===state.selected);
    if(product[flag(field)]&&candidate&&candidate.inputHash!==hash(sourceFor(project,product,field)))fail('TEXT_REQUEST_STALE',422);
    return [field,{variantId:product[flag(field)]&&candidate?candidate.id:'original',text:product[flag(field)]&&candidate?candidate.text:product[field]}];
  }))}));
}
