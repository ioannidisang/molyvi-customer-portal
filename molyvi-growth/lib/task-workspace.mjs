import crypto from 'node:crypto';
import {publicGalleries} from './product-gallery.mjs';
import {publicPhotoClaims} from './photo-claims.mjs';
import {publicCreditWallet} from './credit-ledger.mjs';
import {canonicalJson, IntakeError} from './intake-store.mjs';
import {BRAND_PALETTES,paletteFor} from './brand-palettes.mjs';
import {normalizeProducts,requirePhotoReviews,publicMaterials,photoReviewSnapshot} from './product-materials.mjs';
import {publicProductTexts,finalizeProductTexts,cancelStaleTextRequests} from './product-text.mjs';
import {packageForOrder} from './service-offer.mjs';
import {normalizeShippingPlan,shippingPolicyForOrder} from './shipping-plan.mjs';
import {normalizeMerchantProfile,normalizePaymentPlan,PAYMENT_GUIDANCE} from './merchant-payments.mjs';
import {publicServicePayment} from './service-payment-view.mjs';
import {normalizeReturnsPlan,normalizePolicyInputs,normalizePageContent} from './store-content.mjs';

export const TASK_SCHEMA_VERSION=8;
// Server-owned illustrative schema. This is not the complete commercial questionnaire.
export const TASKS = [
  {id:'business', title:'Γνωρίζουμε το κατάστημά σου', intro:'Κάθε κατάστημα έχει τη δική του ιστορία. Δώσε μας την αρχή της δικής σου.', fields:[
    {id:'name', label:'Όνομα e-shop', required:true},
    {id:'category', label:'Σε ποια κατηγορία ανήκει το κατάστημά σου;', required:true, type:'select', options:[['jewelry','Κοσμήματα & αξεσουάρ'],['fashion','Ρούχα & παπούτσια'],['beauty','Ομορφιά & περιποίηση'],['home','Σπίτι & διακόσμηση'],['food','Τρόφιμα & ποτά'],['kids','Παιδικά είδη'],['sports','Αθλητικά είδη'],['pets','Είδη για κατοικίδια'],['other','Άλλο']], help:'Η σωστή κατηγορία και οι δικές σου διευκρινίσεις μάς βοηθούν να κάνουμε κάθε επόμενο βήμα πιο σχετικό με την επιχείρησή σου.'},
    {id:'categoryOther', label:'Η δική σου κατηγορία', required:true, when:{field:'category',value:'other'}, help:'Περιέγραψε τον χώρο σου με δικά σου λόγια. Οι λεπτομέρειες μας δίνουν πιο καθαρή κατεύθυνση.'},
    {id:'activity', label:'Τι θα βρίσκει κανείς στο κατάστημά σου;', required:true, type:'textarea', placeholder:'Για παράδειγμα: χειροποίητα ασημένια δαχτυλίδια και κολιέ, με απλές γραμμές, για καθημερινή χρήση.', help:'Τα υλικά, οι χρήσεις και οι λεπτομέρειες που θα μοιραστείς μάς βοηθούν να παρουσιάσουμε τα προϊόντα σου με ακρίβεια και χαρακτήρα.'},
    {id:'audience', label:'Σε ποιους απευθύνονται τα προϊόντα σου;', type:'multi', exclusive:['unknown'], options:[['women','Γυναίκες'],['men','Άνδρες'],['children','Παιδιά'],['parents','Γονείς'],['gifts','Αγοραστές δώρων'],['businesses','Επιχειρήσεις'],['unknown','Δεν γνωρίζω ακόμη'],['other','Άλλο']], help:'Όσο καλύτερα γνωρίζουμε σε ποιον μιλάς, τόσο πιο εύστοχα μπορούμε να γράψουμε και να σχεδιάσουμε. Μπορείς να επιλέξεις περισσότερα από ένα.'},
    {id:'audienceOther', label:'Πες μας περισσότερα για το κοινό σου', required:true, type:'textarea', when:{field:'audience',value:'other'}, help:'Οι συνήθειες, οι ανάγκες και οι περιστάσεις αγοράς μάς βοηθούν να καταλάβουμε καλύτερα τους ανθρώπους που θέλεις να προσεγγίσεις.'},
    {id:'differentiators', label:'Τι κάνει τα προϊόντα σου ξεχωριστά;', type:'multi', exclusive:['unknown'], options:[['handmade','Χειροποίητη κατασκευή'],['materials','Ιδιαίτερα υλικά'],['design','Δικό μας σχέδιο'],['quality','Ποιότητα & αντοχή'],['price','Προσιτές τιμές'],['local','Τοπική παραγωγή'],['service','Προσωπική εξυπηρέτηση'],['unknown','Δεν έχω καταλήξει ακόμη'],['other','Άλλο']], help:'Οι μικρές λεπτομέρειες που σε ξεχωρίζουν δίνουν στο κατάστημά σου τη δική του φωνή. Διάλεξε όσα ισχύουν και πρόσθεσε τη δική σου ιστορία στην περιγραφή των προϊόντων.'},
    {id:'differentiatorsOther', label:'Το δικό σου ξεχωριστό στοιχείο', required:true, type:'textarea', when:{field:'differentiators',value:'other'}, help:'Ένα συγκεκριμένο παράδειγμα μας λέει περισσότερα από έναν γενικό χαρακτηρισμό. Μοιράσου αυτό που αξίζει να προσέξει ο πελάτης σου.'},
    {id:'positioning', label:'Ποια αίσθηση θέλεις να αφήνει το κατάστημά σου;', type:'select', options:[['accessible','Προσιτό & φιλικό'],['premium','Προσεγμένο & πολυτελές'],['playful','Χαρούμενο & παιχνιδιάρικο'],['natural','Φυσικό & ζεστό'],['minimal','Απλό & καθαρό'],['unknown','Δεν έχω αποφασίσει ακόμη'],['other','Άλλο']], help:'Μια πιο καθαρή εικόνα της αίσθησης που θέλεις μας βοηθά να δώσουμε συνέπεια στα κείμενα και στην εμφάνιση.'},
    {id:'positioningOther', label:'Περιέγραψε τη δική σου αίσθηση', required:true, type:'textarea', when:{field:'positioning',value:'other'}, help:'Πες μας πώς θέλεις να αισθάνεται ο επισκέπτης. Όσο πιο συγκεκριμένη η κατεύθυνση, τόσο καλύτερα μπορούμε να την αποδώσουμε.'}
  ], dependencies:[]},
  {id:'branding', title:'Η εικόνα του καταστήματός σου', intro:'Δώσε στο κατάστημά σου τον δικό του χαρακτήρα. Ξεκινάμε από όσα έχεις και χτίζουμε την εικόνα του μαζί.', fields:[
    {id:'logoMode', label:'Πώς ξεκινάμε;', required:true, type:'select', options:[['existing','Έχω λογότυπο'],['create','Δημιουργία logo — με το πρόσθετο branding'],['text','Το όνομα ως κείμενο']],help:'Το λογότυπο και η ιστορία που μοιράζεσαι μας δίνουν τη βάση για μια εμφάνιση που ταιριάζει στο brand σου.'},
    {id:'logoReference', label:'Το λογότυπό σου',type:'logo-upload',required:true,when:{field:'logoMode',value:'existing'},help:'Ένα καθαρό αρχείο μάς βοηθά να αποδώσουμε σωστά το λογότυπο και τα χρώματά του.'},
    {id:'style', label:'Ποια εικόνα ταιριάζει στο κατάστημά σου;', type:'visual-choice',required:true, options:[['minimal','Απλό & καθαρό'],['elegant','Κομψό & πολυτελές'],['natural','Φυσικό & ζεστό'],['retro','Ρετρό & διαχρονικό'],['futuristic','Φουτουριστικό & τολμηρό'],['playful','Ζωντανό & παιχνιδιάρικο'],['unknown','Δεν έχω αποφασίσει ακόμη'],['other','Άλλο']], descriptions:{minimal:'Καθαρές γραμμές. Χώρος για τα προϊόντα σου.',elegant:'Ήρεμοι τόνοι. Προσεγμένες λεπτομέρειες.',natural:'Γήινες αποχρώσεις. Μια οικεία αίσθηση.',retro:'Χρώμα και τυπογραφία με χαρακτήρα.',futuristic:'Δυνατές αντιθέσεις. Μια τολμηρή ματιά.',playful:'Φρέσκο χρώμα. Μικρές, χαρούμενες εκπλήξεις.',unknown:'Αποθήκευσέ το και επέστρεψε όταν είσαι έτοιμος.',other:'Περιέγραψε τη δική σου κατεύθυνση.'},help:'Διάλεξε την αίσθηση που ταιριάζει στο κατάστημά σου. Οι λεπτομέρειες και τα παραδείγματά σου μας βοηθούν να της δώσουμε τον δικό σου χαρακτήρα.'},
    {id:'styleOther',label:'Το δικό σου ύφος',required:true,type:'textarea',when:{field:'style',value:'other'},help:'Μοιράσου εικόνες με λέξεις: εποχή, υλικά, ατμόσφαιρα. Οι λεπτομέρειες μάς βοηθούν να καταλάβουμε τη δική σου κατεύθυνση.'},
    {id:'styleNotes',label:'Τι άλλο θα ήθελες να γνωρίζουμε;',type:'textarea',placeholder:'Για παράδειγμα: μου αρέσουν οι μεγάλες φωτογραφίες, τα ζεστά χρώματα και μια ήρεμη εμφάνιση. Μπορείς να προσθέσεις και συνδέσμους με παραδείγματα.',help:'Μια λεπτομέρεια που αγαπάς ή ένα παράδειγμα που σε εκφράζει μας βοηθά να πλησιάσουμε τη δική σου εικόνα.'},
    {id:'palette',label:'Τα χρώματα που σε εκφράζουν',type:'palette-choice',required:true,palettes:BRAND_PALETTES,options:[...BRAND_PALETTES.map(palette=>[palette.id,palette.name]),['from_logo','Βασιστείτε στο λογότυπό μου'],['custom','Άλλο — η δική μου παλέτα']],help:'Διάλεξε έναν συνδυασμό που ταιριάζει στην εικόνα σου. Μπορείς να προσαρμόσεις κάθε απόχρωση, ώστε η παλέτα να γίνει δική σου.'},
    {id:'primary',label:'Βασικό χρώμα',type:'color',required:true,when:{field:'palette',value:'custom'},help:'Η βασική σου απόχρωση δίνει τον χαρακτήρα. Μια συγκεκριμένη επιλογή μάς βοηθά να κρατήσουμε την ταυτότητά σου συνεπή.'},
    {id:'secondary',label:'Συμπληρωματικό χρώμα',type:'color',required:true,when:{field:'palette',value:'custom'},help:'Η δεύτερη απόχρωση συμπληρώνει την πρώτη. Δες πώς συνδυάζονται στο δείγμα και διάλεξε την ισορροπία που σε εκφράζει.'},
    {id:'accent',label:'Χρώμα έμφασης',type:'color',required:true,when:{field:'palette',value:'custom'},help:'Μια μικρή χρωματική έμφαση δίνει ζωή στις λεπτομέρειες. Η επιλογή σου μας δείχνει πού θέλεις να στρέφεται το βλέμμα.'}
  ], dependencies:['business'], approval:true},
  {id:'catalog', title:'Τα προϊόντα σου', intro:'Κάθε προϊόν, η δική του ιστορία. Πρόσθεσε τα στοιχεία και τις φωτογραφίες του στο ίδιο σημείο.', fields:[
    {id:'products',label:'Προϊόντα',type:'products',required:true}
  ], dependencies:[]},
  {id:'photos', title:'Παρουσίαση φωτογραφιών', fields:[
    {id:'mix', label:'Επιλογή για όλο το πακέτο', required:true, type:'select', options:[['white_lifestyle','1 λευκό φόντο + οι υπόλοιπες lifestyle'],['lifestyle','Όλες lifestyle']],help:'Η επιλογή σου, μαζί με τις οδηγίες παρουσίασης, μας βοηθά να κρατήσουμε μια συνεπή εικόνα σε όλη τη συλλογή.'},
    {id:'instructions', label:'Πού και πώς φαντάζεσαι τα προϊόντα σου;', required:true, type:'textarea',help:'Φως, υλικά, περιβάλλον, μικρές λεπτομέρειες. Όσο πιο καθαρά περιγράψεις τη σκηνή, τόσο καλύτερα μπορούμε να πλησιάσουμε την εικόνα που έχεις στο μυαλό σου.'}
  ], dependencies:['branding']},
  {id:'operations', title:'Βασικές ρυθμίσεις', fields:[
    {id:'shippingPlan',label:'Αποστολές',type:'shipping-plan'},
    {id:'shipping', label:'Κάτι ακόμη για τις αποστολές σου;', type:'textarea',help:'Πρόσθεσε όποια διευκρίνιση θα μας βοηθήσει να καταλάβουμε καλύτερα τις επιλογές σου. Οι σημειώσεις συμπληρώνουν τους κανόνες που επέλεξες παραπάνω.'},
    {id:'payments', label:'Ποιες μεθόδους πληρωμής θέλεις;', required:true, type:'textarea',help:'Πες μας τις μεθόδους και όσα έχεις ήδη διαθέσιμα. Έτσι μπορούμε να ξεχωρίσουμε τι είναι έτοιμο και τι χρειάζεται ακόμη ρύθμιση.'}
  ], dependencies:[]},
  {id:'merchant',title:'Τα στοιχεία του πωλητή',intro:'Η σωστή πληροφορία χτίζει εμπιστοσύνη. Δώσε τα στοιχεία που θα βοηθούν τους πελάτες σου να γνωρίζουν με ποιον συναλλάσσονται.',fields:[{id:'merchantProfile',label:'Στοιχεία πωλητή και επικοινωνίας',type:'merchant-profile'}],dependencies:[]},
  {id:'payouts',title:'Πώς θα πληρώνουν οι πελάτες σου',intro:'Διάλεξε τις πληρωμές που ταιριάζουν στο κατάστημά σου. Η ενεργοποίησή τους θα γίνει στο Shopify, με τα δικά σου στοιχεία, μετά την παράδοση.',fields:[{id:'paymentPlan',label:'Προτιμήσεις πληρωμών',type:'payment-plan'}],dependencies:['merchant']},
  {id:'returns',title:'Επιστροφές και αλλαγές',intro:'Ξεκάθαρες επιλογές για εσένα. Κατανοητές οδηγίες για τους πελάτες σου.',fields:[{id:'returnsPlan',label:'Επιστροφές και προαιρετικές αλλαγές',type:'returns-plan'}],dependencies:['merchant']},
  {id:'policies',title:'Οι πολιτικές του καταστήματος',intro:'Τα δικά σου στοιχεία γίνονται η βάση για τα προσχέδια. Θα ελέγξεις τα τελικά κείμενα πριν χρησιμοποιηθούν.',fields:[{id:'policyInputs',label:'Στοιχεία για τις πολιτικές',type:'policy-inputs'}],dependencies:['merchant','operations','payouts','returns']},
  {id:'pages',title:'Η ιστορία και η επικοινωνία σου',intro:'Σχετικά, Επικοινωνία και Συχνές ερωτήσεις. Τρεις σελίδες που βοηθούν τον επισκέπτη να σε γνωρίσει καλύτερα.',fields:[{id:'pageContent',label:'Περιεχόμενο ενημερωτικών σελίδων',type:'page-content'}],dependencies:['business','merchant','operations','returns']}
];

