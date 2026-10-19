import crypto from 'node:crypto';
import {canonicalJson} from './intake-store.mjs';
import {TASK_SCHEMA_VERSION} from './task-workspace.mjs';
import {packageForOrder} from './service-offer.mjs';
import {serviceProductionEligible,applyServiceBusinessResult} from './service-production-queue.mjs';
import {approvedBrandPresentation} from './brand-presentation.mjs';
import {catalogCounts,normalizeCatalogFields,CATALOG_TECHNICAL_LIMITS} from './catalog-model.mjs';
import {finalizeProductTexts} from './product-text.mjs';
import {gallerySelectionSnapshot,photoSourceForSlot} from './product-gallery.mjs';
import {productPhotoPlan,photoPresentationPlan} from './product-photo-plan.mjs';
import {preparePhotoExecution} from './product-photo-execution.mjs';
import {validateSessionExecution} from './session-execution.mjs';
import {SERVICE_OPERATION_TASK_IDS,readServiceOperation} from './service-operations.mjs';
import {previewStoreContent} from './store-content.mjs';

const hash=value=>crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
const equal=(a,b)=>canonicalJson(a)===canonicalJson(b);
const isHash=value=>typeof value==='string'&&/^[a-f\d]{64}$/.test(value);
const uuid=value=>typeof value==='string'&&/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(value);
const requireValue=value=>{if(!value)throw new Error('INVALID_METADATA');};
const commonIds=['business','branding','photos',...SERVICE_OPERATION_TASK_IDS];
const pageIds=['terms','privacy','returns','shipping','about','contact','faq'];
const terminalRequests=new Set(['completed','failed_no_output','cancelled']);
const pendingClaims=new Set(['awaiting_review','needs_specialist','escalated']);
const assetMetadata=asset=>asset&&uuid(asset.id)&&isHash(asset.sha256)&&Number.isSafeInteger(asset.bytes)&&asset.bytes>0&&['image/png','image/jpeg','image/webp'].includes(asset.mime)&&typeof asset.name==='string'&&asset.name.length>0;
// Match the assembler's conservative total input ceiling without importing its
// byte-reading implementation. A focused test pins equality with that constant.
export const BASIC_SUBMISSION_INPUT_BYTES_CAP=128*1024*1024;

