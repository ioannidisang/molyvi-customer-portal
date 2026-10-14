import path from 'node:path';
import {readFileSync} from 'node:fs';
import {inspectProject} from '../../molyvi-contract/lib/contract.mjs';
import {SERVICE_OFFER,OFFER_HASH,packageForOrder} from './service-offer.mjs';
import {IntakeError,WORKSPACE_ROOT} from './intake-store.mjs';
import {readPhoto} from './product-assets.mjs';
import {readLogo} from './logo-assets.mjs';
import {approvedBrandPresentation} from './brand-presentation.mjs';
import {previewStoreContent} from './store-content.mjs';

const schema=JSON.parse(readFileSync(new URL('../../molyvi-contract/project.schema.json',import.meta.url),'utf8'));
const fail=code=>{throw new IntakeError(code,422);};
const answers=(record,id)=>record.tasks[id]?.submission?.answers??record.tasks[id]?.draft??{};
const choice=(selected,other='')=>({selected:Array.isArray(selected)?selected:selected?[selected]:[],other});

// Read-only owner-scoped planning export. It grants no payment, credits, job or
// publication permission. Legacy flat products need an explicit user conversion.
export async function exportProjectContract(store,session) {
  const record=await store.read(session.projectId,session.ownerId),offer=packageForOrder(record.order);
  if(record.order.demo!==true||offer.legacy||offer.offerHash!==OFFER_HASH)fail('CONTRACT_ORDER_REVIEW_REQUIRED');
  const business=answers(record,'business'),branding=answers(record,'branding'),photos=answers(record,'photos'),operations=answers(record,'operations');
  const merchant=answers(record,'merchant').merchantProfile,paymentPlan=answers(record,'payouts').paymentPlan;
  const returnsPlan=answers(record,'returns').returnsPlan,policyInputs=answers(record,'policies').policyInputs,pageContent=answers(record,'pages').pageContent;
  const contentPreview=record.contentContractVersion===1&&record.order.status==='verified_paid'?previewStoreContent(record):null;
  if(!business.name||!['text','existing','create'].includes(branding.logoMode)||!['white_lifestyle','lifestyle'].includes(photos.mix))fail('CONTRACT_PROFILE_INCOMPLETE');
  const products=record.tasks.catalog.draft.products??[];
  if(products.some(product=>!Array.isArray(product.variants)||!Array.isArray(product.visualUnits)))fail('CONTRACT_CATALOG_CONVERSION_REQUIRED');
  const assigned=[...new Set(products.flatMap(product=>product.visualUnits.flatMap(unit=>unit.sourceAssetIds)))];
  const directory=await store.directory(record.id),assets=[];
  const brandHandoff=approvedBrandPresentation(record);
  let logoAsset=null;
  if(branding.logoMode==='existing'&&record.brandAssets?.[branding.logoReference]){
    const {asset}=await readLogo(store,session,branding.logoReference);logoAsset=asset;
    const ref=path.relative(WORKSPACE_ROOT,path.join(directory,`logo-${asset.id}.bin`)).split(path.sep).join('/');
    if(!ref.startsWith('briefs/')||ref.split('/').includes('..'))fail('CONTRACT_PRIVATE_REFERENCE');
    assets.push({id:asset.id,kind:'logo',availability:'available',storage:'private',ref,sha256:asset.sha256,
      provenance:{sourceUrl:null,recordRef:null,notes:'Original uploaded logo; private bytes verified. Rights evidence remains pending.'},license:{status:'pending',name:null,url:null}});
  }
  for(const id of assigned){
    const {asset}=await readPhoto(store,session,id);
    const absolute=path.join(directory,`photo-${id}.bin`);
    const relative=path.relative(WORKSPACE_ROOT,absolute).split(path.sep).join('/');
    if(!relative.startsWith('briefs/')||relative.split('/').some(part=>part==='..'))fail('CONTRACT_PRIVATE_REFERENCE');
    assets.push({id,kind:'source_image',availability:'available',storage:'private',ref:relative,sha256:asset.sha256,
      provenance:{sourceUrl:null,recordRef:null,notes:'Uploaded material; owned bytes checked by the local application. Rights evidence remains pending.'},
      license:{status:'pending',name:null,url:null}});
  }
  const mapped=products.map(product=>({...Object.fromEntries(['id','title','description','category','facts','improveTitle','improveDescription','variants','visualUnits'].filter(key=>product[key]!==undefined).map(key=>[key,structuredClone(product[key])])),category:product.category??''}));
  const colors=['primary','secondary','accent'];
  const validPalette=colors.every(key=>/^#[\da-f]{6}$/i.test(branding[key]??''));
  const project={schemaVersion:'1.0.0',offerId:record.order.offerId,projectId:record.id,mode:'test',recordStatus:'draft',packageId:offer.id,
    payment:{status:'not_started',currency:'EUR',basePriceMinorExVat:offer.netPriceMinor,testEvidenceRef:null},
    brand:{name:business.name,logoMode:branding.logoMode,...(logoAsset?{logoAssetId:logoAsset.id}:{}),...(branding.style?{style:branding.style}:{}),
      styleNotes:[branding.styleNotes,branding.styleOther].filter(Boolean).join('\n'),
      palette:{source:validPalette?(branding.palette==='from_logo'?'logo_proposal':branding.palette==='custom'?'customer':'preset_proposal'):'pending',...Object.fromEntries(colors.map(key=>[key,validPalette?branding[key]:null]))}},
    business:{country:merchant||record.merchantPaymentsContractVersion===1?(merchant?.country==='GR'?'GR':null):'GR',language:'el',currency:'EUR',...(merchant?{merchantProfile:structuredClone(merchant)}:{}),category:business.category==='other'?business.categoryOther??'':business.category??'',
      activity:business.activity??'',audience:choice(business.audience,business.audienceOther),differentiators:choice(business.differentiators,business.differentiatorsOther),positioning:choice(business.positioning,business.positioningOther)},
    photos:{mix:photos.mix==='lifestyle'?`lifestyle_${offer.entitlements.photoSlotsPerUnit}`:`white_1_lifestyle_${offer.entitlements.photoSlotsPerUnit-1}`,instructions:photos.instructions??''},
    products:mapped,assets,...(operations.shippingPlan||paymentPlan||returnsPlan?{operations:{...(operations.shippingPlan?{shippingPlan:structuredClone(operations.shippingPlan)}:{}),...(paymentPlan?{paymentPlan:structuredClone(paymentPlan),shopifyPaymentsActivation:'customer_after_handoff'}:{}),...(returnsPlan?{returnsPlan:structuredClone(returnsPlan)}:{})}}:{}),
    ...(policyInputs||pageContent?{content:{...(policyInputs?{policyInputs:structuredClone(policyInputs)}:{}),...(pageContent?{pageContent:structuredClone(pageContent)}:{}),reviewStatus:contentPreview?.approval?'test_recorded':'pending_customer_review',...(contentPreview?.approval?{reviewBundleHash:contentPreview.bundleHash}:{})}}:{})};
  const validation=inspectProject(project,schema,SERVICE_OFFER);
  return {schemaVersion:1,project,validation,authority:{readOnlyPlanningExport:true,paymentVerified:false,productionAuthorized:false,publicationAuthorized:false},
    ...(brandHandoff?{brandingHandoff:brandHandoff}:{}),
    pendingAdapters:[merchant?'merchant_details_native_application':'merchant_details',...(!brandHandoff?['branding_customer_approval']:[]),...(branding.logoMode==='create'||branding.logoMode==='existing'&&!logoAsset?['logo_asset']:[]),operations.shippingPlan?'shipping_native_application':'shipping',paymentPlan?'payments_owner_activation':'payments',returnsPlan?'returns_native_application':'returns',policyInputs?'policy_review_and_native_application':'legal_policies',pageContent?'content_native_application':'content','withdrawal_runtime','shopify_assembler'],
    preservedRuntimeSections:{business:structuredClone(business),branding:structuredClone(branding),operations:structuredClone(answers(record,'operations')),...(merchant?{merchant:structuredClone(merchant)}:{}),...(paymentPlan?{paymentPlan:structuredClone(paymentPlan)}:{}),...(returnsPlan?{returnsPlan:structuredClone(returnsPlan)}:{}),...(policyInputs?{policyInputs:structuredClone(policyInputs)}:{}),...(pageContent?{pageContent:structuredClone(pageContent)}:{})}};
}
