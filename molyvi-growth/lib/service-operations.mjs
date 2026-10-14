import crypto from 'node:crypto';
import {canonicalJson,IntakeError} from './intake-store.mjs';
import {TASKS} from './task-workspace.mjs';
import {packageForOrder} from './service-offer.mjs';
import {normalizeShippingPlan,inspectShippingPlan} from './shipping-plan.mjs';
import {normalizeMerchantProfile,inspectMerchantProfile,normalizePaymentPlan,inspectPaymentPlan} from './merchant-payments.mjs';
import {normalizeReturnsPlan,normalizePolicyInputs,normalizePageContent,previewStoreContent} from './store-content.mjs';

export const SERVICE_OPERATION_TASK_IDS=Object.freeze(['operations','merchant','payouts','returns','policies','pages']);
const contentSources=['business','merchant','operations','payouts','returns','policies','pages'];
const requiredSources={operations:['operations'],merchant:['merchant'],payouts:['merchant','payouts'],returns:['merchant','returns'],policies:contentSources,pages:contentSources};
const labels={operations:['service_shipping_plan','Αποστολές','Οι δηλωμένοι κανόνες αποστολής είναι έτοιμοι για την εφαρμογή και τον έλεγχο στο κατάστημα.'],
  merchant:['service_merchant_profile','Στοιχεία πωλητή','Τα στοιχεία πωλητή και επικοινωνίας οργανώθηκαν από τη δική σου υποβολή.'],
  payouts:['service_payment_plan','Πληρωμές','Οι επιλογές πληρωμής καταγράφηκαν. Η ενεργοποίηση παραμένει δικό σου βήμα μέσα στο Shopify μετά την παράδοση.'],
  returns:['service_returns_plan','Επιστροφές και αλλαγές','Οι δηλωμένοι κανόνες επιστροφών οργανώθηκαν για τα προσχέδια του καταστήματος.'],
  policies:['service_policy_drafts','Προσχέδια πολιτικών','Δημιουργήθηκαν τέσσερα προσχέδια από τα κλειδωμένα στοιχεία σου. Απαιτούν τελικό έλεγχο πριν χρησιμοποιηθούν.'],
  pages:['service_information_pages','Ενημερωτικές σελίδες','Δημιουργήθηκαν οι σελίδες Σχετικά, Επικοινωνία και Συχνές ερωτήσεις από τα κλειδωμένα στοιχεία σου.']};
const sha=value=>crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
const fail=code=>{throw new IntakeError(code,422);};
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);

function checkedSubmission(record,id){
  const submission=record.tasks[id]?.submission;
  if(!submission)fail('SERVICE_OPERATION_SOURCE_PENDING');
  const expected=sha({projectId:record.id,taskId:id,schemaVersion:record.schemaVersion,answers:submission.answers,...(submission.productCopy?{productCopy:submission.productCopy}:{})});
  if(expected!==submission.hash)fail('SERVICE_OPERATION_SOURCE_CHANGED');
  return submission;
}
function normalizedAnswers(record,id){
  const answers=checkedSubmission(record,id).answers;
  const merchant=()=>normalizeMerchantProfile(checkedSubmission(record,'merchant').answers.merchantProfile,{complete:true});
  let normalized;
  if(id==='operations')normalized={...answers,shippingPlan:normalizeShippingPlan(record.order,answers.shippingPlan,{complete:true})};
  if(id==='merchant')normalized={merchantProfile:normalizeMerchantProfile(answers.merchantProfile,{complete:true})};
  if(id==='payouts')normalized={paymentPlan:normalizePaymentPlan(answers.paymentPlan,{complete:true,merchantProfile:merchant()})};
  if(id==='returns')normalized={returnsPlan:normalizeReturnsPlan(answers.returnsPlan,{complete:true,merchantProfile:merchant()})};
  if(id==='policies')normalized={policyInputs:normalizePolicyInputs(answers.policyInputs,{complete:true})};
  if(id==='pages')normalized={pageContent:normalizePageContent(answers.pageContent,{complete:true})};
  if(normalized&&!same(answers,normalized))fail('SERVICE_OPERATION_SOURCE_NOT_NORMALIZED');
  return answers;
}
function checkedDependencies(record,job,visited=new Set()){
  if(visited.has(job.id))fail('SERVICE_OPERATION_DEPENDENCY_CYCLE');
  visited.add(job.id);
  const definition=TASKS.find(task=>task.id===job.taskId),submission=checkedSubmission(record,job.taskId);
  const expected=[];
  for(const id of definition.dependencies){
    const dependency=checkedSubmission(record,id),work=record.jobs[`${dependency.hash}:work`];
    if(work?.status!=='succeeded'||!work.result||sha(work.result.output)!==work.result.hash)fail('SERVICE_OPERATION_DEPENDENCY_CHANGED');
    if(TASKS.find(task=>task.id===id).approval&&record.tasks[id].approvedHash!==work.result.hash)fail('SERVICE_OPERATION_DEPENDENCY_CHANGED');
    checkedDependencies(record,work,new Set(visited));
    expected.push({id,submissionHash:dependency.hash,resultHash:work.result.hash});
  }
  if(job.inputs?.submissionHash!==submission.hash||!same(job.inputs?.answers,submission.answers)||!same(job.inputs?.dependencies,expected))fail('SERVICE_OPERATION_INPUT_CHANGED');
}

// The renderer uses seven inputs. Wait for their final submissions instead of
// capturing editable drafts or completing a document that changes on next save.
export function serviceOperationReady(record,job){
  if(!SERVICE_OPERATION_TASK_IDS.includes(job.taskId))return false;
  return job.phase==='preflight'||requiredSources[job.taskId].every(id=>record.tasks[id]?.submission);
}