const fail = (code,status=409,details) => {throw new IntakeError(code,status,details);};
const hash = value => crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
const definition = id => TASKS.find(task=>task.id===id) ?? fail('TASK_NOT_FOUND',404);
const paid = project => {if(project.schemaVersion!==TASK_SCHEMA_VERSION)fail('SCHEMA_VERSION_STALE');if(project.order.status!=='verified_paid') fail('PAYMENT_REQUIRED',402);};
const nowIso = now => new Date(now).toISOString();
const amount = value => typeof value==='number' && Number.isFinite(value) && value>=0;
const units = value => Math.round(value*1e6);

export function createWorkspace({id=crypto.randomUUID(),ownerId,order,budgetEur=0,now=Date.now()}) {
  if(!ownerId || !order?.id || !['verified_paid','pending'].includes(order.status) || !amount(budgetEur)) fail('INVALID_PROJECT',400);
  const savedOrder=structuredClone(order);
  if(savedOrder.offerSnapshot){
    const selected=packageForOrder(savedOrder);
    savedOrder.entitlements=structuredClone(selected.entitlements);
    savedOrder.packageId=selected.id;savedOrder.netPriceMinor=selected.netPriceMinor;
    savedOrder.offerId=selected.offerId;savedOrder.offerHash=selected.offerHash;
  }
  const withMerchantPayments=Boolean(savedOrder.offerSnapshot?.entitlements?.shipping);
  return {schemaVersion:TASK_SCHEMA_VERSION,...(withMerchantPayments?{operationsContractVersion:1,merchantPaymentsContractVersion:1,contentContractVersion:1}:{}),id,ownerId,order:savedOrder,createdAt:nowIso(now),
    budget:{limit:units(budgetEur),spent:0,reserved:0,unknown:false,halted:false},
    tasks:Object.fromEntries(TASKS.filter(task=>withMerchantPayments||!['merchant','payouts','returns','policies','pages'].includes(task.id)).map(task=>[task.id,{draft:{},revision:0,skipped:false,submission:null,approvedHash:null}])),jobs:{},assets:{},photoReviews:{},productTexts:{},productTasks:{},productGalleries:{},generatedAssets:{}};
}