// Pure metadata inspection. It never loads asset bytes, creates a package,
// grants Shopify access or changes a submission. The stored assembler remains
// the authority for byte integrity and exact package validation. A ready result
// still needs explicit owner confirmation of this roster and these selections.
export function inspectBasicSubmissionReadiness(record){
  const sourceHash=hash(record??null),blockers=[],stages=[],source={productIds:[],productSubmissionHashes:{},selectedCandidates:[]};
  const summary={products:0,visualUnits:0,photos:0,pages:0};
  const add=(stage,code,message,context={})=>{
    if(blockers.some(item=>item.code===code&&item.taskId===context.taskId&&item.productId===context.productId))return;
    blockers.push({code,...context,message});stages.push(stage);
  };
  const check=(stage,code,message,context,operation)=>{try{requireValue(operation());return true;}catch{add(stage,code,message,context);return false;}};
  const finish=()=>({schemaVersion:1,sourceHash,state:stages.includes('inputs_pending')?'inputs_pending':stages.includes('production_pending')?'production_pending':blockers.length?'review_pending':'ready_for_preparation',ready:blockers.length===0,requiresCatalogConfirmation:true,blockers,summary,source,
    assurance:{assetBytesVerified:false,customerAcceptance:false,legalCertification:false,publicationAuthorized:false}});
  if(!record||record.schemaVersion!==TASK_SCHEMA_VERSION||!uuid(record.id)||!uuid(record.ownerId)||!record.tasks||!record.jobs){add('inputs_pending','PROJECT_INPUT_INVALID','Το έργο χρειάζεται έλεγχο πριν προετοιμαστεί το κατάστημα.');return finish();}
  check('inputs_pending','VERIFIED_BASIC_REQUIRED','Χρειάζεται επιβεβαιωμένη δοκιμαστική παραγγελία Basic σε ευρώ.',{},()=>{
    const offer=packageForOrder(record.order);
    return serviceProductionEligible(record)&&/^\d+$/.test(record.servicePurchase.receipt.orderId)&&record.order.packageId==='basic'&&record.order.currency==='EUR'&&offer.id==='basic'&&offer.entitlements.catalogUnits===10&&offer.entitlements.photoSlotsPerUnit===3&&offer.entitlements.photoSlots===30&&(!record.order.offerSnapshot||equal(record.order.entitlements,offer.entitlements)&&record.order.packageId===record.order.offerSnapshot.packageId);
  });
  for(const taskId of commonIds){
    const task=record.tasks[taskId],submission=task?.submission,context={taskId};
    if(!submission){add('inputs_pending','TASK_SUBMISSION_REQUIRED','Οριστικοποίησε τα στοιχεία αυτού του βήματος.',context);continue;}
    if(!check('review_pending','TASK_SOURCE_CHANGED','Η οριστική υποβολή χρειάζεται έλεγχο ακεραιότητας.',context,()=>isHash(submission.hash)&&submission.hash===hash({projectId:record.id,taskId,schemaVersion:record.schemaVersion,answers:submission.answers,...(submission.productCopy?{productCopy:submission.productCopy}:{})})))continue;
    const job=record.jobs[`${submission.hash}:work`];
    if(job?.status!=='succeeded'){add('production_pending','TASK_PRODUCTION_PENDING','Η προετοιμασία αυτού του βήματος δεν έχει ολοκληρωθεί.',context);continue;}
    check('review_pending','TASK_RESULT_CHANGED','Το αποτέλεσμα αυτού του βήματος χρειάζεται επανέλεγχο.',context,()=>job.result&&job.result.hash===hash(job.result.output)&&job.inputs?.submissionHash===submission.hash&&equal(job.inputs?.answers,submission.answers));
  }
  if(record.tasks.business?.submission&&record.jobs[`${record.tasks.business.submission.hash}:work`]?.status==='succeeded')check('review_pending','BUSINESS_RECEIPT_INVALID','Χρειάζεται έλεγχος της ολοκληρωμένης επιχειρηματικής κατεύθυνσης.',{taskId:'business'},()=>applyServiceBusinessResult(structuredClone(record),`${record.tasks.business.submission.hash}:work`).duplicate===true);
  let branding=null;
  check('review_pending','BRANDING_APPROVAL_REQUIRED','Έλεγξε και ενέκρινε την προτεινόμενη εμφάνιση.',{taskId:'branding'},()=>{branding=approvedBrandPresentation(record);return Boolean(branding);});
  if(branding){
    check('inputs_pending','BRANDING_MODE_UNSUPPORTED','Για αυτή την προετοιμασία χρειάζεται το όνομα ως κείμενο ή το δικό σου λογότυπο.',{taskId:'branding'},()=>['text','existing'].includes(branding.logoMode));
    if(branding.logoMode==='existing')check('review_pending','LOGO_REFERENCE_INVALID','Το ανεβασμένο λογότυπο χρειάζεται έλεγχο.',{taskId:'branding'},()=>assetMetadata(record.brandAssets?.[branding.logoAssetId])&&record.brandAssets[branding.logoAssetId].sha256===branding.logoSha256);
  }
  if(record.tasks.photos?.submission&&record.jobs[`${record.tasks.photos.submission.hash}:work`]?.status==='succeeded')check('review_pending','PHOTO_PLAN_CHANGED','Οι οδηγίες παρουσίασης χρειάζονται επανέλεγχο.',{taskId:'photos'},()=>{
    const job=record.jobs[`${record.tasks.photos.submission.hash}:work`];return equal(job.result.output,photoPresentationPlan(record));
  });
  for(const taskId of SERVICE_OPERATION_TASK_IDS){
    if(record.tasks[taskId]?.submission&&record.jobs[`${record.tasks[taskId].submission.hash}:work`]?.status==='succeeded')check('review_pending','OPERATION_RESULT_INVALID','Οι ρυθμίσεις αυτού του βήματος χρειάζονται έλεγχο.',{taskId},()=>Boolean(readServiceOperation(record,taskId)));
  }
  if(record.tasks.returns?.submission)check('inputs_pending','PRODUCT_SCOPE_UNSUPPORTED','Η προετοιμασία Basic αφορά συνήθη φυσικά προϊόντα.',{taskId:'returns'},()=>equal(record.tasks.returns.submission.answers.returnsPlan.productCharacteristics,['ordinary_goods']));
  if(commonIds.every(id=>record.tasks[id]?.submission))check('review_pending','CONTENT_INCOMPLETE','Τα προσχέδια των σελίδων χρειάζονται συμπλήρωση ή έλεγχο.',{taskId:'pages'},()=>{
    const content=previewStoreContent(record);summary.pages=content.documents.length;
    // Existing private-Draft workflow permits an unreviewed content bundle.
    // This is not legal certification or permission to publish it.
    return content.allInputsSubmitted&&!content.pending.length&&content.documents.length===7&&pageIds.every(id=>content.documents.filter(document=>document.id===id).length===1);
  });
  const products=record.tasks.catalog?.draft?.products;
  if(!Array.isArray(products)||!products.length){add('inputs_pending','CATALOG_EMPTY','Πρόσθεσε και οριστικοποίησε τουλάχιστον ένα προϊόν.',{taskId:'catalog'});return finish();}
  if(products.some(product=>!product||typeof product!=='object'||Array.isArray(product))){add('inputs_pending','CATALOG_INVALID','Τα στοιχεία του καταλόγου χρειάζονται έλεγχο.',{taskId:'catalog'});return finish();}
  summary.products=products.length;source.productIds=products.map(product=>product.id);
  check('inputs_pending','CATALOG_ALLOWANCE_INVALID','Έλεγξε τον αριθμό προϊόντων, παραλλαγών και φωτογραφικών παρουσιάσεων του Basic.',{taskId:'catalog'},()=>{
    const counts=catalogCounts(products,3);summary.visualUnits=counts.visualUnits;summary.photos=counts.initialPhotoSlots;
    return products.length<=10&&products.every(p=>uuid(p.id))&&new Set(source.productIds).size===products.length&&counts.visualUnits>0&&counts.visualUnits<=10&&counts.variants<=CATALOG_TECHNICAL_LIMITS.variantsPerProject;
  });
  for(const product of products){
    const context={productId:product.id},submission=record.productTasks?.[product.id]?.submission;
    check('inputs_pending','PRODUCT_FIELDS_INCOMPLETE','Συμπλήρωσε τις τιμές, τα αποθέματα και τις παραλλαγές του προϊόντος.',context,()=>{
      const clean=normalizeCatalogFields(record,product,{complete:true});
      return Array.isArray(product.visualUnits)&&Array.isArray(product.variants)&&equal(clean.variants,product.variants)&&equal(clean.visualUnits,product.visualUnits)
        &&product.variants.every(variant=>Number.isSafeInteger(variant.priceMinor)&&variant.priceMinor>=0
          &&Number.isSafeInteger(variant.stock)&&variant.stock>=0&&variant.stock<=2147483647
          &&(variant.weightGrams===null||Number.isSafeInteger(variant.weightGrams)&&variant.weightGrams>=0&&variant.weightGrams<=2147483647));
    });
    if(!submission){add('inputs_pending','PRODUCT_SUBMISSION_REQUIRED','Οριστικοποίησε αυτό το προϊόν για να προχωρήσει η προετοιμασία.',context);continue;}
    source.productSubmissionHashes[product.id]=submission.hash;
    if(!check('review_pending','PRODUCT_SOURCE_CHANGED','Η οριστική υποβολή του προϊόντος χρειάζεται επανέλεγχο.',context,()=>{
      const {hash:submissionHash,submittedAt,...frozen}=submission;
      return isHash(submissionHash)&&hash({projectId:record.id,productId:product.id,schemaVersion:record.schemaVersion,...frozen})===submissionHash&&equal(product,submission.product)&&equal(finalizeProductTexts(record,[product])[0],submission.productCopy);
    }))continue;
    check('review_pending','SOURCE_PHOTO_REFERENCE_INVALID','Οι αρχικές φωτογραφίες του προϊόντος χρειάζονται έλεγχο.',context,()=>Array.isArray(submission.photoEvidence)&&submission.photoEvidence.length>0&&submission.photoEvidence.every(ref=>{const asset=record.assets?.[ref.id];return assetMetadata(asset)&&asset.id===ref.id&&asset.productId===product.id&&asset.sha256===ref.sha256;}));
    const work=record.jobs[`${submission.hash}:work`];
    if(work?.status!=='succeeded'){add('production_pending','PRODUCT_PRODUCTION_PENDING','Η παραγωγή για αυτό το προϊόν δεν έχει ολοκληρωθεί.',context);continue;}
    let plan,selection,gallery;
    if(!check('review_pending','PRODUCT_PLAN_CHANGED','Το σχέδιο παραγωγής του προϊόντος χρειάζεται επανέλεγχο.',context,()=>{
      plan=productPhotoPlan(record,product.id);gallery=record.productGalleries?.[product.id];
      const dependencies=[{id:'branding',submissionHash:record.tasks.branding.submission.hash,resultHash:record.jobs[`${record.tasks.branding.submission.hash}:work`].result.hash},{id:'photos',submissionHash:record.tasks.photos.submission.hash}];
      return work.result?.hash===hash(plan)&&equal(work.result.output,plan)&&work.inputs?.submissionHash===submission.hash&&equal(work.inputs.answers?.product,product)&&equal(work.inputs.productCopy,submission.productCopy)&&equal(work.inputs.photoEvidence,submission.photoEvidence)&&equal(work.inputs.dependencies,dependencies)&&equal(work.inputs.branding,record.tasks.branding.submission.answers)&&equal(work.inputs.presentation,record.tasks.photos.submission.answers);
    }))continue;
    if(!gallery){add('production_pending','PHOTO_GALLERY_PENDING','Οι εικόνες του προϊόντος δεν είναι ακόμη έτοιμες.',context);continue;}
    if(!check('review_pending','PHOTO_GALLERY_CHANGED','Η παρουσίαση των εικόνων χρειάζεται επανέλεγχο.',context,()=>{
      const expected=plan.slots.map(slot=>slot.id).sort();
      return gallery.sourceHash===hash(work.inputs)&&equal(gallery.source,work.inputs)&&Array.isArray(gallery.order)&&new Set(gallery.order).size===expected.length&&equal([...gallery.order].sort(),expected)&&equal(gallery.slots.map(slot=>slot.id).sort(),expected)&&gallery.slots.every(slot=>{const planned=plan.slots.find(item=>item.id===slot.id);return slot.role===planned.role&&slot.visualUnitId===planned.visualUnitId&&Array.isArray(slot.requests)&&Array.isArray(slot.candidates);});
    }))continue;
    if(gallery.slots.some(slot=>slot.requests.some(request=>!terminalRequests.has(request.status))))add('review_pending','PHOTO_REQUEST_PENDING','Υπάρχει αίτημα εικόνας σε εκκρεμότητα. Περίμενε την ολοκλήρωσή του πριν επιβεβαιώσεις την παρουσίαση.',context);
    if(gallery.slots.some(slot=>!slot.candidates.length||!slot.selected)){add('production_pending','PHOTO_SELECTION_INCOMPLETE','Περιμένουμε να ολοκληρωθούν όλες οι εικόνες αυτού του προϊόντος.',context);continue;}
    if(!check('review_pending','PHOTO_SELECTION_INVALID','Η επιλογή εικόνων χρειάζεται επανέλεγχο.',context,()=>{selection=gallerySelectionSnapshot(record,product.id);return selection.photos.length===product.visualUnits.length*3&&product.visualUnits.every(unit=>selection.photos.filter(photo=>photo.visualUnitId===unit.id).length===3);} ))continue;
    for(const photo of selection.photos){
      source.selectedCandidates.push({productId:product.id,slotId:photo.slotId,candidateId:photo.candidateId,assetId:photo.assetId,sha256:photo.sha256});
      check('review_pending','PHOTO_PROVENANCE_INVALID','Η προέλευση μίας επιλεγμένης εικόνας χρειάζεται έλεγχο πριν χρησιμοποιηθεί.',context,()=>checkPhotoMetadata(record,product,gallery,photo,work));
    }
  }
  check('inputs_pending','BASIC_PACKAGE_INPUT_BYTES_LIMIT','Το συνολικό υλικό ξεπερνά το όριο αυτής της προετοιμασίας. Χρειάζεται μείωση του μεγέθους των αρχείων πριν συνεχίσουμε.',{},()=>{
    // Same references and namespaces as checkedAssetBudget in the assembler:
    // only selected generated images, frozen originals and the approved logo.
    // Repeated references count once; unused regeneration candidates do not.
    const references=new Map();
    for(const photo of source.selectedCandidates)references.set(`generated:${photo.assetId}`,record.generatedAssets?.[photo.assetId]);
    for(const product of products)for(const ref of record.productTasks?.[product.id]?.submission?.photoEvidence??[])references.set(`source:${ref.id}`,record.assets?.[ref.id]);
    if(branding?.logoAssetId)references.set(`logo:${branding.logoAssetId}`,record.brandAssets?.[branding.logoAssetId]);
    let bytes=0;
    for(const asset of references.values()){
      requireValue(Number.isSafeInteger(asset?.bytes)&&asset.bytes>0);
      bytes+=asset.bytes;if(bytes>BASIC_SUBMISSION_INPUT_BYTES_CAP)return false;
    }
    return true;
  });
  for(const claim of Object.values(record.photoClaims??{})){
    if(!source.productIds.includes(claim.productId))continue;
    if(pendingClaims.has(claim.status))add('review_pending','PHOTO_CLAIM_PENDING','Ένα αίτημα ελέγχου εικόνας παραμένει ανοικτό.',{productId:claim.productId});
    if(claim.status==='confirmed'&&source.selectedCandidates.some(photo=>photo.productId===claim.productId&&photo.slotId===claim.slotId&&photo.candidateId===claim.candidateId))add('review_pending','SELECTED_PHOTO_DIFFERENCE_CONFIRMED','Η επιλεγμένη εικόνα έχει επιβεβαιωμένη διαφορά. Επίλεξε κατάλληλη εικόνα πριν συνεχίσουμε.',{productId:claim.productId});
  }
  return finish();
}

