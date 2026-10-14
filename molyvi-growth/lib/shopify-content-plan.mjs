import crypto from 'node:crypto';
import {renderPublicStoreContent,escapeStoreContentHtml} from '../../molyvi-contract/lib/store-content.mjs';
import {canonicalJson,IntakeError} from './intake-store.mjs';
import {packageForOrder} from './service-offer.mjs';
import {previewStoreContent} from './store-content.mjs';

export const SHOPIFY_CONTENT_PILOT_STORE='molyvi-still-dev.myshopify.com';
export const SHOPIFY_CONTENT_PILOT_BRAND='NEMA — δοκιμαστικό κατάστημα';
export const SHOPIFY_CONTENT_PILOT_BANNER='Δοκιμαστικό κατάστημα — εικονικά στοιχεία, χωρίς πραγματικές αγορές';
const taskIds=['business','merchant','operations','payouts','returns','policies','pages'];
const documentIds=['terms','privacy','returns','shipping','about','contact','faq'];
const hash=value=>crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
const bodyHash=value=>crypto.createHash('sha256').update(value,'utf8').digest('hex');
const fail=(code,details)=>{throw new IntakeError(code,422,details);};
const exactTarget=value=>{if(value!==SHOPIFY_CONTENT_PILOT_STORE)fail('CONTENT_PLAN_TARGET_NOT_AUTHORIZED');};
const answers=(record,id)=>record.tasks?.[id]?.submission?.answers??{};

// Pure, private preparation only. Eligibility is limited to hidden fictional QA
// pages; neither this artifact nor a local content review grants write authority.
export function prepareShopifyContentPlan(record,{targetStore,allowUnreviewed=false}={}){
  exactTarget(targetStore);
  if(typeof allowUnreviewed!=='boolean')fail('CONTENT_PLAN_INVALID_OPTIONS');
  if(record?.order?.demo!==true||record.order.paymentMode!=='local_simulation')fail('CONTENT_PLAN_FICTIONAL_RECORD_REQUIRED');
  const business=answers(record,'business');
  if(business.name!==SHOPIFY_CONTENT_PILOT_BRAND)fail('CONTENT_PLAN_PILOT_BRAND_REQUIRED');
  const preview=previewStoreContent(record),missing=taskIds.filter(id=>!record.tasks?.[id]?.submission?.hash);
  const inputs={business,merchantProfile:answers(record,'merchant').merchantProfile,shippingPlan:answers(record,'operations').shippingPlan,
    paymentPlan:answers(record,'payouts').paymentPlan,returnsPlan:answers(record,'returns').returnsPlan,
    policyInputs:answers(record,'policies').policyInputs,pageContent:answers(record,'pages').pageContent,
    packageId:packageForOrder(record.order).id};
  const rendered=renderPublicStoreContent(inputs);
  const documentsMatch=rendered.documents.every(doc=>preview.documents.some(reviewed=>reviewed.id===doc.id&&reviewed.publicHtml===doc.html&&reviewed.publicText===doc.text));
  const reviewed=missing.length===0&&preview.pending.length===0&&preview.approval?.status==='merchant_review_recorded'&&preview.approval.templateVersion===preview.templateVersion&&documentsMatch;
  if(!reviewed&&!allowUnreviewed)fail('CONTENT_PLAN_CURRENT_REVIEW_REQUIRED',{missingTasks:missing,currentBundleHash:preview.bundleHash});
  if(rendered.documents.length!==documentIds.length||documentIds.some(id=>rendered.documents.filter(doc=>doc.id===id).length!==1))fail('CONTENT_PLAN_DOCUMENT_SET_INVALID');
  const banner=`<p><strong>${escapeStoreContentHtml(SHOPIFY_CONTENT_PILOT_BANNER)}</strong></p>`;
  const pages=documentIds.map(id=>{
    const doc=rendered.documents.find(item=>item.id===id);
    const page={documentId:id,title:`NEMA QA — ${doc.title}`,handle:`molyvi-pilot-nema-${id}`,bodyHtml:`${banner}\n${doc.html}`,isPublished:false};
    const pageHash=hash(page);
    return {...page,bodySha256:bodyHash(page.bodyHtml),pageHash,idempotencyKey:hash({targetStore,projectId:record.id,handle:page.handle,pageHash})};
  });
  const plan={schemaVersion:1,kind:'molyvi_hidden_dev_content_plan',targetStore,projectId:record.id,templateVersion:rendered.templateVersion,
    status:reviewed?'ready_for_hidden_dev_application':'prepared_not_reviewed',eligibleForHiddenDevApplication:reviewed,
    applicationAuthorized:false,requiresSeparateStoreAuthorization:true,publishable:false,publicationAuthorized:false,legalCertification:false,
    scope:{fictionalQa:true,visibility:'hidden',globalShopifyPolicies:false,replaceExistingPages:false,navigationChanges:false},
    source:{inputHash:hash(inputs),bundleHash:preview.bundleHash,sourceRevisions:structuredClone(preview.sourceRevisions),currentReview:reviewed?structuredClone(preview.approval):null},
    preparationBlockers:[...missing.map(taskId=>({code:'CONTENT_PLAN_INPUT_NOT_SUBMITTED',taskId})),...(!reviewed?[{code:'CONTENT_PLAN_CURRENT_REVIEW_REQUIRED'}]:[])],
    publicationBlockers:structuredClone(rendered.publicationBlockers),publicContentComplete:rendered.publicContentComplete,sources:structuredClone(rendered.sources),pages};
  return {...plan,planHash:hash(plan)};
}