export function serviceOperationPreflight(record,job){
  if(!SERVICE_OPERATION_TASK_IDS.includes(job.taskId)||job.phase!=='preflight')fail('SERVICE_OPERATION_JOB_INVALID');
  const submission=checkedSubmission(record,job.taskId);
  if(job.id!==`${submission.hash}:preflight`)fail('SERVICE_OPERATION_SOURCE_CHANGED');
  normalizedAnswers(record,job.taskId);
  return {validated:true,submissionHash:submission.hash,message:'Τα υποβληθέντα στοιχεία ελέγχθηκαν για την προετοιμασία του καταστήματος.',storeApplied:false};
}

export function buildServiceOperation(record,job){
  const id=job.taskId;
  if(!SERVICE_OPERATION_TASK_IDS.includes(id)||job.phase!=='work')fail('SERVICE_OPERATION_JOB_INVALID');
  const submission=checkedSubmission(record,id);
  if(job.id!==`${submission.hash}:work`)fail('SERVICE_OPERATION_SOURCE_CHANGED');
  if(record.operationsContractVersion!==1||record.merchantPaymentsContractVersion!==1||record.contentContractVersion!==1)fail('SERVICE_OPERATION_CONTRACT_REQUIRED');
  checkedDependencies(record,job);
  const sources=Object.fromEntries(requiredSources[id].map(taskId=>[taskId,structuredClone(normalizedAnswers(record,taskId))]));
  const sourceSubmissions=Object.fromEntries(requiredSources[id].map(taskId=>[taskId,record.tasks[taskId].submission.hash]));
  const offer=packageForOrder(record.order),sourceHash=sha({projectId:record.id,taskId:id,packageId:offer.id,offerHash:offer.offerHash,sourceSubmissions,sources});
  const [delivery,title,summary]=labels[id];
  const authority={storeApplied:false,publicationAuthorized:false,legalCertification:false};
  let data,content=null;
  if(id==='operations')data={shippingPlan:sources.operations.shippingPlan,inspection:inspectShippingPlan(record.order,sources.operations.shippingPlan),nativeSetupStatus:'pending'};
  if(id==='merchant')data={merchantProfile:sources.merchant.merchantProfile,inspection:inspectMerchantProfile(sources.merchant.merchantProfile),merchantEligibility:'not_verified',nativeSetupStatus:'pending'};
  if(id==='payouts')data={paymentPlan:sources.payouts.paymentPlan,inspection:inspectPaymentPlan(sources.payouts.paymentPlan,{merchantProfile:sources.merchant.merchantProfile}),activationStatus:'owner_setup_pending',merchantEligibility:'not_verified'};
  if(id==='returns')data={returnsPlan:sources.returns.returnsPlan,merchantSubmissionHash:sourceSubmissions.merchant,reviewStatus:'draft_requires_merchant_review',withdrawalSetupStatus:'pending'};
  if(['policies','pages'].includes(id)){
    content=previewStoreContent(record);
    if(!content.allInputsSubmitted||content.pending.length)fail('SERVICE_OPERATION_CONTENT_INCOMPLETE');
    const ids=id==='policies'?['terms','privacy','returns','shipping']:['about','contact','faq'];
    data={bundleHash:content.bundleHash,templateVersion:content.templateVersion,documents:content.documents.filter(document=>ids.includes(document.id)),
      warnings:content.warnings,pending:content.pending,publicationBlockers:content.publicationBlockers,reviewStatus:'draft_requires_merchant_review'};
    if(data.documents.length!==ids.length)fail('SERVICE_OPERATION_DOCUMENTS_MISSING');
  }
  const artifact={schemaVersion:1,taskId:id,submissionHash:submission.hash,sourceHash,sourceSubmissions,packageId:offer.id,data,...authority};
  const artifactHash=sha(artifact);
  const output={delivery,version:1,title,summary,submissionHash:submission.hash,sourceHash,artifactHash,...authority,
    ...(id==='payouts'?{activationStatus:'owner_setup_pending',merchantEligibility:'not_verified'}:{}),
    ...(content?{bundleHash:content.bundleHash,templateVersion:content.templateVersion,documents:data.documents.map(document=>({id:document.id,title:document.title,sha256:sha(document)})),reviewStatus:'draft_requires_merchant_review',publicationBlockerCount:content.publicationBlockers.length}:{})};
  return {artifact,artifactHash,output};
}

export function storeServiceOperation(record,prepared){
  record.serviceOperationArtifacts??={};
  const existing=record.serviceOperationArtifacts[prepared.artifactHash];
  if(existing&&!same(existing,prepared.artifact))fail('SERVICE_OPERATION_ARTIFACT_CONFLICT');
  record.serviceOperationArtifacts[prepared.artifactHash]=structuredClone(prepared.artifact);
}

// Read-only integrity check for delivery/assembler consumers. A saved job result
// is never treated as permission to publish, activate payments or certify law.
export function readServiceOperation(record,taskId){
  const submission=record.tasks[taskId]?.submission,job=submission&&record.jobs[`${submission.hash}:work`];
  if(job?.status!=='succeeded'||!SERVICE_OPERATION_TASK_IDS.includes(taskId))return null;
  const expected=buildServiceOperation(record,job),artifact=record.serviceOperationArtifacts?.[expected.artifactHash];
  if(!artifact||!same(artifact,expected.artifact)||job.result?.hash!==sha(expected.output)||!same(job.result?.output,expected.output))fail('SERVICE_OPERATION_RESULT_STALE');
  return structuredClone(artifact);
}
