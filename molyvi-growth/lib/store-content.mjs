import crypto from 'node:crypto';
import {normalizeReturnsPlan as returnsCore,normalizePolicyInputs as policiesCore,normalizePageContent as pagesCore,renderStoreContent} from '../../molyvi-contract/lib/store-content.mjs';
import {canonicalJson,IntakeError} from './intake-store.mjs';
import {packageForOrder} from './service-offer.mjs';

const fail=(code,status=422,details)=>{throw new IntakeError(code,status,details);};
function adapt(fn,input,options){try{return fn(input,options);}catch(error){if(error.code)fail(error.code,422,{field:error.field,...error.details});throw error;}}
export const normalizeReturnsPlan=(input,options)=>adapt(returnsCore,input,options);
export const normalizePolicyInputs=(input,options)=>adapt(policiesCore,input,options);
export const normalizePageContent=(input,options)=>adapt(pagesCore,input,options);
const taskIds=['business','merchant','operations','payouts','returns','policies','pages'];
const answers=(record,id)=>record.tasks[id]?.submission?.answers??record.tasks[id]?.draft??{};
const digest=value=>crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');

// These are private drafts. Reading never queues AI, modifies credits, sends a
// message or applies content to Shopify. Hashes bind review to exact inputs/text.
export function previewStoreContent(record){
  if(record.contentContractVersion!==1)fail('CONTENT_NOT_AVAILABLE',409);
  if(record.order.status!=='verified_paid')fail('PAYMENT_REQUIRED',402);
  const sourceRevisions=Object.fromEntries(taskIds.map(id=>[id,{revision:record.tasks[id]?.revision??null,submissionHash:record.tasks[id]?.submission?.hash??null}]));
  const draft=renderStoreContent({business:answers(record,'business'),merchantProfile:answers(record,'merchant').merchantProfile,
    shippingPlan:answers(record,'operations').shippingPlan,paymentPlan:answers(record,'payouts').paymentPlan,
    returnsPlan:answers(record,'returns').returnsPlan,policyInputs:answers(record,'policies').policyInputs,
    pageContent:answers(record,'pages').pageContent,packageId:packageForOrder(record.order).id});
  const unsigned={schemaVersion:1,...draft,sourceRevisions};
  const bundleHash=digest(unsigned),allInputsSubmitted=taskIds.every(id=>record.tasks[id]?.submission);
  const approval=record.contentReview?.bundleHash===bundleHash?structuredClone(record.contentReview):null;
  return {...unsigned,bundleHash,allInputsSubmitted,reviewAllowed:allInputsSubmitted&&draft.pending.length===0,
    approval,publicationAuthorized:false,publishable:false,legalCertification:false};
}

export function reviewStoreContent(record,{bundleHash,acknowledged},now=Date.now()){
  if(acknowledged!==true)fail('CONTENT_REVIEW_ACK_REQUIRED');
  const bundle=previewStoreContent(record);
  if(typeof bundleHash!=='string'||bundleHash!==bundle.bundleHash)fail('CONTENT_REVIEW_STALE',409);
  if(!bundle.reviewAllowed)fail('CONTENT_REVIEW_INCOMPLETE');
  if(bundle.approval)return {bundleHash,duplicate:true,publicationAuthorized:false};
  record.contentReview={bundleHash,templateVersion:bundle.templateVersion,reviewedAt:new Date(now).toISOString(),
    sourceRevisions:bundle.sourceRevisions,status:'merchant_review_recorded',legalCertification:false,publicationAuthorized:false};
  record.contentReviews??={};
  record.contentReviews[bundleHash]={...structuredClone(record.contentReview),documents:structuredClone(bundle.documents)};
  return {bundleHash,duplicate:false,publicationAuthorized:false};
}
