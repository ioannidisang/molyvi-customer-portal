'use strict';
let workspace=null,current='business',dirty=false,busy=false,pending=null,navSignature='',customerCsrf=null;
const $=id=>document.getElementById(id);
let backupReadOnly=false,backupRecoveryPending=false;
const backupReadMessage='Δημιουργούμε ένα ασφαλές αντίγραφο του έργου σου. Προσωρινά βλέπεις μόνο τις βασικές πληροφορίες. Αλλαγές, φωτογραφίες και λήψεις θα επιστρέψουν αυτόματα. Όσα έχεις γράψει παραμένουν στη σελίδα· μην την ανανεώσεις.';
const backupReadPaths=new Set(['/api/service-config','/api/customer/me','/api/workspace']);
const backupPausedErrors=new Set(['BACKUP_RESOURCES_IN_PROGRESS','BACKUP_SNAPSHOT_IN_PROGRESS','BACKUP_READ_TEMPORARILY_UNAVAILABLE']);
const backupControls=new Map(),backupLinks=new Map(),backupImages=new Map();
function applyBackupReadOnly(){
  if(!document.querySelectorAll)return;
  let banner=$('backup-readonly-notice');
  if(backupReadOnly&&!banner){banner=element('p',backupReadMessage,{id:'backup-readonly-notice',role:'status',class:'note'});document.querySelector?.('main')?.prepend(banner);}
  if(banner)banner.hidden=!backupReadOnly;
  for(const control of document.querySelectorAll('button,input,select,textarea')){
    const allowed=['cancel-confirm','close-viewer'].includes(control.id)||(!dirty&&control.hasAttribute('data-backup-navigation'));
    if(backupReadOnly&&!allowed){if(!backupControls.has(control)||!control.disabled)backupControls.set(control,control.disabled);if(!control.disabled)control.disabled=true;}
    else if(backupControls.has(control)){control.disabled=backupControls.get(control);backupControls.delete(control);}
  }
  for(const link of document.querySelectorAll('a')){
    const href=link.getAttribute('href')??backupLinks.get(link);
    if(backupReadOnly&&(dirty||!['/','/customer/','/workspace/'].includes(href))){if(href&&!backupLinks.has(link))backupLinks.set(link,href);if(link.hasAttribute('href'))link.removeAttribute('href');link.setAttribute('aria-disabled','true');}
    else if(backupLinks.has(link)){link.setAttribute('href',backupLinks.get(link));link.removeAttribute('aria-disabled');backupLinks.delete(link);}
  }
  for(const img of document.querySelectorAll('img')){
    if(backupReadOnly){if(!backupImages.has(img))backupImages.set(img,{src:img.getAttribute('src'),hidden:img.hidden});if(img.hasAttribute('src'))img.removeAttribute('src');img.hidden=true;}
    else if(backupImages.has(img)){const saved=backupImages.get(img);if(saved.src)img.setAttribute('src',saved.src);img.hidden=saved.hidden;backupImages.delete(img);}
  }
  for(const map of [backupControls,backupLinks,backupImages])for(const control of map.keys())if(control.isConnected===false)map.delete(control);
}
function setBackupReadOnly(value){const next=value===true;if(backupReadOnly&&!next)backupRecoveryPending=true;backupReadOnly=next;applyBackupReadOnly();}
function backupReadError(){const error=new Error(backupReadMessage);error.code='BACKUP_RESOURCES_IN_PROGRESS';return error;}
if(typeof MutationObserver==='function'&&document.body)new MutationObserver(()=>applyBackupReadOnly()).observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['disabled']});
const names={draft:'Δεν έχει υποβληθεί',skipped:'Για αργότερα',preflight_queued:'Ξεκινά ο έλεγχος',preflight_running:'Ελέγχουμε τα στοιχεία',waiting_dependencies:'Περιμένει προηγούμενα βήματα',queued:'Έτοιμο για επεξεργασία',running:'Σε επεξεργασία',result_ready:'Το αποτέλεσμα αποθηκεύτηκε',awaiting_approval:'Περιμένει έγκρισή σου',completed:'Ολοκληρώθηκε στη δοκιμή',failed:'Χρειάζεται έλεγχος',paused_unknown:'Παύση για έλεγχο',paused_budget:'Παύση κόστους'};
const taskLabel=status=>workspace?.servicePayment&&['preflight_queued','queued'].includes(status)?'Το βήμα αποθηκεύτηκε στην ουρά':names[status]??'Σε αναμονή';
const errors={PREPARATION_IN_PROGRESS:'Το κατάστημα βρίσκεται σε προετοιμασία. Μπορείς να παρακολουθείς την πρόοδό του· οι αλλαγές θα είναι διαθέσιμες όταν ολοκληρωθεί ο έλεγχος.',SESSION_REQUIRED:'Άνοιξε μια δοκιμαστική παραγγελία για να ξεκινήσεις.',INPUT_INCOMPLETE:'Μια μικρή λεπτομέρεια ακόμη: συμπλήρωσε το πεδίο πριν την οριστική υποβολή.',DRAFT_CONFLICT:'Υπάρχει νεότερη αποθήκευση. Κράτησε αντίγραφο των αλλαγών σου και ανανέωσε πριν συνεχίσεις.',TASK_LOCKED:'Το βήμα έχει ήδη υποβληθεί οριστικά.',INVALID_NUMBER:'Έλεγξε τιμή και απόθεμα. Χρησιμοποίησε τελεία για δεκαδικά.',ADDON_REQUIRED:'Η δημιουργία logo χρειάζεται αγορασμένο πρόσθετο branding.',EXCLUSIVE_CHOICE:'Επίλεξε συγκεκριμένο κοινό ή «Δεν γνωρίζω ακόμη».',SCHEMA_VERSION_STALE:'Αυτό το δοκιμαστικό έργο ανήκει στην προηγούμενη έκδοση. Άνοιξε μια νέα δοκιμαστική παραγγελία.'};
async function api(url,payload){if(backupReadOnly&&(payload||!backupReadPaths.has(url)))throw backupReadError();const response=await fetch(url,payload?{method:'POST',headers:{'Content-Type':'application/json',...(customerCsrf?{'X-Molyvi-Csrf':customerCsrf}:{})},body:JSON.stringify(payload)}:{cache:'no-store'});const data=await response.json();if(!response.ok){if(backupPausedErrors.has(data.error)){setBackupReadOnly(true);throw backupReadError();}const error=new Error(errors[data.error]??'Η ενέργεια δεν ολοκληρώθηκε. Προσπάθησε ξανά.');error.code=data.error;error.field=data.field;throw error;}if(!payload&&backupReadPaths.has(url))setBackupReadOnly(data.backupReadOnly===true);return data;}
function element(tag,text,attrs={}){const node=document.createElement(tag);if(text!==undefined)node.textContent=text;for(const [key,value]of Object.entries(attrs))node.setAttribute(key,value);return node;}
function notice(message){$('notice').textContent=message;}
let walletSignature='';
let offerSignature='';
function renderServiceOffer(){
  const offer=workspace.serviceOffer,panel=$('service-offer');if(!offer||!panel)return;
  const slots=Object.values(workspace.productGalleries??{}).flatMap(gallery=>gallery.slots??[]);
  const delivered=slots.filter(slot=>slot.candidates.length>0).length,selected=slots.filter(slot=>slot.selected).length;
  const signature=JSON.stringify([offer,delivered,selected,workspace.subscriptionAllocationUnknown,workspace.servicePayment]);if(signature===offerSignature)return;offerSignature=signature;
  const rights=offer.entitlements;
  panel.replaceChildren(element('h2',offer.legacy?'Η δοκιμαστική σου παραγγελία':offer.name));
  if(!offer.legacy)panel.append(element('p',`${new Intl.NumberFormat('el-GR').format(offer.netPriceMinor/100)} € + ΦΠΑ · τιμή της προδιαγραφής, χωρίς πραγματική χρέωση`,{class:'field-help'}));
  if(workspace.servicePayment)panel.append(element('p',workspace.servicePayment.evidenceMode==='signed_fixture'?'Η σύνδεση πληρωμής ελέγχθηκε με υπογεγραμμένο δοκιμαστικό αίτημα. Εκκρεμεί η πραγματική ειδοποίηση Shopify.':'Δοκιμαστική πληρωμή υπηρεσίας επιβεβαιωμένη. Κάθε οριστική υποβολή αποθηκεύεται στην ουρά παραγωγής.',{class:'note'}));
  panel.append(element('p',`${rights.catalogUnits} μονάδες προϊόντων · ${rights.photoSlotsPerUnit} φωτογραφίες ανά μονάδα · ${rights.photoSlots} φωτογραφίες στο πακέτο`,{class:'credit-total'}));
  panel.append(element('p',`${rights.aiTextVersionsPerField} AI εκδοχές ανά τίτλο και περιγραφή · ${rights.additionalPhotoRegenerationsPerSlot} πρόσθετες αναδημιουργίες ανά φωτογραφία, όταν τις ζητήσεις.`,{class:'field-help'}));
  panel.append(element('p',`Φωτογραφικές θέσεις με αποτέλεσμα: ${delivered} · με επιλεγμένη εκδοχή: ${selected}`,{class:'field-help'}));
  if(workspace.subscriptionAllocationUnknown)panel.append(element('p','Τα αποτελέσματα της δοκιμής παράχθηκαν με την υπάρχουσα συνεδρία Pro. Η κατανομή κόστους της συνδρομής δεν έχει μετρηθεί.',{class:'note'}));
}
let productionSignature='';
function renderProductProduction(){
  const panel=$('product-production'),jobs=workspace.productProduction??[],signature=JSON.stringify(jobs);
  if(!panel||signature===productionSignature)return;productionSignature=signature;panel.hidden=!jobs.length;
  panel.replaceChildren(element('h2','Επεξεργασία προϊόντων'));
  const products=workspace.tasks.find(task=>task.id==='catalog').draft.products??[];
  const labels={queued:'Σε αναμονή',running:'Επεξεργάζεται',result_ready:'Αποθηκεύουμε το αποτέλεσμα',completed:'Ολοκληρώθηκε',paused:'Χρειάζεται έλεγχος',cancelled:'Τα στοιχεία άλλαξαν'};
  const reasons={provider_unavailable:'Η αυτόματη επεξεργασία δεν είναι ενεργή σε αυτή τη δοκιμή.',daily_attempt_limit:'Συμπληρώθηκε το ημερήσιο όριο δοκιμής.',subscription_limit:'Η συνεδρία AI έφτασε στο όριό της.',interrupted_attempt:'Η προηγούμενη εκτέλεση διακόπηκε. Θα ελεγχθεί πριν επαναληφθεί.'};
  const list=element('ul');
  for(const job of jobs){
    const product=products.find(item=>item.id===job.productId),unit=product?.visualUnits?.find(item=>item.id===job.visualUnitId);
    const operation=job.kind==='materials'?'Έλεγχος αρχικών φωτογραφιών':job.field==='title'?'Πρόταση τίτλου':'Πρόταση περιγραφής';
    list.append(element('li',`${product?.title||'Προϊόν'}${unit?.color?' · '+unit.color:''}: ${operation} — ${labels[job.status]??'Σε αναμονή'}${reasons[job.reason]?' · '+reasons[job.reason]:''}`));
  }
  panel.append(list);
}
function renderWallet(){
  const wallet=workspace.credits,signature=JSON.stringify(wallet);if(!wallet||signature===walletSignature)return;walletSignature=signature;
  const panel=$('credit-wallet');panel.replaceChildren(element('h2','Τα credits σου'),element('p',`${wallet.available} διαθέσιμα · ${wallet.reserved} δεσμευμένα`,{class:'credit-total'}));
  panel.append(element('p',`${wallet.monthly.available} μηνιαία · ${wallet.purchased.available} πρόσθετα χωρίς λήξη`,{class:'field-help'}));
  if(workspace.demo)panel.append(element('p','Δοκιμαστικά credits — χωρίς χρηματική αξία. Οι ποσότητες δεν αποτελούν τιμοκατάλογο.',{class:'note'}));
  const details=element('details'),list=element('ul');details.append(element('summary','Υπόλοιπα, λήξεις & κινήσεις'));
  for(const grant of wallet.grants.filter(item=>item.available||item.reserved||item.expired))list.append(element('li',`${grant.kind==='monthly'?'Μηνιαία':'Πρόσθετα'}${grant.restored?' από αποκατάσταση':''}: ${grant.available} διαθέσιμα${grant.reserved?`, ${grant.reserved} δεσμευμένα`:''}${grant.expired?`, ${grant.expired} έληξαν`:''} · ${grant.expiresAt?'Λήξη '+new Date(grant.expiresAt).toLocaleDateString('el-GR'):'Χωρίς λήξη'}`));
  details.append(list);
  const labels={issued:'Προστέθηκαν',reserved:'Δεσμεύτηκαν',settled:'Χρησιμοποιήθηκαν',released:'Αποδεσμεύτηκαν',restored:'Επιστράφηκαν'},history=element('ol');
  for(const event of [...wallet.history].reverse())history.append(element('li',`${labels[event.type]??'Κίνηση'} ${event.amount} credits · ${new Date(event.createdAt).toLocaleString('el-GR')}${event.releasedAmount?` · ${event.releasedAmount} αποδεσμεύτηκαν`:''}`));
  if(!wallet.history.length)history.append(element('li','Δεν υπάρχουν ακόμη κινήσεις.'));details.append(history);panel.append(details);
}
Object.assign(errors,{"SHIPPING_PLAN_REQUIRED":"Διάλεξε χώρα και τρόπο χρέωσης πριν από την οριστική υποβολή.","SHIPPING_INCOMPLETE":"Συμπλήρωσε τις εκκρεμότητες του κανόνα αποστολής. Για χρέωση με βάρος χρειάζεται και το βάρος συσκευασίας.","SHIPPING_ENTITLEMENT_REQUIRED":"Αυτή η επιλογή αποστολής περιλαμβάνεται στο μεγαλύτερο πακέτο.","SHIPPING_COUNTRY_OVERLAP":"Κάθε χώρα μπορεί να ανήκει σε μία μόνο ζώνη αποστολής.","SHIPPING_COUNTRY_LIMIT":"Το Basic περιλαμβάνει μία χώρα αποστολής.","SHIPPING_ZONE_LIMIT":"Έχεις ξεπεράσει τις ζώνες αποστολής του πακέτου σου.","SHIPPING_REVIEW_REQUIRED":"Αποθήκευσε τη διαφορετική σου ανάγκη για αξιολόγηση πριν από την οριστική υποβολή.","SHIPPING_INVALID_INTEGER":"Έλεγξε τα ποσά και τα βάρη. Γράψε έως δύο δεκαδικά για ευρώ και τρία για κιλά, χωρίς αρνητικές τιμές.","SHIPPING_INVALID_TIME_RANGE":"Η δεύτερη τιμή χρόνου πρέπει να είναι ίση ή μεγαλύτερη από την πρώτη.","SHIPPING_OFFER_REVIEW_REQUIRED":"Αυτή η παλαιότερη παραγγελία χρειάζεται έλεγχο του πακέτου πριν προστεθούν κανόνες αποστολής."});
Object.assign(errors,{"TASK_NOT_AVAILABLE":"Το νέο βήμα είναι διαθέσιμο στις νέες δοκιμαστικές παραγγελίες. Η προηγούμενη παραγγελία σου παραμένει αμετάβλητη.","MERCHANT_INCOMPLETE":"Συμπλήρωσε τη χώρα, τη μορφή δραστηριότητας και τα βασικά στοιχεία πωλητή και επικοινωνίας πριν υποβάλεις το βήμα.","MERCHANT_INVALID_EMAIL":"Έλεγξε το email επικοινωνίας του καταστήματος.","MERCHANT_REVIEW_REQUIRED":"Κρατήσαμε τη διαφορετική σου περίπτωση για αξιολόγηση. Μπορείς να αποθηκεύσεις και να συνεχίσεις στα υπόλοιπα βήματα.","MERCHANT_SUBMISSION_REQUIRED":"Υπέβαλε πρώτα τα στοιχεία του πωλητή, ώστε οι επιλογές πληρωμών να βασίζονται στην ίδια οριστική πληροφορία.","PAYMENT_INCOMPLETE":"Διάλεξε πώς θέλεις να πληρώνουν οι πελάτες σου και επιβεβαίωσε το βήμα ενεργοποίησης στο Shopify.","PAYMENT_REVIEW_REQUIRED":"Αυτή η επιλογή χρειάζεται αξιολόγηση. Αποθήκευσέ την για να εξεταστεί πριν από την οριστική υποβολή.","PAYMENT_INVALID_COMBINATION":"Οι πρόσθετες μέθοδοι αφορούν το Shopify Payments. Έλεγξε τον συνδυασμό επιλογών σου."});
errors.STYLE_DECISION_REQUIRED='Μπορείς να αποθηκεύσεις το βήμα για αργότερα. Πριν ξεκινήσουμε την εικόνα του καταστήματος, διάλεξε ένα ύφος ή περιέγραψε το δικό σου στο «Άλλο».';
errors.PALETTE_STYLE_MISMATCH='Το ύφος άλλαξε. Διάλεξε μια από τις σχετικές παλέτες ή κράτησε τα χρώματά σου ως δική σου παλέτα.';
errors.PALETTE_LOGO_REQUIRED='Για να βασιστούμε στο λογότυπό σου, επίλεξε «Έχω λογότυπο» και πρόσθεσε το αρχείο του.';
errors.INVALID_COLOR='Συμπλήρωσε το χρώμα ως # και έξι χαρακτήρες, για παράδειγμα #526044, ή χρησιμοποίησε τον επιλογέα χρώματος.';
Object.assign(errors,{LOGO_UPLOAD_REQUIRED:'Ανέβασε το αρχείο του λογοτύπου σου πριν υποβάλεις το βήμα.',LOGO_TOO_LARGE:'Επίλεξε logo έως 4 MB.',LOGO_STORAGE_LIMIT:'Έφτασες το όριο αρχείων αυτής της δοκιμής.',LOGO_PALETTE_UNAVAILABLE:'Δεν μπορέσαμε να προτείνουμε χρώματα από αυτό το αρχείο. Διάλεξε μία από τις παλέτες ή τα δικά σου χρώματα.',INVALID_PHOTO:'Χρησιμοποίησε αρχείο PNG, JPEG ή WebP.',INVALID_PHOTO_TYPE:'Χρησιμοποίησε αρχείο PNG, JPEG ή WebP.'});
function renderNavigation(){
  const signature=JSON.stringify([workspace.id,current,workspace.tasks.map(task=>[task.id,task.status,Boolean(task.submission)]),workspace.productTasks]);
  if(signature===navSignature)return;
  navSignature=signature;
  const submitted=workspace.tasks.filter(task=>task.id!=='catalog'&&task.submission).length;
  const products=Object.values(workspace.productTasks??{}),submittedProducts=products.filter(product=>product.submission).length;
  $('progress').textContent=`Κοινά βήματα: ${submitted}/${workspace.tasks.length-1} · Υποβλημένα προϊόντα: ${submittedProducts}`;
  $('steps').replaceChildren();$('remaining').replaceChildren();
  workspace.tasks.forEach((task,index)=>{
    const button=element('button',`${String(index+1).padStart(2,'0')}  ${task.title}`,{type:'button','data-backup-navigation':''});
    button.classList.toggle('active',task.id===current);
    if(task.id===current)button.setAttribute('aria-current','step');
    button.append(element('small',task.id==='catalog'&&products.length?`Υποβλήθηκαν: ${submittedProducts}/${products.length}`:taskLabel(task.status)));
    button.addEventListener('click',()=>navigate(task.id));$('steps').append(button);
    if(!task.submission&&(task.id!=='catalog'||!products.length||products.some(product=>!product.submission))){const li=element('li');const link=element('button',task.id==='catalog'&&products.length?`${task.title} · Εκκρεμότητες: ${products.length-submittedProducts}`:task.title,{type:'button','data-backup-navigation':''});link.addEventListener('click',()=>navigate(task.id));li.append(link);$('remaining').append(li);}
  });
  if(submitted===workspace.tasks.length)$('remaining').append(element('li','Όλα τα βήματα υποβλήθηκαν.'));
}
function navigate(id){if(busy)return;if(dirty){notice('Αποθήκευσε ή παράλειψε το βήμα για να κρατήσεις τις αλλαγές σου πριν μετακινηθείς.');return;}current=id;notice('');render();}
function next(){const index=workspace.tasks.findIndex(task=>task.id===current);current=workspace.tasks[index+1]?.id??workspace.tasks.find(task=>!task.submission)?.id??current;}
function formAnswers({complete=false}={}){
  const task=workspace.tasks.find(task=>task.id===current);
  return Object.fromEntries(task.fields.map(field=>{
    const selected=()=>[...$('task-form').querySelectorAll(`input[name="${field.id}"]:checked`)];
    const value=['merchant-profile','payment-plan','returns-plan','policy-inputs','page-content'].includes(field.type)?$(`group-${field.id}`).profileEditor.read({complete}):field.type==='shipping-plan'?$(`group-${field.id}`).shippingEditor.read({complete}):field.type==='products'?MolyviProducts.read():field.type==='multi'?selected().map(input=>input.value):['visual-choice','palette-choice'].includes(field.type)?(selected()[0]?.value??''):$(`field-${field.id}`).value;
    return [field.id,value];
  }));
}
function conditionalFields(task,form){
  syncPalettes(task);
  if(!task.fields.some(field=>field.when))return;
  const answers=formAnswers();
  for(const field of task.fields.filter(field=>field.when)){
    const conditions=Array.isArray(field.when)?field.when:[field.when];
    const visible=conditions.every(condition=>Array.isArray(answers[condition.field])?answers[condition.field].includes(condition.value):answers[condition.field]===condition.value);
    $(`group-${field.id}`).hidden=!visible;
  }
}
const validHex=value=>/^#[\da-f]{6}$/i.test(value);
function readableInk(hex){
  const rgb=[1,3,5].map(start=>parseInt(hex.slice(start,start+2),16)/255).map(channel=>channel<=.04045?channel/12.92:((channel+.055)/1.055)**2.4);
  const luminance=.2126*rgb[0]+.7152*rgb[1]+.0722*rgb[2];
  return (luminance+.05)/.05>=1.05/(luminance+.05)?'#000000':'#ffffff';
}
function writeColors(palette){
  for(const key of ['primary','secondary','accent']){
    $(`field-${key}`).value=palette[key];$(`picker-${key}`).value=palette[key];
  }
}
function syncPalettes(task){
  const field=task.fields.find(item=>item.type==='palette-choice');if(!field)return;
  const answers=formAnswers(),hasStyle=!['','unknown'].includes(answers.style);
  for(const option of $('palette-options').children){
    const input=option.querySelector('input'),preset=field.palettes.find(item=>item.id===input.value);
    const visible=preset?preset.style===answers.style:input.value==='from_logo'?answers.logoMode==='existing':true;
    option.hidden=!visible;if(!visible)input.checked=false;
  }
  const selected=document.querySelector('input[name="palette"]:checked')?.value??'',preset=field.palettes.find(item=>item.id===selected);
  if(preset)writeColors(preset);
  const logoProposal=selected==='from_logo'?workspace.brandAssets?.find(asset=>asset.id===answers.logoReference)?.paletteProposal:null;
  if(logoProposal)writeColors(logoProposal);
  $('palette-options').hidden=!hasStyle;
  $('palette-intro').textContent=hasStyle?(answers.style==='other'?'Τρεις ήρεμες βάσεις για να ξεκινήσεις. Μπορείς να δημιουργήσεις και τη δική σου.':'Τρεις συνδυασμοί για το ύφος που επέλεξες. Διάλεξε αυτόν που σε εκφράζει.'):'Επίλεξε πρώτα ένα ύφος για να δεις τις σχετικές παλέτες.';
  $('customize-palette').hidden=!preset;
  const colors=Object.fromEntries(['primary','secondary','accent'].map(key=>[key,$(`field-${key}`).value]));
  const preview=$('palette-live-preview');preview.hidden=!hasStyle||!selected||selected==='from_logo'&&!logoProposal||!Object.values(colors).every(validHex);
  if(!preview.hidden){
    const sample=stylePreview(answers.style==='other'?'minimal':answers.style);
    for(const [key,value]of Object.entries({'--paper':colors.secondary,'--ink':readableInk(colors.secondary),'--tone':colors.primary,'--object':colors.accent,'--mark':colors.accent}))sample.style.setProperty(key,value);
    sample.querySelector('.mini-art').style.background=colors.primary;
    sample.querySelector('.mini-cta').style.color=readableInk(colors.accent);
    preview.replaceChildren(element('p','Έτσι συνδυάζονται τα χρώματά σου',{class:'palette-preview-title'}),sample,element('p','Ενδεικτικός συνδυασμός χρωμάτων. Η τελική εφαρμογή τους προσαρμόζεται στο κατάστημά σου.',{class:'field-help'}));
  }
  $('palette-logo-note').hidden=selected!=='from_logo';
  $('palette-logo-note').textContent=logoProposal?'Μια πρώτη παλέτα από τα χρώματα του logo σου. Θα δεις την εμφάνιση και θα την εγκρίνεις πριν χρησιμοποιηθεί.':'Για αυτόματη πρόταση, ανέβασε καθαρό PNG. Αν δεν αναγνωρίσουμε τα χρώματά του, διάλεξε έτοιμη ή δική σου παλέτα.';
}
async function uploadBrandLogo(file){
  if(busy||!file)return;if(file.size>4*1024*1024){notice(errors.LOGO_TOO_LARGE);return;}
  const task=workspace.tasks.find(item=>item.id==='branding'),answers=formAnswers();busy=true;
  let draftSaved=false;
  const controls=[...document.querySelectorAll('#card button,#card input,#card select,#card textarea')].map(node=>({node,disabled:node.disabled}));controls.forEach(({node})=>node.disabled=true);
  try{
    const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(new Error('Το αρχείο δεν διαβάστηκε.'));reader.readAsDataURL(file);});
    workspace=(await api('/api/task',{action:'save',taskId:'branding',revision:task.revision,answers})).workspace;dirty=false;draftSaved=true;
    const uploaded=await api('/api/logo-upload',{name:file.name,mime:file.type,data});workspace=uploaded.workspace;
    answers.logoReference=uploaded.receipt.assetId;
    workspace=(await api('/api/task',{action:'save',taskId:'branding',revision:workspace.tasks.find(item=>item.id==='branding').revision,answers})).workspace;
    render();notice('Το logo σου αποθηκεύτηκε ιδιωτικά. Μπορείς να συνεχίσεις με την παλέτα σου.');
  }catch(error){if(draftSaved)render();notice(error.message);}finally{busy=false;controls.forEach(({node,disabled})=>{if(node.isConnected)node.disabled=disabled;});}
}
function stylePreview(value){
  const preview=element('div',undefined,{class:`style-preview style-${value}`,'aria-hidden':'true'});
  const header=element('div',undefined,{class:'mini-header'});
  header.append(element('span','Το όνομά σου'),element('span','Συλλογή'));
  const hero=element('div',undefined,{class:'mini-hero'});
  const copy=element('div',undefined,{class:'mini-copy'});
  copy.append(element('span','Η ΝΕΑ ΣΥΛΛΟΓΗ'),element('strong','Μικρές λεπτομέρειες.\nΔικός σου χαρακτήρας.'),element('span','Ανακάλυψέ τη →',{class:'mini-cta'}));
  const artwork=element('div',undefined,{class:'mini-art'});
  artwork.append(element('i',undefined,{class:'art-shape'}),element('i',undefined,{class:'art-shadow'}));
  hero.append(copy,artwork);preview.append(header,hero);
  return preview;
}
function renderField(field,task){
  if(['returns-plan','policy-inputs','page-content'].includes(field.type)){
    const wrapper=element('div',undefined,{id:`group-${field.id}`,class:'field'}),taskAnswers=id=>{const t=workspace.tasks.find(item=>item.id===id);return t?.submission?.answers??t?.draft??{};};
    const options={changed:()=>{dirty=true;},merchant:taskAnswers('merchant').merchantProfile,business:taskAnswers('business'),countries:workspace.shippingPolicy.countries};
    const method={'returns-plan':'renderReturns','policy-inputs':'renderPolicies','page-content':'renderPages'}[field.type];
    wrapper.profileEditor=MolyviStoreContent[method](task.draft[field.id],options);wrapper.append(wrapper.profileEditor.node);return wrapper;
  }
  if(['merchant-profile','payment-plan'].includes(field.type)){
    const wrapper=element('div',undefined,{id:`group-${field.id}`,class:'field'}),merchantTask=workspace.tasks.find(item=>item.id==='merchant'),shippingTask=workspace.tasks.find(item=>item.id==='operations');
    const options={changed:()=>{dirty=true;},merchant:(merchantTask?.submission?.answers??merchantTask?.draft)?.merchantProfile,shippingPlan:(shippingTask?.submission?.answers??shippingTask?.draft)?.shippingPlan,guidance:workspace.paymentGuidance};
    const editor=field.type==='merchant-profile'?MolyviMerchantPayments.renderMerchant(task.draft[field.id],options):MolyviMerchantPayments.renderPayments(task.draft[field.id],options);
    wrapper.profileEditor=editor;wrapper.append(editor.node);return wrapper;
  }
  if(field.type==='products')return MolyviProducts.render(task,{materials:workspace.materials,texts:workspace.productTexts,states:workspace.productTasks,galleries:workspace.productGalleries,galleryAction,photoClaims:workspace.photoClaims??[],photoClaimAction,serviceOffer:workspace.serviceOffer,changed:()=>{dirty=true;},action:productAction});
  if(field.type==='shipping-plan'){
    const wrapper=element('div',undefined,{id:`group-${field.id}`,class:'field'});
    const editor=MolyviShipping.render(task.draft[field.id],{policy:workspace.shippingPolicy,changed:()=>{dirty=true;},onEstimate:async scenario=>{
      if(dirty)throw new Error('Αποθήκευσε πρώτα τις αλλαγές σου για να δοκιμάσεις τον κανόνα που επέλεξες.');
      return (await api('/api/shipping-estimate',{revision:task.revision,scenario})).estimate;
    }});
    wrapper.shippingEditor=editor;wrapper.append(editor.node);return wrapper;
  }
  const labelText=field.label+(field.required?' *':' (προαιρετικό)');
  const wrapper=element(['multi','visual-choice','palette-choice'].includes(field.type)?'fieldset':'div',undefined,{id:`group-${field.id}`,class:'field'});
  const helpId=`help-${field.id}`;
  if(field.type==='logo-upload'){
    const input=element('input',undefined,{type:'hidden',id:`field-${field.id}`,name:field.id});input.value=task.draft[field.id]??'';
    const picker=element('input',undefined,{type:'file',id:'logo-file',accept:'image/png,image/jpeg,image/webp','aria-describedby':helpId});
    picker.addEventListener('change',()=>{void uploadBrandLogo(picker.files[0]);});
    wrapper.append(element('label',labelText,{for:'logo-file'}),input,picker,element('p','PNG, JPEG ή WebP · έως 4 MB. Το αρχικό αρχείο διατηρείται χωρίς επεξεργασία.',{class:'field-help'}));
    const asset=workspace.brandAssets?.find(item=>item.id===input.value);
    if(asset)wrapper.append(element('img',undefined,{src:`/api/logo/${asset.id}`,alt:'Το λογότυπο που ανέβασες',class:'uploaded-logo'}),element('p',asset.name,{class:'field-help'}));
  }else if(field.type==='palette-choice'){
    wrapper.append(element('legend',labelText));wrapper.setAttribute('aria-describedby',helpId);
    wrapper.append(element('p','',{id:'palette-intro',class:'field-help'}));
    const options=element('div',undefined,{id:'palette-options',class:'palette-options'});
    for(const [value,text]of field.options){
      const preset=field.palettes.find(item=>item.id===value),label=element('label',undefined,{class:`palette-option${preset?'':' palette-option-text'}`});
      const input=element('input',undefined,{type:'radio',name:field.id,value,id:`field-${field.id}-${value}`});input.checked=task.draft[field.id]===value;label.htmlFor=input.id;
      const heading=element('span',undefined,{class:'palette-heading'});heading.append(input,element('strong',text));label.append(heading);
      if(preset){
        const swatches=element('span',undefined,{class:'palette-swatches','aria-hidden':'true'});
        for(const key of ['primary','secondary','accent']){const swatch=element('i');swatch.style.background=preset[key];swatches.append(swatch);}
        label.append(swatches,element('span','Βασικό · Δεύτερο · Έμφαση',{class:'palette-roles'}));
      }
      options.append(label);
    }
    const customize=element('button','Προσαρμογή χρωμάτων',{id:'customize-palette',type:'button',class:'secondary'});
    customize.addEventListener('click',()=>{$('field-palette-custom').checked=true;dirty=true;conditionalFields(task,$('task-form'));$('field-primary').focus();});
    wrapper.append(options,customize,element('p','Θα βασιστούμε στο λογότυπο που θα μας δώσεις. Η αναγνώριση των χρωμάτων του γίνεται στο στάδιο επεξεργασίας.',{id:'palette-logo-note',class:'field-help'}),element('div',undefined,{id:'palette-live-preview',class:'palette-live-preview'}));
  }else if(field.type==='visual-choice'){
    wrapper.append(element('legend',labelText));wrapper.setAttribute('aria-describedby',helpId);
    const options=element('div',undefined,{class:'style-options'});
    for(const [value,text] of field.options){
      const visual=!['unknown','other'].includes(value);
      const label=element('label',undefined,{class:`style-option${visual?'':' style-option-text'}`});
      const input=element('input',undefined,{type:'radio',name:field.id,value,id:`field-${field.id}-${value}`,'aria-describedby':`description-${field.id}-${value}`});
      input.checked=task.draft[field.id]===value;label.htmlFor=input.id;
      if(visual)label.append(stylePreview(value));
      const body=element('div',undefined,{class:'style-option-body'});
      const heading=element('div',undefined,{class:'style-option-heading'});heading.append(input,element('strong',text));
      body.append(heading,element('span',field.descriptions[value],{id:`description-${field.id}-${value}`,class:'style-description'}));label.append(body);options.append(label);
    }
    wrapper.append(options,element('p','Τα δείγματα δείχνουν την αίσθηση. Η τελική εμφάνιση θα βασιστεί στο λογότυπο, τα χρώματα και τα προϊόντα σου.',{class:'field-help'}));
  }else if(field.type==='multi'){
    wrapper.append(element('legend',labelText));
    wrapper.setAttribute('aria-describedby',helpId);
    const options=element('div',undefined,{class:'choices'});
    for(const [value,text]of field.options){
      const label=element('label',undefined,{class:'choice'});
      const input=element('input',undefined,{type:'checkbox',name:field.id,value,id:`field-${field.id}-${value}`});
      input.checked=(task.draft[field.id]??[]).includes(value);
      label.htmlFor=input.id;label.append(input,element('span',text));options.append(label);
      input.addEventListener('change',()=>{
        if(input.checked)for(const other of options.querySelectorAll('input')){
          if(other!==input && (field.exclusive?.includes(value)||field.exclusive?.includes(other.value)))other.checked=false;
        }
        dirty=true;conditionalFields(task,$('task-form'));
      });
    }
    wrapper.append(options);
  }else{
    const label=element('label',labelText,{for:`field-${field.id}`});
    let input;
    if(field.type==='color'){
      input=element('input',undefined,{type:'text',placeholder:'#526044',maxlength:'7',spellcheck:'false',autocomplete:'off'});
    }else if(field.type==='select'){
      input=element('select');input.append(element('option','Επίλεξε…',{value:''}));
      for(const [value,text]of field.options)input.append(element('option',text,{value}));
    }else if(field.type==='textarea')input=element('textarea');
    else input=element('input',undefined,{type:field.type??'text'});
    input.name=field.id;input.id=`field-${field.id}`;
    input.setAttribute('aria-label',labelText);
    input.value=task.draft[field.id]??'';
    if(field.help)input.setAttribute('aria-describedby',helpId);
    if(field.placeholder)input.placeholder=field.placeholder;
    if(field.type==='number'){input.min='0';input.step=field.id==='stock'?'1':'0.01';}
    if(field.type==='color'){
      const row=element('div',undefined,{class:'color-edit'}),picker=element('input',undefined,{type:'color',id:`picker-${field.id}`,'aria-label':`Επιλογέας: ${field.label}`});
      picker.value=validHex(input.value)?input.value:'#333333';
      picker.addEventListener('input',()=>{input.value=picker.value;});
      input.addEventListener('input',()=>{if(validHex(input.value))picker.value=input.value;});
      row.append(picker,input);wrapper.append(label,row);
    }else wrapper.append(label,input);
  }
  if(field.help)wrapper.append(element('p',field.help,{id:helpId,class:'field-help'}));
  return wrapper;
}
function appendOperationalResult(card,task){
  const output=task.result?.output;
  if(!['service_shipping_plan','service_merchant_profile','service_payment_plan','service_returns_plan','service_policy_drafts','service_information_pages'].includes(output?.delivery))return;
  const panel=element('section',undefined,{class:'operational-result','aria-label':'Το αποτέλεσμα αυτού του βήματος'});
  panel.append(element('h3',output.title),element('p',output.summary));
  if(output.delivery==='service_payment_plan')panel.append(element('p','Οι προτιμήσεις σου είναι έτοιμες. Μετά την παράδοση, ολοκληρώνεις προσωπικά την ενεργοποίηση στο Shopify με τα δικά σου στοιχεία.',{class:'content-note'}));
  else if(output.documents){
    const list=element('ul');for(const document of output.documents)list.append(element('li',document.title));panel.append(list);
    panel.append(element('p','Τα προσχέδια βασίζονται στις οριστικές απαντήσεις σου. Δες την προεπισκόπηση και τις σημειώσεις ελέγχου παρακάτω πριν χρησιμοποιήσεις τα κείμενα.',{class:'content-note'}));
  }
  panel.append(element('p','Προετοιμάστηκε στο έργο σου. Η εφαρμογή στο Shopify παραμένει σε εκκρεμότητα.',{class:'hint'}));
  card.append(panel);
}
function contentPreviewKey(state,taskId){
  if(state?.contentContractVersion!==1||!['returns','policies','pages'].includes(taskId))return null;
  return JSON.stringify([state.id,taskId,['business','merchant','operations','payouts','returns','policies','pages'].map(id=>{const task=state.tasks.find(item=>item.id===id);return [id,task?.revision??null,task?.submission?.hash??null];})]);
}
function render({preserveContentPreview=false}={}){
  if(workspace?.servicePayment?.status==='pending'){
    $('welcome').hidden=false;$('workspace').hidden=true;$('service-payment').hidden=false;$('service-open').hidden=true;
    $('service-status').textContent='Το έργο σου είναι έτοιμο να ανοίξει. Περιμένουμε την επιβεβαίωση της δοκιμαστικής πληρωμής.';
    $('service-checkout').hidden=!workspace.servicePayment.checkoutConfigured;
    return;
  }
  if(!workspace)return;
  $('welcome').hidden=true;$('workspace').hidden=false;renderNavigation();renderWallet();renderServiceOffer();renderProductProduction();if(!backupReadOnly)void globalThis.MolyviBasicPreparation?.refresh(workspace.id);
  const task=workspace.tasks.find(task=>task.id===current),card=$('card');
  const previousPreview=preserveContentPreview&&!dirty?card.querySelector('.content-preview'):null;
  const retainedPreview=previousPreview?.sourceKey===contentPreviewKey(workspace,current)?previousPreview:null;
  card.replaceChildren(element('div','',{class:'line'}),element('h2',task.title));
  if(task.submission){
    card.append(element('p','Οι απαντήσεις αυτού του βήματος έχουν κλειδώσει. Μπορείς να συνεχίσεις στα υπόλοιπα.',{class:'hint'}));
    let status=taskLabel(task.status);
    if(task.status==='waiting_dependencies')status+=': '+task.waitingFor.map(id=>workspace.tasks.find(item=>item.id===id).title).join(', ');
    card.append(element('div',status,{class:'status'}));
    const list=element('dl',undefined,{class:'answers'});
    for(const field of task.fields){
      const raw=task.submission.answers[field.id];if(!raw||Array.isArray(raw)&&!raw.length)continue;
      const optionLabel=value=>field.type==='logo-upload'?(workspace.brandAssets?.find(asset=>asset.id===value)?.name??'Παλαιότερη αναφορά αρχείου'):field.options?.find(([id])=>id===value)?.[1]??value;
      const contentSummary={'returns-plan':'returnsSummary','policy-inputs':'policiesSummary','page-content':'pagesSummary'}[field.type];
      const sellerTask=workspace.tasks.find(item=>item.id==='merchant'),summaryOptions={merchant:(sellerTask?.submission?.answers??sellerTask?.draft)?.merchantProfile};
      const value=contentSummary?MolyviStoreContent[contentSummary](raw,summaryOptions).join('\n'):field.type==='merchant-profile'?MolyviMerchantPayments.merchantSummary(raw).join('\n'):field.type==='payment-plan'?MolyviMerchantPayments.paymentsSummary(raw).join('\n'):field.type==='shipping-plan'?MolyviShipping.summary(raw,workspace.shippingPolicy).join('\n'):field.type==='products'?raw.map(product=>`${task.submission.productCopy?.find(copy=>copy.productId===product.id)?.title.text??product.title} · ${product.price} € · ${product.photos.length} φωτογραφίες`).join('\n'):Array.isArray(raw)?raw.map(optionLabel).join(', '):optionLabel(raw);
      list.append(element('dt',field.label),element('dd',value));
    }
    card.append(list);
    if(task.result?.output.delivery==='pro_business_direction'){
      const direction=task.result.output,panel=element('section',undefined,{class:'business-direction'});
      panel.append(element('h3','Η πρώτη κατεύθυνση του καταστήματός σου'),element('p','Διαμορφώθηκε από τις απαντήσεις σου. Θα συνδυαστεί με το branding και τα προϊόντα στα επόμενα βήματα.',{class:'hint'}));
      panel.append(element('p',direction.summary),element('h4','Πώς θα παρουσιαστεί'),element('p',direction.positioning),element('h4','Το ύφος των κειμένων'),element('p',direction.tone),element('h4','Προτεινόμενες συλλογές'));
      const collections=element('ul');for(const item of direction.collections)collections.append(element('li',`${item.title} — ${item.purpose}`));panel.append(collections);
      if(direction.missingInformation.length){panel.append(element('h4','Τι θα μας βοηθήσει στη συνέχεια'));const missing=element('ul');for(const item of direction.missingInformation)missing.append(element('li',item));panel.append(missing);}
      if(direction.limitations.length){const details=element('details'),limitations=element('ul');details.append(element('summary','Όρια αυτής της κατεύθυνσης'));for(const item of direction.limitations)limitations.append(element('li',item));details.append(limitations);panel.append(details);}
      card.append(panel);
    }
    if(task.result?.output.delivery==='brand_presentation')appendBrandPresentation(card,task);
    appendOperationalResult(card,task);
    appendContentPreview(card,task,retainedPreview);
    if(task.status==='awaiting_approval'&&task.result?.output.delivery!=='brand_presentation'){
      card.append(element('p','Στη δοκιμή η έγκριση απλώς επιτρέπει στο επόμενο εξαρτώμενο βήμα να προχωρήσει. Δεν εγκρίνεις πραγματικό logo ή φωτογραφία.',{class:'note'}));
      const approve=element('button','Έγκριση δοκιμαστικού αποτελέσματος',{type:'button'});
      approve.addEventListener('click',()=>command({action:'approve',taskId:task.id,resultHash:task.result.hash}));card.append(approve);
    }
    return;
  }
  card.append(element('p',task.intro??'Δεν χρειάζεται να τα έχεις όλα έτοιμα. Η αποθήκευση και η παράλειψη δεν ξεκινούν παραγωγή.',{class:'hint'}));
  const form=element('form',undefined,{id:'task-form',novalidate:''});
  for(const field of task.fields)form.append(renderField(field,task));
  form.addEventListener('submit',event=>event.preventDefault());
  form.addEventListener('input',()=>{dirty=true;conditionalFields(task,form);});
  const actions=element('div',undefined,{class:'actions'});
  for(const [action,label]of [['skip','Παράλειψη →'],['save','Αποθήκευση'],['submit','Οριστική υποβολή']]){
    if(task.id==='catalog'&&action==='submit')continue;
    const button=element('button',task.id==='catalog'&&action==='save'?'Αποθήκευση όλων των πρόχειρων':label,{type:'button'});if(action!=='submit')button.className='secondary';
    button.addEventListener('click',()=>{
      let answers;try{answers=formAnswers({complete:action==='submit'});}catch(error){notice(error.message);return;}
      const value={action,taskId:task.id,revision:task.revision,answers};
      if(action==='submit'){pending=value;$('confirm-title').textContent='Οριστική υποβολή αυτού του βήματος;';$('confirm-message').textContent='Ξεκινάμε την επεξεργασία των στοιχείων του. Δεν θα μπορείς πλέον να αλλάξεις τις απαντήσεις σε αυτό το βήμα. Τα υπόλοιπα βήματα παραμένουν διαθέσιμα.';$('confirm').showModal();}else command(value,action==='skip');
    });actions.append(button);
  }
  form.append(actions);card.append(form);conditionalFields(task,form);appendContentPreview(card,task,retainedPreview);
}
function appendBrandPresentation(card,task){
  const brand=task.result.output,panel=element('section',undefined,{class:'brand-presentation'});
  panel.append(element('h3','Η εικόνα σου, με συνέπεια.'),element('p','Μια προεπισκόπηση του ονόματος ή του logo, της παλέτας και του ύφους σου. Η τελική σελίδα θα συμπληρωθεί με τα προϊόντα σου.',{class:'hint'}));
  const sample=element('div',undefined,{class:'brand-sample'});sample.style.fontFamily=brand.fontFamily;sample.style.background=brand.palette.secondary;sample.style.color=brand.readable.onSecondary;
  const header=element('div',undefined,{class:'brand-sample-header'});
  header.append(brand.logoAssetId?element('img',undefined,{src:`/api/logo/${brand.logoAssetId}`,alt:brand.brandName}):element('strong',brand.brandName),element('span','Η συλλογή σου'));sample.append(header);
  const hero=element('div',undefined,{class:'brand-sample-hero'});hero.style.background=brand.palette.primary;hero.style.color=brand.readable.onPrimary;
  hero.append(element('span','ΔΙΚΟΣ ΣΟΥ ΧΑΡΑΚΤΗΡΑΣ'),element('h4','Μικρές λεπτομέρειες.\nΜεγάλη αίσθηση.'));
  const cta=element('span','Ανακάλυψε τη συλλογή →',{class:'brand-sample-cta'});cta.style.background=brand.palette.accent;cta.style.color=brand.readable.onAccent;hero.append(cta);sample.append(hero);panel.append(sample);
  const swatches=element('div',undefined,{class:'approved-swatches'});for(const [key,label]of [['primary','Βασικό'],['secondary','Δεύτερο'],['accent','Έμφαση']]){const swatch=element('div'),color=element('i');color.style.background=brand.palette[key];swatch.append(color,element('span',`${label} · ${brand.palette[key]}`));swatches.append(swatch);}panel.append(swatches);
  if(task.status==='awaiting_approval'){
    const label=element('label',undefined,{class:'brand-review'}),check=element('input',undefined,{type:'checkbox'});label.append(check,element('span','Έλεγξα όνομα ή logo, χρώματα και ύφος.'));
    const button=element('button','Έγκριση εμφάνισης για τη δοκιμή',{type:'button'});button.disabled=true;check.addEventListener('change',()=>{button.disabled=!check.checked;});button.addEventListener('click',()=>command({action:'approve',taskId:'branding',resultHash:task.result.hash}));
    panel.append(element('p','Η έγκριση αφορά αυτή την εμφάνιση. Το κατάστημα δεν έχει κατασκευαστεί ή δημοσιευθεί ακόμη.',{class:'note'}),label,button);
  }else panel.append(element('p','Η εμφάνιση εγκρίθηκε και κρατήθηκε για την κατασκευή.',{class:'status'}));card.append(panel);
}
function appendContentPreview(card,task,retainedPreview=null){
  if(workspace.contentContractVersion!==1||!['returns','policies','pages'].includes(task.id))return;
  if(retainedPreview){card.append(retainedPreview);return;}
  const section=element('section',undefined,{class:'content-preview'}),open=element('button','Προεπισκόπηση των 7 σελίδων',{type:'button',class:'secondary'});
  section.sourceKey=contentPreviewKey(workspace,task.id);
  const panel=element('div');section.append(element('h3','Τα κείμενα του καταστήματός σου'),element('p','Τέσσερις πολιτικές και τρεις ενημερωτικές σελίδες, από τις αποθηκευμένες απαντήσεις σου. Πριν χρησιμοποιηθούν, ελέγχεις την ακριβή εκδοχή τους.',{class:'note'}),open,panel);card.append(section);
  const show=bundle=>{
    panel.replaceChildren(element('p','Προσχέδια προς έλεγχο — δεν έχουν δημοσιευθεί.',{class:'status'}));
    if(bundle.pending.length){const list=element('ul');for(const item of bundle.pending)list.append(element('li',contentIssue(item)));panel.append(element('p','Για να ολοκληρωθούν τα κείμενα:'),list);}
    if(bundle.publicationBlockers?.length){const list=element('ul');for(const item of bundle.publicationBlockers)list.append(element('li',contentIssue(item)));panel.append(element('p','Πριν χρησιμοποιηθούν οι σελίδες σε πραγματικό κατάστημα, χρειάζονται επιβεβαίωση:',{class:'status'}),list);}
    for(const warning of bundle.warnings??[])panel.append(element('p',typeof warning==='string'?warning:warning.text??warning.message??'Απαιτείται έλεγχος πριν από την εφαρμογή.',{class:'note'}));
    for(const doc of bundle.documents){
      const details=element('details'),summary=element('summary',doc.title),body=element('div',undefined,{class:'content-document'});
      for(const paragraph of (doc.publicText??doc.text).split('\n\n'))body.append(element('p',paragraph));
      details.append(summary,body);
      if(doc.reviewNotes?.length){
        const notes=element('aside',undefined,{class:'content-note','aria-label':'Σημειώσεις ελέγχου'});
        notes.append(element('strong','Σημειώσεις ελέγχου — δεν εμφανίζονται στη σελίδα'));
        for(const note of doc.reviewNotes)notes.append(element('p',typeof note==='string'?note:note.text??''));
        details.append(notes);
      }
      panel.append(details);
    }
    if(bundle.approval){panel.append(element('p','Καταγράφηκε ο έλεγχός σου για αυτή την εκδοχή. Η δημοσίευση και η πραγματική εφαρμογή παραμένουν ξεχωριστά βήματα.',{class:'status'}));return;}
    if(!bundle.reviewAllowed){panel.append(element('p','Οριστικοποίησε τα στοιχεία καταστήματος, πωλητή, αποστολών, πληρωμών και τα τρία νέα βήματα. Οι εκκρεμότητες των προσχεδίων πρέπει επίσης να έχουν κλείσει πριν καταγραφεί ο τελικός έλεγχος.',{class:'note'}));return;}
    const label=element('label',undefined,{class:'merchant-check'}),ack=element('input',undefined,{type:'checkbox','aria-label':'Έλεγξα αυτή την εκδοχή των κειμένων'});
    label.append(ack,element('span','Έλεγξα αυτή την εκδοχή. Αναλαμβάνω τον τελικό έλεγχο καταλληλότητας και νομικής εγκυρότητας πριν χρησιμοποιηθούν οι πολιτικές.'));
    const review=element('button','Καταγραφή ελέγχου αυτής της εκδοχής',{type:'button'});review.disabled=true;ack.addEventListener('change',()=>review.disabled=!ack.checked);
    review.addEventListener('click',async()=>{if(busy)return;busy=true;review.disabled=true;try{const result=await api('/api/content-review',{bundleHash:bundle.bundleHash,acknowledged:ack.checked});show(result.preview);notice('Ο έλεγχός σου αποθηκεύτηκε για τη συγκεκριμένη εκδοχή.');}catch(error){notice(error.message);review.disabled=!ack.checked;}finally{busy=false;}});panel.append(label,review);
  };
  open.addEventListener('click',async()=>{if(busy)return;if(dirty){notice('Αποθήκευσε τις αλλαγές σου για να εμφανιστούν στα προσχέδια.');return;}open.disabled=true;try{show(await api('/api/content-preview'));}catch(error){notice(error.message);}finally{open.disabled=false;}});
}
function contentIssue(item){
  const field=String(item.field??''),prefix=field.split('.')[0];
  const area={business:'στοιχεία καταστήματος',merchantProfile:'στοιχεία πωλητή',shippingPlan:'αποστολές',paymentPlan:'πληρωμές',returnsPlan:'επιστροφές και αλλαγές',policyInputs:'πολιτικές',pageContent:'ενημερωτικές σελίδες'}[prefix]??'απαντήσεις του σχετικού βήματος';
  const labels={name:'όνομα καταστήματος',aboutStory:'ιστορία ή δραστηριότητα',windowMode:'προθεσμία επιστροφής',returnShippingPayer:'μεταφορικά επιστροφής',returnAddressMode:'διεύθυνση επιστροφών',offersExchanges:'δυνατότητα αλλαγών',productCharacteristics:'χαρακτηριστικά προϊόντων',serviceProviders:'υπηρεσίες και πάροχοι',retentionCriteria:'διατήρηση δεδομένων',analytics:'στατιστικά και pixels',marketing:'marketing',cookieConsent:'μηχανισμός cookies',internationalTransfers:'διαβιβάσεις δεδομένων',country:'χώρα έδρας',contactEmail:'email επικοινωνίας',online:'επιλογή πληρωμών',activationAcknowledged:'ενημέρωση ενεργοποίησης πληρωμών'};
  const publicationLabels={legalName:'πλήρης νομική επωνυμία',taxNumber:'ΑΦΜ πωλητή',registryStatus:'εγγραφή σε μητρώο, όπου απαιτείται',registryNumber:'αριθμός ΓΕΜΗ',websiteUrl:'διεύθυνση ιστοτόπου',contactPhone:'τηλέφωνο επικοινωνίας',pricesTaxMode:'παρουσίαση τιμών και ΦΠΑ',pricesTaxDetails:'φορολογική μεταχείριση τιμών',contractFormation:'στάδιο σύναψης της αγοράς',contractFormationDetails:'διαδικασία σύναψης της αγοράς',orderAcknowledgementDetails:'επιβεβαίωση παραλαβής παραγγελίας',paymentAvailabilityDetails:'πραγματικά ενεργές πληρωμές',deliveryDeadlineDetails:'χρόνοι και διαδικασία παράδοσης',providerRoles:'πάροχοι και ρόλοι επεξεργασίας δεδομένων',transferSafeguards:'εγγυήσεις διεθνών διαβιβάσεων',enhancedServices:'ενισχυμένες υπηρεσίες Shopify',enhancedServicesDetails:'ρυθμίσεις ενισχυμένων υπηρεσιών Shopify',automatedDecisions:'αυτοματοποιημένες αποφάσεις',automatedDecisionDetails:'στοιχεία αυτοματοποιημένων αποφάσεων',privacyPurposesAndBases:'σκοποί και νομικές βάσεις επεξεργασίας'};
  return item.message??`Συμπλήρωση ή διευκρίνιση: ${publicationLabels[field.split('.').at(-1)]??labels[field.split('.').at(-1)]??area}.`;
}
Object.assign(errors,{CONTENT_NOT_AVAILABLE:'Τα νέα βήματα είναι διαθέσιμα στις νέες δοκιμαστικές παραγγελίες.',CONTENT_REVIEW_ACK_REQUIRED:'Επιβεβαίωσε ότι έλεγξες τη συγκεκριμένη εκδοχή.',CONTENT_REVIEW_STALE:'Τα κείμενα άλλαξαν. Άνοιξε ξανά την προεπισκόπηση και έλεγξε τη νέα εκδοχή.',CONTENT_REVIEW_INCOMPLETE:'Ολοκλήρωσε τα σχετικά βήματα και τις εκκρεμότητες πριν καταγράψεις τον έλεγχό σου.'});
Object.assign(errors,{RETURNS_INCOMPLETE:'Συμπλήρωσε τις επιλογές επιστροφών και τα σχετικά στοιχεία πριν από την οριστική υποβολή.',RETURNS_REVIEW_REQUIRED:'Η διαφορετική σου επιλογή χρειάζεται αξιολόγηση. Αποθήκευσέ την και συνέχισε στα υπόλοιπα βήματα.',RETURNS_CHARACTERISTICS_REVIEW_REQUIRED:'Αυτά τα χαρακτηριστικά προϊόντων χρειάζονται ειδικό έλεγχο. Δεν εφαρμόζουμε αυτόματα εξαίρεση επιστροφής. Αποθήκευσε το βήμα για αξιολόγηση.',RETURNS_INVALID_DAYS:'Συμπλήρωσε έναν ακέραιο αριθμό ημερών από 1 έως 3650.',POLICY_INCOMPLETE:'Συμπλήρωσε τις πραγματικές πρακτικές δεδομένων και τις σχετικές διευκρινίσεις.',POLICY_REVIEW_REQUIRED:'Η άγνωστη ή διαφορετική πρακτική χρειάζεται διευκρίνιση. Μπορείς να την αποθηκεύσεις και να επιστρέψεις αργότερα.',POLICY_CONSENT_REVIEW_REQUIRED:'Χρειάζεται να διευκρινιστεί η ρύθμιση συγκατάθεσης για τις πρακτικές που δήλωσες. Αποθήκευσε το βήμα προς έλεγχο.',PAGES_INCOMPLETE:'Συμπλήρωσε και την ερώτηση και την απάντηση σε κάθε πρόσθετο FAQ ή αφαίρεσε το κενό ζεύγος.'});
async function command(value,advance=false){if(busy)return;busy=true;const controls=[...document.querySelectorAll('#card button,#card input,#card textarea,#card select,#confirm button')].map(node=>({node,disabled:node.disabled}));controls.forEach(({node})=>node.disabled=true);let focusField;try{const data=await api('/api/task',value);workspace=data.workspace;dirty=false;if(advance)next();render();notice(value.action==='submit'?'Υποβλήθηκε. Κρατήσαμε οριστικά τα στοιχεία σου στην ουρά παραγωγής.':value.action==='save'?'Αποθηκεύτηκε. Μπορείς να αλλάξεις την απάντηση αργότερα.':value.action==='skip'?'Κρατήσαμε όσα συμπλήρωσες. Το βήμα παραμένει στις εκκρεμότητες.':'Η έγκριση καταγράφηκε.');}catch(error){notice(error.message);focusField=error.field;}finally{busy=false;controls.forEach(({node,disabled})=>{if(node.isConnected)node.disabled=disabled;});if(focusField)($(`field-${focusField}`)??document.querySelector(`#group-${focusField} input`))?.focus();}}
errors.PHOTO_REVIEW_REQUIRED='Πριν την οριστική υποβολή χρειάζεται να ολοκληρωθεί ο έλεγχος των φωτογραφιών αυτού του προϊόντος. Στην τοπική δοκιμή ο χειριστής συνδέει το αποτέλεσμα του πραγματικού AI ελέγχου.';
errors.INVALID_PHOTO_TYPE='Επίλεξε πραγματικό αρχείο PNG, JPEG ή WebP.';
errors.INVALID_PHOTO='Έλεγξε το αρχείο της φωτογραφίας πριν το ανεβάσεις.';
errors.PHOTO_TOO_LARGE='Η φωτογραφία ξεπερνά το όριο της τοπικής δοκιμής.';
errors.INVALID_PHOTOS='Έλεγξε τον αριθμό και τις φωτογραφίες αυτού του προϊόντος.';
errors.PHOTO_STORAGE_LIMIT='Συμπληρώθηκε ο διαθέσιμος χώρος φωτογραφιών της τοπικής δοκιμής.';
errors.PRODUCT_LIMIT='Έφτασες τον αριθμό προϊόντων του πακέτου σου.';
errors.PHOTO_REVIEW_STALE='Οι φωτογραφίες άλλαξαν. Ζήτησε έλεγχο της νέας επιλογής πριν συνεχίσεις.';
errors.TEXT_VARIANT_LIMIT='Έχεις τις πέντε AI εκδοχές αυτού του πεδίου. Διάλεξε όποια προτιμάς ή κράτησε το δικό σου κείμενο.';
errors.TEXT_PROJECT_LIMIT='Συμπληρώθηκαν οι διαθέσιμες δημιουργίες κειμένων του πακέτου.';
errors.TEXT_REQUEST_STALE='Τα αρχικά στοιχεία άλλαξαν. Η παλιά εκδοχή παραμένει στο ιστορικό και χρειάζεται έλεγχο πριν χρησιμοποιηθεί.';
errors.TEXT_OPT_IN_REQUIRED='Ενεργοποίησε τη βελτίωση AI γι’ αυτό το πεδίο πριν ζητήσεις νέα εκδοχή.';
errors.TEXT_REVIEW_REQUIRED='Υπάρχει αίτημα κειμένου σε αναμονή ή για έλεγχο. Το αποτέλεσμά του θα συνδεθεί στο συγκεκριμένο αίτημα από τον χειριστή της δοκιμής.';
errors.TEXT_SELECTION_REQUIRED='Διάλεξε ποια εκδοχή τίτλου ή περιγραφής θέλεις να κρατήσουμε. Μπορείς να επιλέξεις και το δικό σου αρχικό κείμενο.';
errors.PRODUCT_LOCKED='Αυτό το προϊόν έχει υποβληθεί οριστικά. Τα υπόλοιπα παραμένουν διαθέσιμα για αλλαγές.';
errors.PRODUCT_SUBMISSION_REQUIRED='Υπέβαλε κάθε προϊόν από το δικό του κουμπί οριστικής υποβολής.';
function fileBase64(file){return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result.split(',')[1]);reader.onerror=()=>reject(new Error('Η ανάγνωση της φωτογραφίας δεν ολοκληρώθηκε.'));reader.readAsDataURL(file);});}
async function productAction(action,productId,payload){
  if(action==='productSubmit'){
    if(busy)return;const product=formAnswers().products.find(item=>item.id===productId);
    pending={kind:'product',product,revision:workspace.productTasks[productId]?.revision??0};
    $('confirm-title').textContent='Οριστική υποβολή αυτού του προϊόντος;';
    $('confirm-message').textContent='Έτοιμο να πάρει τη θέση του στο κατάστημά σου; Με την επιβεβαίωση ξεκινάμε την επεξεργασία αυτού του προϊόντος και τα στοιχεία του κλειδώνουν.';
    $('confirm').showModal();return;
  }
  if(busy)return;busy=true;const controls=[...document.querySelectorAll('#card button,#card input,#card textarea,#card select')].map(node=>({node,disabled:node.disabled}));controls.forEach(({node})=>node.disabled=true);
  let answers=formAnswers();
  const save=async()=>{const task=workspace.tasks.find(task=>task.id==='catalog');workspace=(await api('/api/task',{action:'save',taskId:'catalog',revision:task.revision,answers})).workspace;dirty=false;};
  try{
    if(['productSave','productSkip','productFinal'].includes(action)){
      const product=payload?.product??answers.products.find(item=>item.id===productId),revision=payload?.revision??workspace.productTasks[productId]?.revision??0;
      const response=await api('/api/product',{action:action==='productFinal'?'submit':action==='productSkip'?'skip':'save',product,revision,...(action==='productFinal'?{acknowledged:true}:{})});
      workspace=response.workspace;
      const saved=workspace.tasks.find(task=>task.id==='catalog'),serverProducts=saved.draft.products;
      const merged=answers.products.map(item=>item.id===productId?serverProducts.find(item=>item.id===productId):item);
      dirty=JSON.stringify(merged)!==JSON.stringify(serverProducts);saved.draft.products=merged;
      notice(action==='productFinal'?'Το προϊόν υποβλήθηκε. Τα υπόλοιπα παραμένουν διαθέσιμα.':action==='productSkip'?'Το προϊόν έμεινε στις εκκρεμότητες. Κρατήσαμε όσα συμπλήρωσες.':'Το προϊόν αποθηκεύτηκε. Μπορείς να επιστρέψεις και να το αλλάξεις.');
      render();return;
    }
    await save();
    if(action==='upload'){
      const product=answers.products.find(item=>item.id===productId);
        const photoLimit=product.visualUnits?(workspace.materials.technicalLimits?.photosPerProduct??workspace.materials.limits.maxPhotos):workspace.materials.limits.maxPhotos;
        if(product.photos.length+payload.length>photoLimit)throw new Error(errors.INVALID_PHOTOS);
      for(const file of payload){
        if(file.size>workspace.materials.limits.maxFileBytes)throw new Error(errors.PHOTO_TOO_LARGE);
        notice(`Ανεβαίνει η φωτογραφία «${file.name}»…`);
        const response=await api('/api/photo-upload',{productId,name:file.name,mime:file.type,data:await fileBase64(file)});workspace=response.workspace;
        if(!product.photos.includes(response.receipt.assetId))product.photos.push(response.receipt.assetId);
        await save();
      }
      notice('Οι φωτογραφίες αποθηκεύτηκαν αποκλειστικά σε αυτό το προϊόν.');
    }else if(['textRequest','textSelect'].includes(action)){
      const response=await api('/api/product-text',{action:action==='textRequest'?'request':'select',productId,...payload});workspace=response.workspace;
      notice(action==='textRequest'?'Το αίτημα νέας εκδοχής αποθηκεύτηκε για επεξεργασία στη δοκιμή Pro.':'Η επιλογή σου αποθηκεύτηκε, χωρίς νέα δημιουργία κειμένου.');
    }else{
      const response=await api('/api/photo-review',{action,productId,...(payload?.visualUnitId?{visualUnitId:payload.visualUnitId}:{}),...(action==='confirm'?{reviewId:payload.id,fingerprint:payload.fingerprint,acknowledged:true}:{})});workspace=response.workspace;
      notice(action==='confirm'?'Η επιβεβαίωσή σου καταγράφηκε.':'Το αίτημα ελέγχου αποθηκεύτηκε για επεξεργασία στη δοκιμή Pro.');
    }
    render();
  }catch(error){notice(error.message);if(!dirty)render();}
  finally{busy=false;controls.forEach(({node,disabled})=>{if(node.isConnected)node.disabled=disabled;});}
}
$('start').addEventListener('click',async()=>{if(busy)return;busy=true;$('start').disabled=true;try{workspace=await api('/api/demo-order',{});render();}catch(error){notice(error.message);}finally{busy=false;$('start').disabled=false;}});
Object.assign(errors,{SERVICE_ACCESS_INVALID:'Το κλειδί δεν είναι έγκυρο ή έχει λήξει. Έλεγξέ το πριν συνεχίσεις.',PAYMENT_ADAPTER_UNAVAILABLE:'Η σύνδεση πληρωμής υπηρεσίας δεν είναι ενεργή σε αυτή τη δοκιμή.',DEMO_ORDER_DISABLED:'Αυτή η δοκιμή ανοίγει το onboarding μόνο μετά τον έλεγχο πληρωμής.'});
$('service-open').addEventListener('click',async()=>{if(busy)return;busy=true;try{const result=await api('/api/service-intent',{packageId:'basic'});workspace=result.workspace;$('service-access-key').value=result.accessKey;render();notice('Το προσωπικό κλειδί δημιουργήθηκε. Κράτησέ το ιδιωτικά για επιστροφή στο ίδιο έργο.');}catch(error){notice(error.message);}finally{busy=false;}});
$('service-access-form').addEventListener('submit',async event=>{event.preventDefault();if(busy)return;busy=true;try{const accessKey=$('service-access-key').value;workspace=await api('/api/service-access',{accessKey});$('service-access-key').value='';render();notice('Επέστρεψες στο ίδιο έργο.');}catch(error){notice(error.message);}finally{busy=false;}});
$('service-checkout').addEventListener('click',async()=>{if(busy)return;busy=true;try{
  const checkout=await api('/api/service-checkout',{}),link=element('a','Άνοιξε την αγορά στο Shopify →',{href:checkout.url,target:'_blank',rel:'noopener noreferrer',referrerpolicy:'no-referrer'});
  $('service-checkout-link').replaceChildren(link);$('service-checkout-link').hidden=false;
}catch(error){$('service-checkout-link').replaceChildren();$('service-checkout-link').hidden=true;notice(error.message);}finally{busy=false;}});
$('cancel-confirm').addEventListener('click',()=>{$('confirm').close();pending=null;});
$('close-viewer').addEventListener('click',()=>{$('photo-viewer').close();});
errors.GALLERY_CONFLICT='Υπάρχει νεότερη επιλογή φωτογραφιών. Ανανέωσε πριν συνεχίσεις.';
errors.GALLERY_STALE='Τα στοιχεία παραγωγής άλλαξαν. Χρειάζεται έλεγχος πριν αλλάξει η επιλογή.';
errors.PHOTO_CHANGE_REQUIRED='Περιέγραψε τη συγκεκριμένη αλλαγή που θέλεις πριν ζητήσεις νέα εκδοχή.';
errors.PHOTO_REGENERATION_LIMIT='Χρησιμοποίησες τις τρεις διαθέσιμες αναδημιουργίες αυτής της φωτογραφίας. Μπορείς να επιλέξεις οποιαδήποτε υπάρχουσα εκδοχή.';
errors.PHOTO_REGENERATION_PAUSED='Η δημιουργία έχει προσωρινά σταματήσει για τεχνικό έλεγχο. Οι διαθέσιμες εκδοχές παραμένουν εδώ.';
errors.PHOTO_REGENERATION_PENDING='Υπάρχει ήδη αίτημα για αυτή τη φωτογραφία σε εξέλιξη. Οι προηγούμενες εκδοχές παραμένουν διαθέσιμες.';
errors.PHOTO_REPLACEMENT_UNAVAILABLE='Αυτό το δικαίωμα αποκατάστασης έχει ήδη χρησιμοποιηθεί ή δεσμευτεί. Ανανέωσε για να δεις την τρέχουσα κατάσταση.';
errors.PHOTO_CLAIM_DESCRIPTION_REQUIRED='Περιέγραψε τη διαφορά που εντοπίζεις στο ίδιο το προϊόν.';
errors.INVALID_PHOTO_CLAIM='Συμπλήρωσε μια σύντομη περιγραφή της διαφοράς, έως 2.000 χαρακτήρες.';
errors.PHOTO_CLAIM_REQUEST_CONFLICT='Υπάρχει ήδη διαφορετική καταχώριση για αυτό το αίτημα. Ανανέωσε για να δεις την αναφορά σου.';
errors.PHOTO_CLAIM_EVIDENCE_CHANGED='Τα στοιχεία της εικόνας άλλαξαν. Ανανέωσε και επίλεξε ξανά την εικόνα που αφορά η αναφορά.';
errors.PHOTO_CLAIM_NOT_FOUND='Η αναφορά δεν βρέθηκε σε αυτό το έργο. Ανανέωσε πριν συνεχίσεις.';
errors.PHOTO_CLAIM_ESCALATION_NOT_AVAILABLE='Η αναφορά δεν είναι διαθέσιμη για επανεξέταση αυτή τη στιγμή.';
for(const code of ['PHOTO_CLAIM_ASSET_NOT_OWNED','PHOTO_CLAIM_ASSET_INVALID','PHOTO_CLAIM_SOURCE_MISSING','PHOTO_CLAIM_SOURCE_CHANGED'])errors[code]='Δεν μπορέσαμε να συνδέσουμε αυτή την εικόνα με τα αρχικά στοιχεία του προϊόντος. Η αναφορά δεν καταχωρίστηκε· χρειάζεται τεχνικός έλεγχος.';
async function galleryAction(productId,value){
  if(busy)return;busy=true;
  const drafts=formAnswers(),wasDirty=dirty,controls=[...document.querySelectorAll('#card button,#card input,#card textarea,#card select')].map(node=>({node,disabled:node.disabled}));controls.forEach(({node})=>node.disabled=true);
  try{
    const response=await api('/api/product-gallery',{productId,...value});workspace=response.workspace;
    workspace.tasks.find(task=>task.id==='catalog').draft=drafts;dirty=wasDirty;render();
    notice(['request','replacement'].includes(value.action)?'Το αίτημα αποθηκεύτηκε. Η πραγματική δημιουργία AI παραμένει προς σύνδεση.':value.action==='layout'?'Η σειρά και η κύρια φωτογραφία αποθηκεύτηκαν.':'Η εκδοχή που επέλεξες αποθηκεύτηκε.');
  }catch(error){notice(error.message);}finally{busy=false;controls.forEach(({node,disabled})=>{if(node.isConnected)node.disabled=disabled;});}
}
async function photoClaimAction(value){
  if(busy)return false;busy=true;
  const drafts=formAnswers(),wasDirty=dirty,controls=[...document.querySelectorAll('#card button,#card input,#card textarea,#card select')].map(node=>({node,disabled:node.disabled}));controls.forEach(({node})=>node.disabled=true);
  try{
    const response=await api('/api/photo-claims',value);workspace=response.workspace;
    workspace.tasks.find(task=>task.id==='catalog').draft=drafts;dirty=wasDirty;render();
    const claim=workspace.photoClaims.find(item=>item.id===response.receipt.id),automatic=['queued','running'].includes(claim?.reviewQueue?.status);
    notice(value.action==='escalate'?'Το αίτημα επανεξέτασης αποθηκεύτηκε τοπικά. Η ομάδα εξυπηρέτησης δεν έχει ακόμη συνδεθεί.':automatic?'Η αναφορά μπήκε στην ουρά αυτόματου ελέγχου. Η απόφαση και τυχόν επιστροφή credits θα εμφανιστούν εδώ.':'Η αναφορά αποθηκεύτηκε. Δες την κατάσταση ελέγχου δίπλα στην εικόνα.');return true;
  }catch(error){notice(error.message);return false;}finally{busy=false;controls.forEach(({node,disabled})=>{if(node.isConnected)node.disabled=disabled;});}
}
$('submit-confirm').addEventListener('click',()=>{const value=pending;$('confirm').close();pending=null;if(value?.kind==='product')productAction('productFinal',value.product.id,value);else if(value)command({...value,acknowledged:true});});
async function refresh(){if(busy)return;const previousId=workspace?.id;try{const state=await api('/api/workspace');if(busy||workspace?.id!==previousId)return;if(backupRecoveryPending&&!backupReadOnly){const config=await api('/api/service-config');globalThis.MolyviBasicPreparation?.configure({enabled:config.basicPreparationEnabled,api,context:()=>workspace});if(config.customerAccess)customerCsrf=(await api('/api/customer/me')).csrfToken;backupRecoveryPending=false;}if(backupReadOnly&&dirty){applyBackupReadOnly();return;}if(state.servicePayment?.status==='pending'||workspace?.servicePayment?.status==='pending'){workspace=state;render();return;}const oldPreviewKey=contentPreviewKey(workspace,current),old=workspace?.tasks.find(task=>task.id===current),oldTexts=JSON.stringify(workspace?.productTexts),oldProducts=JSON.stringify(workspace?.productTasks),oldGalleries=JSON.stringify(workspace?.productGalleries),oldClaims=JSON.stringify(workspace?.photoClaims);workspace=state;renderWallet();renderServiceOffer();if(!backupReadOnly)void globalThis.MolyviBasicPreparation?.refresh(workspace.id);if(!old){render();return;}renderNavigation();const updated=workspace.tasks.find(task=>task.id===current);if(!dirty && !$('confirm').open && !$('photo-viewer').open && (oldPreviewKey!==contentPreviewKey(workspace,current)||JSON.stringify(old)!==JSON.stringify(updated)||current==='catalog'&&(oldTexts!==JSON.stringify(state.productTexts)||oldProducts!==JSON.stringify(state.productTasks)||oldGalleries!==JSON.stringify(state.productGalleries)||oldClaims!==JSON.stringify(state.photoClaims))))render({preserveContentPreview:true});applyBackupReadOnly();}catch(error){if(error.code!=='SESSION_REQUIRED')notice(error.message);}}
async function initialize(){try{const config=await api('/api/service-config');globalThis.MolyviBasicPreparation?.configure({enabled:config.basicPreparationEnabled,api,context:()=>workspace});$('start').hidden=!config.allowDemoOrders;$('demo-note').hidden=!config.allowDemoOrders;$('service-payment').hidden=!config.servicePayments;if(config.deploymentMode==='hosted_staging'){$('environment-label').textContent='Δοκιμαστικό έργο';$('environment-note').textContent='Ο ιδιωτικός χώρος της δοκιμής σου. Τα υποβλημένα βήματα και τα αποτελέσματά τους διατηρούνται στο ίδιο έργο. Η επεξεργασία AI ενεργοποιείται ελεγχόμενα από την ομάδα Molyvi.';}if(config.customerAccess){try{customerCsrf=(await api('/api/customer/me')).csrfToken;$('customer-home').hidden=false;}catch(error){if(error.code==='SESSION_REQUIRED'){location.assign('/customer/');return;}throw error;}}if(config.servicePayments?.checkoutConfigured)$('service-checkout-note').textContent='Δοκιμαστική αγορά στο εξουσιοδοτημένο development store, χωρίς πραγματική χρέωση. Η παραγωγική είσπραξη και η φορολογική της ρύθμιση παραμένουν προς ενεργοποίηση.';}catch(error){if(backupPausedErrors.has(error.code))notice(error.message);}await refresh();}
initialize();setInterval(refresh,1000);
