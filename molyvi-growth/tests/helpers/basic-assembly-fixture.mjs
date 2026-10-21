import crypto from 'node:crypto';
import {canonicalJson} from '../../lib/intake-store.mjs';
import {createWorkspace,submitTask,approveTask,claimJob,finishJob,editProduct,submitProduct} from '../../lib/task-workspace.mjs';
import {createPaidOrder} from '../../lib/service-offer.mjs';
import {brandPresentation} from '../../lib/brand-presentation.mjs';
import {photoPresentationPlan,productPhotoPlan} from '../../lib/product-photo-plan.mjs';
import {requestPhotoReview,recordPhotoReview} from '../../lib/product-materials.mjs';
import {initializeGallery,recordInitialPhoto,photoSourceForSlot} from '../../lib/product-gallery.mjs';
import {preparePhotoExecution} from '../../lib/product-photo-execution.mjs';
import {serviceBusinessPacket} from '../../lib/service-production-queue.mjs';
import {SERVICE_OPERATION_TASK_IDS,serviceOperationPreflight,buildServiceOperation,storeServiceOperation} from '../../lib/service-operations.mjs';

const uuid=()=>crypto.randomUUID();
const hash=value=>crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
const targetStore='molyvi-still-dev.myshopify.com';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
const valueAt=(value,context,fallback)=>typeof value==='function'?value(context):value??fallback;
const fixtureImage=(provider,context,defaultName)=>{
  const supplied=provider?.(context)??{bytes:png,name:defaultName,mime:'image/png'};
  if(!Buffer.isBuffer(supplied.bytes)||!supplied.bytes.length||typeof supplied.name!=='string'||!['image/png','image/jpeg','image/webp'].includes(supplied.mime))throw new TypeError('Synthetic fixture image requires bytes, name and supported MIME.');
  const bytes=Buffer.from(supplied.bytes);
  return {bytes,name:supplied.name,mime:supplied.mime,sha256:crypto.createHash('sha256').update(bytes).digest('hex')};
};

/**
 * Synthetic, in-memory mechanics only. This fixture calls no model, network,
 * payment gateway, Shopify store or filesystem writer. Its default one-pixel images,
 * receipt-shaped data, reviews and approvals are NOT real payment, AI execution,
 * image fidelity, customer acceptance or installed-store evidence.
 *
 * Default: ten single-unit products / ten variants / thirty placeholder photos.
 * sizeProductCount:2 gives the historical 14-variant shape with ordinary prices.
 * withColorUnits:true gives the first product two independently reviewed units;
 * productCount then defaults to nine, retaining the ten-unit Basic allowance.
 * priceMinor/stock can be integers or functions of {productIndex,unitIndex,
 * variantIndex,size,color}; SKU can be null through missingSku or sku(context).
 * Optional sourceImage/generatedImage providers accept already-loaded bytes for
 * an explicitly synthetic display fixture. They never attest new AI execution.
 * productDetails and sizeProductIndices preserve a display example's structure.
 * sourcePhotosPerUnit (1..10) exercises the existing original-photo allowance.
 */