function checkPhotoMetadata(record,product,gallery,photo,work){
  const slot=gallery.slots.find(item=>item.id===photo.slotId),candidate=slot.candidates.find(item=>item.id===photo.candidateId),asset=record.generatedAssets?.[photo.assetId];
  requireValue(assetMetadata(asset)&&asset.id===photo.assetId&&asset.productId===product.id&&asset.sourceHash===gallery.sourceHash&&asset.visualUnitId===slot.visualUnitId&&asset.sha256===photo.sha256&&candidate?.assetId===asset.id);
  if(candidate.kind==='regeneration'){
    const matches=gallery.slots.flatMap(item=>item.requests).filter(request=>request.id===candidate.requestId),request=matches[0];
    requireValue(matches.length===1&&uuid(candidate.requestId)&&request.kind==='regeneration'&&request.status==='completed'&&request.slotId===slot.id&&request.candidateId===candidate.id&&request.assetId===asset.id&&request.sourceHash===gallery.sourceHash&&equal(request.source,photoSourceForSlot(gallery,slot.id))&&request.costEur===null);
    requireValue(['same_style','specific_change'].includes(request.mode)&&typeof request.change==='string'&&request.change.length<=2000&&(request.mode!=='specific_change'||request.change.trim()));
    requireValue(validateSessionExecution(request.executionEvidence,gallery.sourceHash).tool==='image_gen');
    const initial=slot.candidates[0],original=record.generatedAssets?.[initial?.assetId];requireValue(initial?.kind==='initial'&&original);
    return checkPhotoMetadata(record,product,gallery,{...photo,candidateId:initial.id,assetId:initial.assetId,sha256:original.sha256},work);
  }
  requireValue(candidate.kind==='initial');
  const receipts=Object.values(record.productPilotImports??{}).filter(receipt=>receipt.kind==='photos'&&receipt.productId===product.id&&receipt.slotId===slot.id&&receipt.delivered?.assetId===asset.id),receipt=receipts[0];
  requireValue(receipts.length===1);const packet=record.productPilotPackets?.[receipt.packetId],provenance=asset.photoExecution;
  requireValue(packet&&provenance&&equal(receipt.photoExecution,provenance)&&equal(receipt.delivered,candidate)&&equal(receipt.executionEvidence,asset.executionEvidence));
  const evidence=validateSessionExecution(asset.executionEvidence,packet.payloadHash),planned=work.result.output.slots.find(item=>item.id===slot.id);
  requireValue(evidence.tool==='image_gen'&&provenance.executionId===evidence.executionId&&provenance.outputSha256===asset.sha256&&provenance.planHash===work.result.hash&&planned&&provenance.promptHash===planned.promptHash&&equal(provenance.sources,planned.sources)&&isHash(provenance.specHash)&&isHash(provenance.executionPromptHash));
  requireValue(receipt.resultHash===hash({result:{slotId:slot.id,sha256:asset.sha256,name:asset.name,mime:asset.mime},evidence}));
  preparePhotoExecution(record,packet,{slotId:slot.id});return true;
}