function answersFor(project,id,answers,complete=false) {
  const def=definition(id);
  if(!answers || typeof answers!=='object' || Array.isArray(answers) || Object.keys(answers).some(key=>!def.fields.some(field=>field.id===key))) fail('INVALID_ANSWERS',400);
  if(id==='catalog')return {products:normalizeProducts(project,answers.products,complete)};
  if(id==='merchant')return {merchantProfile:normalizeMerchantProfile(answers.merchantProfile===undefined?{}:answers.merchantProfile,{complete})};
  if(id==='returns'){
    const merchant=project.tasks.merchant?.submission;
    if(complete&&!merchant)fail('MERCHANT_SUBMISSION_REQUIRED',422);
    return {returnsPlan:normalizeReturnsPlan(answers.returnsPlan===undefined?{}:answers.returnsPlan,{complete,merchantProfile:merchant?.answers.merchantProfile??project.tasks.merchant?.draft.merchantProfile})};
  }
  if(id==='policies')return {policyInputs:normalizePolicyInputs(answers.policyInputs===undefined?{}:answers.policyInputs,{complete})};
  if(id==='pages')return {pageContent:normalizePageContent(answers.pageContent===undefined?{}:answers.pageContent,{complete})};
  if(id==='payouts'){
    const merchant=project.tasks.merchant?.submission;
    if(complete&&!merchant)fail('MERCHANT_SUBMISSION_REQUIRED',422);
    return {paymentPlan:normalizePaymentPlan(answers.paymentPlan===undefined?{}:answers.paymentPlan,{complete,merchantProfile:merchant?.answers.merchantProfile??project.tasks.merchant?.draft.merchantProfile})};
  }
  if(complete && id==='operations' && !answers.shippingPlan){
    if(project.operationsContractVersion===1)fail('SHIPPING_PLAN_REQUIRED',422,{field:'shippingPlan'});
    if(!answers.shipping?.trim())fail('INPUT_INCOMPLETE',422,{field:'shipping'});
  }
  if(complete && id==='branding' && answers.style==='unknown')fail('STYLE_DECISION_REQUIRED',422,{field:'style'});
  const result={};
  for(const field of def.fields) {
    if(field.type==='shipping-plan'){
      // Do not insert a key in historical answers: their frozen hashes remain stable.
      if(Object.hasOwn(answers,field.id))result[field.id]=normalizeShippingPlan(project.order,answers[field.id],{complete});
      continue;
    }
    if(field.type==='multi') {
      const choices=answers[field.id]??[];
      if(!Array.isArray(choices) || choices.length>field.options.length || choices.some(value=>typeof value!=='string' || !field.options.some(([key])=>key===value)))fail('INVALID_CHOICE',400,{field:field.id});
      if(choices.length>1 && choices.some(value=>field.exclusive?.includes(value)))fail('EXCLUSIVE_CHOICE',422,{field:field.id});
      result[field.id]=field.options.map(([key])=>key).filter(key=>choices.includes(key));
      continue;
    }
    const value=answers[field.id]??'';
    if(typeof value!=='string' || value.length>4000) fail('INVALID_FIELD',400,{field:field.id});
    result[field.id]=value.trim();
    if(value && field.options && !field.options.some(([key])=>key===value)) fail('INVALID_CHOICE',400,{field:field.id});
    const conditions=field.when?(Array.isArray(field.when)?field.when:[field.when]):[];
    const active=conditions.every(condition=>Array.isArray(answers[condition.field])?answers[condition.field].includes(condition.value):answers[condition.field]===condition.value);
    const required=field.required&&!(id==='operations'&&field.id==='payments'&&project.merchantPaymentsContractVersion===1);
    if(complete && active && required && !result[field.id]) fail('INPUT_INCOMPLETE',422,{field:field.id});
    if(complete && !active)result[field.id]='';
    if(value && field.type==='color' && !/^#[\da-f]{6}$/i.test(value)) fail('INVALID_COLOR',422,{field:field.id});
    if(value && field.type==='number' && (!/^\d+(?:\.\d{1,2})?$/.test(value) || !Number.isFinite(Number(value)) || (field.id==='stock' && !Number.isInteger(Number(value))))) fail('INVALID_NUMBER',422,{field:field.id});
  }
  if(id==='branding'){
    if(result.palette==='from_logo' && result.logoMode!=='existing')fail('PALETTE_LOGO_REQUIRED',422,{field:'palette'});
    const asset=project.brandAssets?.[result.logoReference];
    // Historical locked file references are evidence, never silently migrated.
    const historical=project.tasks.branding.submission?.answers;
    const historicalReference=historical?.logoReference===result.logoReference&&!asset;
    if(complete&&result.logoMode==='existing'&&!asset&&!historicalReference)fail('LOGO_UPLOAD_REQUIRED',422,{field:'logoReference'});
    if(complete&&result.palette==='from_logo'&&!historicalReference){
      if(!asset?.paletteProposal)fail('LOGO_PALETTE_UNAVAILABLE',422,{field:'palette'});
      for(const key of ['primary','secondary','accent'])result[key]=asset.paletteProposal[key];
    }
    const preset=paletteFor(result.palette);
    if(complete && preset){
      if(preset.style!==result.style)fail('PALETTE_STYLE_MISMATCH',422,{field:'palette'});
      for(const key of ['primary','secondary','accent'])result[key]=preset[key];
    }
    if(complete && result.palette==='custom')for(const key of ['primary','secondary','accent'])result[key]=result[key].toLowerCase();
  }
  return result;
}

const keyFor = (task,phase) => `${task.submission.hash}:${phase}`;
function jobFor(project,id,phase) {const task=project.tasks[id];return task?.submission && project.jobs[keyFor(task,phase)];}
function enqueue(project,id,phase) {
  const task=project.tasks[id],key=keyFor(task,phase);
  project.jobs[key]??={id:key,taskId:id,phase,status:'waiting',attempts:0,maxAttempts:3,estimate:0,lease:null,result:null,usage:[]};
  return project.jobs[key];
}

// Durable outbox rows and the locked submission are written together by TaskStore.
function releaseReady(project) {
  for(const def of TASKS) {
    const task=project.tasks[def.id];
    if(!task?.submission) continue;
    const preflight=enqueue(project,def.id,'preflight');
    if(preflight.status==='waiting') preflight.status='queued';
    const work=enqueue(project,def.id,'work');
    if(work.status!=='waiting' || preflight.status!=='succeeded') continue;
    const dependencies=def.dependencies.map(id=>({id,task:project.tasks[id],job:jobFor(project,id,'work'),def:definition(id)}));
    if(dependencies.some(item=>item.job?.status!=='succeeded' || (item.def.approval && item.task.approvedHash!==item.job.result?.hash))) continue;
    work.inputs={submissionHash:task.submission.hash,answers:structuredClone(task.submission.answers),...(task.submission.productCopy?{productCopy:structuredClone(task.submission.productCopy)}:{}),dependencies:dependencies.map(item=>({id:item.id,submissionHash:item.task.submission.hash,resultHash:item.job.result.hash}))};
    work.status='queued';
  }
  for(const [productId,state]of Object.entries(project.productTasks??{})){
    if(!state.submission)continue;
    const preflight=enqueueProduct(project,productId,'preflight');if(preflight.status==='waiting')preflight.status='queued';
    const work=enqueueProduct(project,productId,'work');if(work.status!=='waiting'||preflight.status!=='succeeded')continue;
    const brand=project.tasks.branding,brandJob=jobFor(project,'branding','work'),photos=project.tasks.photos;
    if(brandJob?.status!=='succeeded'||brand.approvedHash!==brandJob.result.hash||!photos.submission)continue;
    work.inputs={submissionHash:state.submission.hash,answers:{product:structuredClone(state.submission.product)},
      productCopy:structuredClone(state.submission.productCopy),photoEvidence:structuredClone(state.submission.photoEvidence),
      dependencies:[{id:'branding',submissionHash:brand.submission.hash,resultHash:brandJob.result.hash},{id:'photos',submissionHash:photos.submission.hash}],
      presentation:structuredClone(photos.submission.answers),branding:structuredClone(brand.submission.answers)};
    work.status='queued';
  }
}

function productState(project,id){return project.productTasks?.[id]??{revision:0,skipped:false,submission:null};}
function enqueueProduct(project,productId,phase){
  const submission=project.productTasks[productId].submission,key=`${submission.hash}:${phase}`;
  project.jobs[key]??={id:key,taskId:'catalog',productId,scope:'product',phase,status:'waiting',attempts:0,maxAttempts:3,estimate:0,lease:null,result:null,usage:[]};
  return project.jobs[key];
}
function syncProductDrafts(project,products){
  for(const [id,state]of Object.entries(project.productTasks??{}))if(state.submission){
    const product=products.find(product=>product.id===id);
    if(!product||canonicalJson(product)!==canonicalJson(state.submission.product))fail('PRODUCT_LOCKED',409,{field:'products'});
  }
  project.productTasks??={};
  for(const product of products){
    const previous=project.tasks.catalog.draft.products?.find(item=>item.id===product.id),state=project.productTasks[product.id]??={revision:0,skipped:false,submission:null};
    if(!state.submission&&canonicalJson(previous??null)!==canonicalJson(product)){state.revision++;state.skipped=false;}
  }
  project.tasks.catalog.draft={products};
}

// Trusted workers call this after persisting a provider result.
export function releaseTaskDependencies(project){releaseReady(project);}

export function editProduct(project,{product,revision,action='save'}){
  paid(project);if(project.tasks.catalog.submission)fail('TASK_LOCKED');
  if(!['save','skip'].includes(action))fail('INVALID_ACTION',400);
  const [clean]=normalizeProducts(project,[product]),state=productState(project,clean.id);
  if(state.submission)fail('PRODUCT_LOCKED');if(revision!==state.revision)fail('DRAFT_CONFLICT');
  const list=project.tasks.catalog.draft.products??[],found=list.some(item=>item.id===clean.id);
  const products=normalizeProducts(project,found?list.map(item=>item.id===clean.id?clean:item):[...list,clean]);
  syncProductDrafts(project,products);
  const saved=project.productTasks[clean.id];saved.revision=revision+1;saved.skipped=action==='skip';
  project.tasks.catalog.revision++;project.tasks.catalog.skipped=false;
  cancelStaleTextRequests(project,{productId:clean.id});
  return {productId:clean.id,revision:saved.revision};
}

export function submitProduct(project,{product,revision,acknowledged},now=Date.now()){
  paid(project);if(acknowledged!==true)fail('CONFIRMATION_REQUIRED',422);
  if(project.tasks.catalog.submission)fail('TASK_LOCKED');
  const [clean]=normalizeProducts(project,[product],true),state=productState(project,clean.id);
  if(state.submission){if(canonicalJson(clean)!==canonicalJson(state.submission.product))fail('PRODUCT_LOCKED');return {productId:clean.id,receipt:state.submission.hash,duplicate:true};}
  if(revision!==state.revision)fail('DRAFT_CONFLICT');
  requirePhotoReviews(project,[clean]);const [productCopy]=finalizeProductTexts(project,[clean]);
  const source={product:clean,productCopy,...photoReviewSnapshot(project,clean)};
  const fingerprint=hash({projectId:project.id,productId:clean.id,schemaVersion:project.schemaVersion,...source});
  const list=project.tasks.catalog.draft.products??[],found=list.some(item=>item.id===clean.id);
  syncProductDrafts(project,normalizeProducts(project,found?list.map(item=>item.id===clean.id?clean:item):[...list,clean]));
  const saved=project.productTasks[clean.id];saved.revision=revision+1;saved.skipped=false;
  saved.submission={hash:fingerprint,...structuredClone(source),submittedAt:nowIso(now)};
  project.tasks.catalog.revision++;project.tasks.catalog.skipped=false;releaseReady(project);
  return {productId:clean.id,receipt:fingerprint,duplicate:false};
}

function viewProductTasks(project){
  return Object.fromEntries((project.tasks.catalog.draft.products??[]).map(product=>{
    const state=productState(project,product.id),submission=state.submission;
    let status=state.skipped?'skipped':'draft',waitingFor=[];
    if(submission){
      const pre=project.jobs[`${submission.hash}:preflight`],work=project.jobs[`${submission.hash}:work`];
      status=pre.status!=='succeeded'?`preflight_${pre.status}`:work.status==='succeeded'?'completed':work.status==='waiting'?'waiting_dependencies':work.status;
      const brandJob=jobFor(project,'branding','work');
      if(brandJob?.status!=='succeeded'||project.tasks.branding.approvedHash!==brandJob.result.hash)waitingFor.push('branding');
      if(!project.tasks.photos.submission)waitingFor.push('photos');
    }
    const work=submission&&project.jobs[`${submission.hash}:work`],plan=work?.result?.output.delivery==='product_photo_plan',gallery=project.productGalleries?.[product.id];
    const ready=gallery?.slots.filter(slot=>slot.candidates.length).length??0;
    return [product.id,{...structuredClone(state),status,waitingFor,...(plan?{imageProgress:{planned:work.result.output.plannedImages,ready},productionPlanReady:true}: {})}];
  }));
}

export function editTask(project,{taskId,answers,revision,action='save'}) {
  paid(project);definition(taskId);
  const task=project.tasks[taskId];
  if(!task)fail('TASK_NOT_AVAILABLE',409);
  if(task.submission) fail('TASK_LOCKED');
  if(revision!==task.revision) fail('DRAFT_CONFLICT');
  if(!['save','skip'].includes(action)) fail('INVALID_ACTION',400);
  const clean=answersFor(project,taskId,answers);
  if(taskId==='catalog')syncProductDrafts(project,clean.products);else task.draft=clean;
  task.revision++;task.skipped=action==='skip';
  if(['catalog','business','branding'].includes(taskId))cancelStaleTextRequests(project);
  return {revision:task.revision};
}

export function submitTask(project,{taskId,answers,revision,acknowledged},now=Date.now()) {
  paid(project);definition(taskId);
  if(acknowledged!==true) fail('CONFIRMATION_REQUIRED',422);
  const task=project.tasks[taskId];if(!task)fail('TASK_NOT_AVAILABLE',409);
  const snapshot=answersFor(project,taskId,answers,true);
  if(taskId==='catalog'&&Object.values(project.productTasks??{}).some(state=>state.submission))fail('PRODUCT_SUBMISSION_REQUIRED');
  if(taskId==='catalog'&&!task.submission)requirePhotoReviews(project,snapshot.products);
  const productCopy=taskId==='catalog'?(task.submission?.productCopy??finalizeProductTexts(project,snapshot.products)):null;
  const fingerprint=hash({projectId:project.id,taskId,schemaVersion:project.schemaVersion,answers:snapshot,...(productCopy?{productCopy}:{})});
  if(task.submission) {
    if(task.submission.hash!==fingerprint) fail('TASK_LOCKED');
    return {receipt:task.submission.hash,duplicate:true};
  }
  if(revision!==task.revision) fail('DRAFT_CONFLICT');
  if(taskId==='branding' && snapshot.style==='unknown') fail('STYLE_DECISION_REQUIRED',422,{field:'style'});
  if(taskId==='branding' && snapshot.logoMode==='create' && !project.order.entitlements?.branding) fail('ADDON_REQUIRED',422);
  task.draft=snapshot;task.revision++;task.skipped=false;
  task.submission={hash:fingerprint,answers:structuredClone(snapshot),...(productCopy?{productCopy}:{}),submittedAt:nowIso(now)};
  if(['business','branding'].includes(taskId))cancelStaleTextRequests(project);
  releaseReady(project);
  return {receipt:fingerprint,duplicate:false};
}

export function approveTask(project,{taskId,resultHash}) {
  paid(project);const def=definition(taskId),job=jobFor(project,taskId,'work');
  if(!def.approval || job?.status!=='succeeded' || resultHash!==job.result.hash) fail('RESULT_NOT_READY');
  project.tasks[taskId].approvedHash=resultHash;releaseReady(project);
}

export function claimJob(project,{estimateEur=0,leaseMs=30_000,jobId}={},now=Date.now()) {
  paid(project);
  if(!amount(estimateEur) || !Number.isFinite(leaseMs) || leaseMs<=0) fail('INVALID_ESTIMATE',400);
  recoverExpired(project,now);releaseReady(project);
  if(project.budget.unknown || project.budget.halted) return null;
  const job=Object.values(project.jobs).find(item=>item.status==='queued'&&(jobId===undefined||item.id===jobId));
  if(!job) return null;
  const estimate=units(estimateEur);
  if(project.budget.spent+project.budget.reserved+estimate>project.budget.limit) {job.status='paused_budget';return null;}
  job.estimate=estimate;project.budget.reserved+=estimate;
  job.status='running';job.attempts++;
  job.lease={token:crypto.randomUUID(),expiresAt:now+leaseMs};
  const submission=job.productId?project.productTasks[job.productId].submission:project.tasks[job.taskId].submission;
  return structuredClone({...job,inputs:job.inputs??{submissionHash:submission.hash,answers:job.productId?{product:submission.product}:submission.answers}});
}

export function finishJob(project,{jobId,leaseToken,success,costEur,output},now=Date.now()) {
  const job=project.jobs[jobId];
  if(!job || job.status!=='running' || job.lease.token!==leaseToken) fail('LEASE_CONFLICT');
  if(now>job.lease.expiresAt) {recoverExpired(project,now);return {status:'paused_unknown'};}
  if(!amount(costEur)) {job.status='paused_unknown';project.budget.unknown=true;return {status:job.status};}
  const cost=units(costEur);project.budget.reserved-=job.estimate;project.budget.spent+=cost;
  job.usage.push({attempt:job.attempts,cost,at:nowIso(now)});job.lease=null;
  // An underestimated provider bill is recorded honestly, and blocks further calls.
  if(cost>job.estimate || project.budget.spent+project.budget.reserved>project.budget.limit) {job.status='paused_budget';project.budget.halted=true;return {status:job.status};}
  if(success && output && typeof output==='object' && !Array.isArray(output) && Buffer.byteLength(canonicalJson(output))<=16_384) {
    job.result={hash:hash(output),output:structuredClone(output)};job.status='succeeded';
  } else job.status=job.attempts<job.maxAttempts?'queued':'failed';
  releaseReady(project);return {status:job.status};
}

export function recoverExpired(project,now=Date.now()) {
  for(const job of Object.values(project.jobs)) if(job.status==='running' && now>job.lease.expiresAt) {
    job.status='paused_unknown';project.budget.unknown=true;
  }
}

export function viewWorkspace(project) {
  if(project.schemaVersion!==TASK_SCHEMA_VERSION)fail('SCHEMA_VERSION_STALE');
  const subscriptionAllocationUnknown=Object.values(project.productPilotImports??{}).some(receipt=>receipt.executionEvidence?.billingMode==='chatgpt_session'&&receipt.costEur===null)
    ||Object.values(project.jobs).some(job=>job.usage?.some(item=>item.billingMode==='chatgpt_session'&&item.allocatedCostEur===null));
  return {brandAssets:Object.values(project.brandAssets??{}).map(({id,name,mime,bytes,sha256,paletteProposal})=>({id,name,mime,bytes,sha256,paletteProposal})),materials:publicMaterials(project),productTexts:publicProductTexts(project),productTasks:viewProductTasks(project),productGalleries:publicGalleries(project),photoClaims:publicPhotoClaims(project),credits:publicCreditWallet(project),id:project.id,demo:project.order.demo===true,orderId:project.order.id,
    servicePayment:publicServicePayment(project),serviceOffer:packageForOrder(project.order),shippingPolicy:shippingPolicyForOrder(project.order),paymentGuidance:PAYMENT_GUIDANCE,operationsContractVersion:project.operationsContractVersion??null,merchantPaymentsContractVersion:project.merchantPaymentsContractVersion??null,contentContractVersion:project.contentContractVersion??null,subscriptionAllocationUnknown,
    tasks:TASKS.filter(def=>project.tasks[def.id]).map(def=>{
      const task=project.tasks[def.id],pre=jobFor(project,def.id,'preflight'),work=jobFor(project,def.id,'work');
      let status=task.skipped?'skipped':'draft';
      if(task.submission) status=pre.status!=='succeeded'?`preflight_${pre.status}`:work.status==='succeeded'?(def.approval && task.approvedHash!==work.result.hash?'awaiting_approval':'completed'):work.status==='waiting'?'waiting_dependencies':work.status;
      let fields=def.id==='operations'&&!project.order.offerSnapshot?.entitlements?.shipping?def.fields.filter(field=>field.type!=='shipping-plan'):def.fields;
      if(def.id==='operations'&&project.merchantPaymentsContractVersion===1)fields=fields.filter(field=>field.id!=='payments');
      return {...def,...(def.id==='operations'&&project.merchantPaymentsContractVersion===1?{title:'Αποστολές'}:{}),fields,...structuredClone(task),status,result:work?.result??null,waitingFor:def.dependencies.filter(id=>{
        const dep=project.tasks[id],job=jobFor(project,id,'work');return job?.status!=='succeeded' || (definition(id).approval && dep.approvedHash!==job.result.hash);
      })};
    }),spentEur:project.budget.spent/1e6,costUnknown:project.budget.unknown};
}
