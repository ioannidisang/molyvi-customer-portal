import {canonicalJson,IntakeError} from './intake-store.mjs';
import {gallerySelectionSnapshot} from './product-gallery.mjs';
import {previewStoreContent} from './store-content.mjs';
import crypto from 'node:crypto';

const labels={
  'publicationFacts.legalName':['seller','Νόμιμη επωνυμία'],
  'publicationFacts.websiteUrl':['seller','Διεύθυνση του καταστήματος'],
  'publicationFacts.taxNumber':['seller','Φορολογικά στοιχεία'],
  'publicationFacts.registryStatus':['seller','Στοιχεία μητρώου'],
  'merchantProfile.contactPhone':['seller','Τηλέφωνο επικοινωνίας'],
  'publicationFacts.contractFormation':['orders','Πότε επιβεβαιώνεται η συμφωνία αγοράς'],
  'publicationFacts.pricesTaxMode':['orders','Εμφάνιση τιμών και φόρων'],
  'publicationFacts.orderAcknowledgementDetails':['orders','Επιβεβαίωση παραγγελίας'],
  'publicationFacts.paymentAvailabilityDetails':['orders','Διαθέσιμοι τρόποι πληρωμής'],
  'publicationFacts.deliveryDeadlineDetails':['orders','Όρια και χρόνοι παράδοσης'],
  'publicationFacts.providerRoles':['privacy','Πάροχοι και ρόλοι'],
  'publicationFacts.privacyPurposesAndBases':['privacy','Χρήσεις δεδομένων και βάσεις επεξεργασίας'],
  'publicationFacts.transferSafeguards':['privacy','Διαβιβάσεις δεδομένων'],
  'publicationFacts.enhancedServices':['privacy','Πρόσθετες υπηρεσίες'],
  'publicationFacts.automatedDecisions':['privacy','Αυτοματοποιημένες αποφάσεις'],
  'policyInputs.cookieConsent':['privacy','Πραγματική ρύθμιση cookies'],
};
const digest=value=>crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
const fail=()=>{throw new IntakeError('DELIVERY_IDENTITY_MISMATCH',409);};

// Read-only comparison of current selections with one immutable delivery.
// It neither accepts the delivery nor runs the assembler or checks live Shopify.
export function deliveryReviewStatus(record,{manifest,catalogue=null}={}){
  if(!manifest||manifest.projectId!==record.id||manifest.serviceOrderId!==record.order.id)fail();
  if(catalogue&&(catalogue.projectId!==record.id||catalogue.orderId!==record.order.id||catalogue.planHash!==manifest.planHash))fail();
  const products=record.tasks.catalog?.draft.products??[],common=['business','branding','photos','operations','merchant','payouts','returns','policies','pages'];
  let photos={status:'unavailable',selectedCount:null,deliveredCount:null,changedProducts:[],selectionHash:null};
  if(catalogue){
    if(!Array.isArray(catalogue.products)||new Set(catalogue.products.map(p=>p.productId)).size!==catalogue.products.length)fail();
    const delivered=new Map(catalogue.products.map(p=>[p.productId,p])),selections=[],changed=[];let selectedCount=0,deliveredCount=0,incomplete=false;
    for(const p of catalogue.products){if(typeof p.productId!=='string'||!Array.isArray(p.photos)||p.photos.some((photo,i)=>photo.position!==i+1||!/^[a-f\d]{64}$/.test(photo.sha256??'')))fail();deliveredCount+=p.photos.length;}
    for(const p of products){
      let selection;try{selection=gallerySelectionSnapshot(record,p.id);}catch{incomplete=true;changed.push({productId:p.id,title:p.title,status:'not_ready',positions:[]});continue;}
      selections.push({productId:p.id,photos:selection.photos});selectedCount+=selection.photos.length;
      const previous=delivered.get(p.id),positions=[];for(let i=0;i<Math.max(selection.photos.length,previous?.photos.length??0);i++)if(selection.photos[i]?.sha256!==previous?.photos[i]?.sha256)positions.push(i+1);
      if(!previous||positions.length)changed.push({productId:p.id,title:p.title,status:previous?'changed':'added',positions});
      delivered.delete(p.id);
    }
    for(const p of delivered.values())changed.push({productId:p.productId,title:p.title,status:'removed',positions:[]});
    photos={status:incomplete||!products.length?'not_ready':changed.length?'changed':'matches',selectedCount,deliveredCount,changedProducts:changed,selectionHash:digest(selections)};
  }
  let content={status:'unavailable',pendingCount:null,groups:[]};
  try{
    const bundle=previewStoreContent(record),groups=new Map();
    for(const item of bundle.publicationBlockers){const [group,label]=labels[item.field]??['other','Πρόσθετο στοιχείο προς έλεγχο'];if(!groups.has(group))groups.set(group,{id:group,title:{seller:'Στοιχεία επιχείρησης',orders:'Παραγγελίες και πληρωμές',privacy:'Απόρρητο και cookies',other:'Πρόσθετος έλεγχος'}[group],items:[]});groups.get(group).items.push({label,field:item.field,code:item.code});}
    content={status:'available',pendingCount:bundle.publicationBlockers.length,groups:[...groups.values()],allInputsSubmitted:bundle.allInputsSubmitted,merchantDraftReviewRecorded:Boolean(bundle.approval)};
  }catch(error){if(!['CONTENT_NOT_AVAILABLE','PAYMENT_REQUIRED'].includes(error.code))throw error;}
  return {schemaVersion:1,projectId:record.id,orderId:record.order.id,deliveryPlanHash:manifest.planHash,
    common:{submitted:common.filter(id=>record.tasks[id]?.submission).length,total:common.length},products:{submitted:Object.values(record.productTasks??{}).filter(p=>p.submission).length,total:products.length},
    photos,content,customerAccepted:false,legalCertified:false,publicationAuthorized:false,liveShopifyVerified:false,newGenerationStarted:false};
}