function validatePlan(plan){
  exactTarget(plan?.targetStore);
  const {planHash,...unsigned}=plan;
  if(plan.kind!=='molyvi_hidden_dev_content_plan'||hash(unsigned)!==planHash||plan.publishable!==false||plan.publicationAuthorized!==false||plan.applicationAuthorized!==false)fail('CONTENT_PLAN_INTEGRITY_MISMATCH');
  if(!Array.isArray(plan.pages)||plan.pages.length!==7)fail('CONTENT_PLAN_DOCUMENT_SET_INVALID');
  for(const id of documentIds){
    const matches=plan.pages.filter(page=>page.documentId===id);if(matches.length!==1)fail('CONTENT_PLAN_DOCUMENT_SET_INVALID');
    const page=matches[0],raw=Object.fromEntries(['documentId','title','handle','bodyHtml','isPublished'].map(key=>[key,page[key]]));
    if(page.handle!==`molyvi-pilot-nema-${id}`||page.isPublished!==false||!page.title.startsWith('NEMA QA — ')||page.pageHash!==hash(raw)||page.bodySha256!==bodyHash(page.bodyHtml)||page.idempotencyKey!==hash({targetStore:plan.targetStore,projectId:plan.projectId,handle:page.handle,pageHash:page.pageHash}))fail('CONTENT_PLAN_INTEGRITY_MISMATCH');
  }
}

// Existing pages must come from a complete read of this exact store. A missing
// inventory or uncertain prior result never becomes permission to create again.
// There is deliberately no update/delete action: conflicts require inspection.
export function inspectShopifyContentConflicts(plan,{targetStore,existingPages,inventoryComplete=false,priorReceipts=[]}={}){
  exactTarget(targetStore);validatePlan(plan);
  if(!Array.isArray(existingPages)||!Array.isArray(priorReceipts))fail('CONTENT_PLAN_INVALID_OBSERVATIONS');
  const conflicts=[],actions=[];
  if(inventoryComplete!==true)conflicts.push({code:'CONTENT_PLAN_INVENTORY_INCOMPLETE'});
  for(const page of plan.pages){
    const existing=existingPages.filter(item=>item.handle===page.handle),prior=priorReceipts.filter(item=>item.handle===page.handle);
    const conflict=code=>conflicts.push({code,handle:page.handle});
    if(existing.length>1||prior.length>1){conflict('CONTENT_PLAN_DUPLICATE_OBSERVATION');continue;}
    const receipt=prior[0];
    if(receipt&&(receipt.targetStore!==targetStore||receipt.pageHash!==page.pageHash||receipt.idempotencyKey!==page.idempotencyKey||typeof receipt.pageId!=='string'||!receipt.pageId)){conflict('CONTENT_PLAN_PRIOR_RECEIPT_CONFLICT');continue;}
    if(!existing.length){if(receipt){conflict('CONTENT_PLAN_PRIOR_PAGE_NOT_FOUND');continue;}actions.push({kind:'create',handle:page.handle,page:structuredClone(page)});continue;}
    const actual=existing[0];
    if(typeof actual.id!=='string'||!actual.id||typeof actual.bodyHtml!=='string'||typeof actual.isPublished!=='boolean'){conflict('CONTENT_PLAN_PAGE_OBSERVATION_INCOMPLETE');continue;}
    if(receipt&&receipt.pageId!==actual.id){conflict('CONTENT_PLAN_PRIOR_PAGE_ID_CONFLICT');continue;}
    if(actual.title!==page.title||actual.isPublished!==false||actual.bodyHtml!==page.bodyHtml){conflict('CONTENT_PLAN_EXISTING_PAGE_CONFLICT');continue;}
    actions.push({kind:'skip_identical',handle:page.handle,pageId:actual.id,pageHash:page.pageHash,idempotencyKey:page.idempotencyKey});
  }
  return {planHash:plan.planHash,targetStore,readyForAuthorizedHiddenApplication:conflicts.length===0&&plan.eligibleForHiddenDevApplication===true,
    applicationAuthorized:false,conflicts,actions:inventoryComplete===true?actions:[]};
}