export function createBasicAssemblyFixture(settings={}){
  const {withColorUnits=false,sizeProductCount=0,missingSku=false,brandName='SYNTHETIC BASIC BRAND'}=settings;
  const productCount=settings.productCount??(withColorUnits?9:10);
  const sourcePhotosPerUnit=settings.sourcePhotosPerUnit??1;
  if(!Number.isSafeInteger(productCount)||productCount<1||productCount>10
    ||!Number.isSafeInteger(sizeProductCount)||sizeProductCount<0||sizeProductCount>productCount
    ||typeof withColorUnits!=='boolean'||productCount+(withColorUnits?1:0)>10
    ||!Number.isSafeInteger(sourcePhotosPerUnit)||sourcePhotosPerUnit<1||sourcePhotosPerUnit>10)throw new RangeError('Synthetic Basic fixture must contain one to ten visual units with one to ten original photos each.');
  const sizeProductIndices=settings.sizeProductIndices??Array.from({length:sizeProductCount},(_,index)=>index);
  if(!Array.isArray(sizeProductIndices)||new Set(sizeProductIndices).size!==sizeProductIndices.length||sizeProductIndices.some(index=>!Number.isSafeInteger(index)||index<0||index>=productCount))throw new RangeError('Invalid synthetic fixture size-product indices.');

  const order=createPaidOrder({id:'SHOPIFY-TEST-54321',packageId:'basic',demo:true});
  order.paymentMode='shopify_test';
  const record=createWorkspace({ownerId:uuid(),order}),assets=[],sourceAssets=[];
  // Deliberately synthetic trusted-server input, never a claim of real payment.
  record.servicePurchase={evidenceMode:'shopify_test',shopDomain:targetStore,receipt:{provider:'shopify',mode:'test',evidenceMode:'shopify_test',verifiedBy:'raw_body_hmac_sha256',shopDomain:targetStore,orderId:'54321',bodyHash:'b'.repeat(64)}};
  const submit=(taskId,answers)=>submitTask(record,{taskId,answers,revision:record.tasks[taskId].revision,acknowledged:true});
  const drain=()=>{
    let claimed;
    while((claimed=claimJob(record))){
      const job=record.jobs[claimed.id];
      let output={syntheticTestOnly:true};
      if(SERVICE_OPERATION_TASK_IDS.includes(job.taskId)){
        if(job.phase==='preflight')output=serviceOperationPreflight(record,job);
        else {const prepared=buildServiceOperation(record,job);storeServiceOperation(record,prepared);output=prepared.output;}
      }else if(job.phase==='work'){
        if(job.taskId==='business'){
          const packet=serviceBusinessPacket(record),result={summary:'Synthetic mechanics fixture',positioning:'Synthetic mechanics fixture',tone:'Synthetic mechanics fixture',explanation:'Synthetic mechanics fixture',collections:[{title:'Synthetic',purpose:'Synthetic mechanics fixture'}],missingInformation:[],limitations:['Synthetic test only; no real AI execution or customer acceptance']};
          job.providerRunId=uuid();job.providerInputHash=packet.payloadHash;
          job.providerResult={result,evidence:{billingMode:'chatgpt_session',executionId:uuid(),tool:'assistant_session',inputHash:packet.payloadHash,model:'synthetic-test-only',apiCalls:0,incrementalApiCostEur:0,allocatedCostEur:null},execution:{route:'codex_cli_chatgpt',runId:job.providerRunId,resultSha256:'f'.repeat(64),inspectedSha256:[],usage:{input_tokens:1,output_tokens:1},durationMs:1}};
          output={delivery:'pro_business_direction',...result};
        }
        if(job.taskId==='branding')output=brandPresentation(record);
        if(job.taskId==='photos')output=photoPresentationPlan(record);
        if(job.taskId==='catalog'&&job.productId)output=productPhotoPlan(record,job.productId);
      }
      finishJob(record,{jobId:job.id,leaseToken:claimed.lease.token,success:true,costEur:0,output});
    }
  };
  submit('business',{name:brandName,category:'home',activity:'Συνθετική δοκιμή σύνθεσης. Δεν αφορά πραγματικό κατάστημα.'});drain();
  let logo=null;
  if(settings.logoImage){
    const image=fixtureImage(settings.logoImage,{},'synthetic-logo.png'),asset={id:uuid(),name:image.name,mime:image.mime,bytes:image.bytes.length,sha256:image.sha256};
    record.brandAssets??={};record.brandAssets[asset.id]=asset;logo={asset,bytes:image.bytes};
  }
  submit('branding',{logoMode:logo?'existing':'text',...(logo?{logoReference:logo.asset.id}:{}),style:'minimal',palette:'minimal-graphite'});drain();
  approveTask(record,{taskId:'branding',resultHash:record.jobs[`${record.tasks.branding.submission.hash}:work`].result.hash});
  submit('photos',{mix:'white_lifestyle',instructions:settings.sourceImage||settings.generatedImage?'Συνθετική δοκιμή εμφάνισης με προϋπάρχοντα αρχεία. Δεν παράγονται νέες εικόνες AI και δεν αποτελεί έγκριση πελάτη.':'Συνθετική δοκιμή μηχανισμού. Οι εικόνες είναι placeholders ενός pixel.'});drain();

  for(let productIndex=0;productIndex<productCount;productIndex++){
    const id=uuid(),variants=[],visualUnits=[],photos=[];
    const colors=withColorUnits&&productIndex===0?['Χρυσό','Ασημί']:[null];
    for(const [unitIndex,color]of colors.entries()){
      const unitId=uuid(),sourceId=uuid(),sizes=sizeProductIndices.includes(productIndex)?['S','M','L']:[null];
      const unitVariants=sizes.map((size,variantIndex)=>{
        const context={productIndex,unitIndex,variantIndex,size,color};
        return {id:uuid(),sku:valueAt(settings.sku,context,missingSku&&productIndex===0&&unitIndex===0&&variantIndex===0?null:`SYNTHETIC-${productIndex+1}-${unitIndex+1}-${variantIndex+1}`),size,color,
          priceMinor:valueAt(settings.priceMinor,context,[2990,4990,12900][(productIndex+variantIndex)%3]),
          stock:valueAt(settings.stock,context,[12,0,100][(productIndex+variantIndex)%3]),
          weightGrams:valueAt(settings.weightGrams,context,200)};
      });
      const sourceIds=[];
      for(let photoIndex=0;photoIndex<sourcePhotosPerUnit;photoIndex++){
        const currentSourceId=photoIndex===0?sourceId:uuid();
        const image=fixtureImage(settings.sourceImage,{productIndex,unitIndex,color,photoIndex},'synthetic-source.png');
        const original={id:currentSourceId,productId:id,name:image.name,mime:image.mime,bytes:image.bytes.length,sha256:image.sha256};
        record.assets[currentSourceId]=original;sourceAssets.push({asset:original,bytes:image.bytes});photos.push(currentSourceId);sourceIds.push(currentSourceId);
      }
      variants.push(...unitVariants);
      visualUnits.push({id:unitId,color,variantIds:unitVariants.map(variant=>variant.id),sourceAssetIds:sourceIds,representationNote:'Synthetic unit: same presentation for its sizes; separate source identity for its color.'});
    }
    const details=settings.productDetails?.({productIndex})??{};
    const product={id,title:details.title??`Synthetic product ${productIndex+1}`,description:details.description??'Synthetic <not HTML> description; no real customer or product.',photos,category:details.category??'home',facts:details.facts??['Synthetic fixture only'],variants,visualUnits,improveTitle:false,improveDescription:false};
    editProduct(record,{product,revision:0});
    for(const unit of visualUnits){
      const review=requestPhotoReview(record,{productId:id,visualUnitId:unit.id});
      recordPhotoReview(record,{productId:id,visualUnitId:unit.id,reviewId:review.id,fingerprint:review.fingerprint,verdict:'match',reason:'consistent'});
    }
    submitProduct(record,{product,revision:1,acknowledged:true});drain();
    const gallery=initializeGallery(record,{productId:id}),workId=`${record.productTasks[id].submission.hash}:work`;
    for(const [unitIndex,unit]of visualUnits.entries()){
      const unitSlots=gallery.slots.filter(slot=>slot.visualUnitId===unit.id);
      const content={schemaVersion:1,kind:'photos',projectId:record.id,ownerId:record.ownerId,orderId:record.order.id,productId:id,visualUnitId:unit.id,
        assetEvidence:unit.sourceAssetIds.map(sourceId=>{const a=record.assets[sourceId];return {id:sourceId,sha256:a.sha256,bytes:a.bytes,mime:a.mime,name:a.name,file:'synthetic-private-reference'};}),
        workId,sourceHash:gallery.sourceHash,source:photoSourceForSlot(gallery,unitSlots[0].id),slots:unitSlots.map(({id,role,visualUnitId})=>({id,role,visualUnitId}))};
      const packet={...content,packetId:uuid(),payloadHash:hash(content),preparedAt:new Date(0).toISOString()};
      record.productPilotPackets??={};record.productPilotPackets[packet.packetId]=packet;
      for(const [slotIndex,slot]of unitSlots.entries()){
        const spec=preparePhotoExecution(record,packet,{slotId:slot.id});
        const image=fixtureImage(settings.generatedImage,{productIndex,unitIndex,slotIndex,role:slot.role,color:unit.color},'synthetic-generated.png');
        const sha256=image.sha256;
        const evidence={billingMode:'chatgpt_session',executionId:uuid(),tool:'image_gen',inputHash:packet.payloadHash,model:'synthetic-test-only',apiCalls:0,incrementalApiCostEur:0,allocatedCostEur:null};
        const provenance={specHash:spec.specHash,planHash:spec.planHash,promptHash:spec.promptHash,executionPromptHash:spec.executionPromptHash,sources:spec.sources,outputSha256:sha256,executionId:evidence.executionId};
        const asset={id:uuid(),productId:id,visualUnitId:unit.id,sourceHash:gallery.sourceHash,name:image.name,mime:image.mime,bytes:image.bytes.length,sha256,executionEvidence:evidence,photoExecution:provenance};
        record.generatedAssets??={};record.generatedAssets[asset.id]=asset;assets.push({asset,bytes:image.bytes});
        const candidate=recordInitialPhoto(record,{productId:id,slotId:slot.id,assetId:asset.id,galleryHash:gallery.sourceHash});
        record.productPilotImports??={};record.productPilotImports[`${packet.packetId}:${slot.id}`]={packetId:packet.packetId,kind:'photos',productId:id,slotId:slot.id,resultHash:hash({result:{slotId:slot.id,sha256,name:asset.name,mime:asset.mime},evidence}),importedAt:new Date(0).toISOString(),executionEvidence:evidence,costEur:null,delivered:structuredClone(candidate),photoExecution:provenance};
      }
    }
  }

  const answers={
    operations:{shippingPlan:{schemaVersion:1,currency:'EUR',zones:[{id:uuid(),label:'Ελλάδα',countries:['GR'],mode:'free_from_amount',basePriceMinor:375,freeFromAmountMinor:5500}],preparationTime:{minDays:1,maxDays:2,dayType:'business'},transitTime:{minDays:2,maxDays:4,dayType:'business'},pickupRequested:false}},
    merchant:{merchantProfile:{schemaVersion:1,country:'GR',businessType:'individual_or_sole_proprietor',sellerName:'SYNTHETIC SELLER',contactEmail:'test@example.invalid',address:{line1:'Συνθετική οδός 1',city:'Αθήνα',postalCode:'10558'}}},
    payouts:{paymentPlan:{schemaVersion:1,online:'shopify_payments',manualMethods:[],additionalMethods:[],activationAcknowledged:true}},
    returns:{returnsPlan:{windowMode:'statutory_only',returnShippingPayer:'buyer',returnAddressMode:'declared_store_address',offersExchanges:'no',productCharacteristics:['ordinary_goods']}},
    policies:{policyInputs:{analytics:'no',marketing:'no',serviceProviders:'Shopify για αυτήν τη συνθετική δοκιμή.',retentionCriteria:'Δηλωμένα κριτήρια συνθετικής δοκιμής προς τελικό έλεγχο.',cookieConsent:'not_configured',internationalTransfers:'no'}},
    pages:{pageContent:{aboutStory:'Συνθετική ιστορία δοκιμής.',contactHours:'Δευτέρα–Παρασκευή 10:00–16:00'}}
  };
  for(const [taskId,answer]of Object.entries(answers))submit(taskId,answer);
  drain();
  return {record,options:{targetStore,assets,sourceAssets,...(logo?{logo}:{})},products:record.tasks.catalog.draft.products,syntheticTestOnly:true};
}
