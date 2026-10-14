'use strict';
window.MolyviMerchantPayments=(()=>{
  const make=(tag,text,attrs={})=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;for(const [key,value] of Object.entries(attrs))node.setAttribute(key,value);return node;};
  const businessTypes={individual_or_sole_proprietor:'Ιδιώτης / ατομική επιχείρηση',company:'ΑΕ / ΙΚΕ / ΕΠΕ',partnership:'ΟΕ / ΕΕ',other:'Άλλο'};
  const onlineTypes={shopify_payments:'Shopify Payments',manual_only:'Μόνο τραπεζική κατάθεση ή αντικαταβολή',other:'Άλλος τρόπος πληρωμής'};
  const manualTypes={bank_deposit:'Τραπεζική κατάθεση',cash_on_delivery:'Αντικαταβολή'};
  const additionalTypes={klarna:'Klarna',other:'Άλλη μέθοδος'};
  const merchantBlank=()=>({schemaVersion:1,country:null,countryOther:'',businessType:null,businessTypeOther:'',sellerName:'',contactEmail:'',contactPhone:'',address:{line1:'',line2:'',city:'',postalCode:''}});
  const paymentsBlank=()=>({schemaVersion:1,online:null,manualMethods:[],additionalMethods:[],other:'',activationAcknowledged:false});
  const field=(label,input,help)=>{const node=make('label',undefined,{class:'field'});node.append(make('span',label),input);if(help)node.append(make('span',help,{class:'field-help'}));return node;};
  function select(options,value,label){const node=make('select',undefined,{'aria-label':label});node.append(make('option','Επίλεξε…',{value:''}));for(const [key,text] of Object.entries(options))node.append(make('option',text,{value:key}));if(value&&!Object.hasOwn(options,value))node.append(make('option',`${value} — προς έλεγχο`,{value}));node.value=value??'';return node;}
  function check(text,checked,label=text){const node=make('label',undefined,{class:'merchant-check'}),input=make('input',undefined,{type:'checkbox','aria-label':label});input.checked=checked;node.append(input,make('span',text));return {node,input};}
  const blank=value=>!String(value??'').trim();
  function merchantSummary(value){
    if(!value)return ['Τα στοιχεία του πωλητή δεν έχουν συμπληρωθεί.'];
    const country=value.country==='GR'?'Ελλάδα':value.country==='other'?`${value.countryOther||'Άλλη χώρα'} — προς αξιολόγηση`:'χώρα προς επιλογή';
    const type=value.businessType==='other'?`${value.businessTypeOther||'Άλλη μορφή'} — προς αξιολόγηση`:businessTypes[value.businessType]??'μορφή προς επιλογή';
    const address=value.address??{},lines=[`Πωλητής: ${value.sellerName||'προς συμπλήρωση'}.`,`Χώρα: ${country}.`,`Μορφή: ${type}.`];
    lines.push(`Διεύθυνση για το κατάστημα: ${[address.line1,address.line2,address.city,address.postalCode].filter(Boolean).join(', ')||'προς συμπλήρωση'}.`);
    lines.push(`Email επικοινωνίας: ${value.contactEmail||'προς συμπλήρωση'}.`);
    if(value.contactPhone)lines.push(`Τηλέφωνο επικοινωνίας: ${value.contactPhone}.`);
    lines.push('Τα στοιχεία δηλώθηκαν από εσένα. Η επιλεξιμότητα και η ενεργοποίηση πληρωμών ελέγχονται στο Shopify.');
    return lines;
  }
  function paymentsSummary(value){
    if(!value)return ['Δεν έχουν επιλεγεί προτιμήσεις πληρωμών.'];
    const lines=[`Επιλογή πληρωμών: ${onlineTypes[value.online]??'προς επιλογή'}.`];
    for(const method of value.manualMethods??[])lines.push(`Ζητήθηκε ${manualTypes[method]??method}· η ενεργοποίηση και η επιβεβαίωση είσπραξης γίνονται από εσένα.`);
    for(const method of value.additionalMethods??[])lines.push(`Ζητήθηκε ${additionalTypes[method]??method}· απαιτείται έλεγχος διαθεσιμότητας και ενεργοποίηση στο Shopify.`);
    if(value.other&&(value.online==='other'||value.additionalMethods?.includes('other')))lines.push(`Αίτημα προς αξιολόγηση: ${value.other}`);
    lines.push(value.activationAcknowledged?'Επιβεβαίωσες ότι θα ολοκληρώσεις την ενεργοποίηση στο Shopify μετά την παράδοση.':'Η ενημέρωση για την ενεργοποίηση πληρωμών μένει να επιβεβαιωθεί.');
    lines.push('Οι παραπάνω επιλογές δεν έχουν ενεργοποιήσει μεθόδους πληρωμής.');
    return lines;
  }
  function renderMerchant(value,{changed=()=>{}}={}){
    const data=Object.assign(merchantBlank(),structuredClone(value??{}));data.address={...merchantBlank().address,...data.address};
    const root=make('div',undefined,{class:'merchant-editor'}),warning=make('p',undefined,{class:'merchant-notice','aria-live':'polite'});
    root.append(make('p','Τα στοιχεία πίσω από το κατάστημά σου. Θα τα χρησιμοποιήσουμε όπου χρειάζονται για την ταυτότητα και την επικοινωνία του e-shop.',{class:'field-help'}));
    root.append(make('p','Συμπλήρωσε τα στοιχεία που προορίζονται για το κατάστημα και τις σελίδες του. Δεν αντιγράφουμε στοιχεία από τον λογαριασμό ή την απόδειξη αγοράς σου.',{class:'merchant-notice'}));
    function textInput(label,target,key,help,{type='text',max=240,autocomplete='off'}={}){
      const input=make('input',undefined,{type,maxlength:String(max),autocomplete,'aria-label':label});input.value=target[key]??'';input.addEventListener('input',()=>{target[key]=input.value;changed();});return field(label,input,help);
    }
    const country=select({GR:'Ελλάδα',other:'Άλλη χώρα'},data.country,'Χώρα έδρας'),countryOther=textInput('Ποια είναι η χώρα έδρας;',data,'countryOther','Γράψε τη χώρα για να ελέγξουμε αν καλύπτεται η ανάγκη σου. Η αρχική υπηρεσία αφορά την Ελλάδα.',{max:120});
    const type=select(businessTypes,data.businessType,'Μορφή δραστηριότητας'),typeOther=textInput('Περιέγραψε τη μορφή δραστηριότητας',data,'businessTypeOther','Μια σαφής περιγραφή μάς βοηθά να δώσουμε τη σωστή καθοδήγηση.',{max:240});
    const identity=make('div',undefined,{class:'merchant-grid'});identity.append(field('Χώρα έδρας',country,'Η πραγματική χώρα έδρας καθορίζει τις προϋποθέσεις του Shopify Payments.'),field('Μορφή δραστηριότητας',type,'Διάλεξε αυτό που ισχύει για εσένα. Το Shopify θα ελέγξει τα απαιτούμενα στοιχεία κατά την ενεργοποίηση.'));
    root.append(identity,countryOther,typeOther,warning,textInput('Επωνυμία ή ονοματεπώνυμο πωλητή',data,'sellerName','Η ταυτότητα του πωλητή, όπως θέλεις να αποτυπωθεί στα στοιχεία του καταστήματος.',{max:200}));
    const address=make('fieldset',undefined,{class:'merchant-section'});address.append(make('legend','Η διεύθυνση του πωλητή'),make('p','Χρησιμοποιείται για τα στοιχεία του καταστήματος στο Shopify. Η αποθήκευση εδώ δεν τη δημοσιεύει αυτόματα και δεν ορίζει σημείο παραλαβής ή διεύθυνση επιστροφών.',{class:'field-help'}));
    address.append(textInput('Οδός και αριθμός',data.address,'line1','Δώσε την πλήρη διεύθυνση που αντιστοιχεί στον πωλητή.'),textInput('Πρόσθετα στοιχεία διεύθυνσης — προαιρετικό',data.address,'line2','Όροφος, κτίριο ή άλλη λεπτομέρεια που κάνει τη διεύθυνση πιο σαφή.'));
    const addressRow=make('div',undefined,{class:'merchant-grid'});addressRow.append(textInput('Πόλη',data.address,'city','Συμπλήρωσε την πόλη της δηλωμένης διεύθυνσης.',{max:120}),textInput('Ταχυδρομικός κώδικας',data.address,'postalCode','Συμπλήρωσε τον ταχυδρομικό κώδικα της δηλωμένης διεύθυνσης.',{max:32}));address.append(addressRow);root.append(address);
    const contact=make('fieldset',undefined,{class:'merchant-section'});contact.append(make('legend','Επικοινωνία με τους πελάτες σου'),textInput('Email επικοινωνίας του καταστήματος',data,'contactEmail','Αυτό το email προορίζεται για την επικοινωνία των πελατών με το κατάστημά σου.',{type:'email',max:254}),textInput('Τηλέφωνο επικοινωνίας — προαιρετικό',data,'contactPhone','Πρόσθεσέ το αν θέλεις να το χρησιμοποιούν οι πελάτες σου.',{type:'tel',max:60}));root.append(contact);
    root.append(make('p','Στοιχεία ταυτότητας, τραπεζικού λογαριασμού και έγγραφα επαλήθευσης θα δοθούν απευθείας στο Shopify, όταν ενεργοποιήσεις τις πληρωμές.',{class:'field-help'}));
    function refresh(){countryOther.hidden=data.country!=='other';typeOther.hidden=data.businessType!=='other';warning.hidden=data.country!=='other'&&data.businessType!=='other';warning.textContent='Μπορείς να αποθηκεύσεις την απάντησή σου. Αυτή η επιλογή χρειάζεται αξιολόγηση πριν από την οριστική υποβολή.';}
    country.addEventListener('change',()=>{data.country=country.value||null;refresh();changed();});type.addEventListener('change',()=>{data.businessType=type.value||null;refresh();changed();});refresh();
    return {node:root,read:({complete=false}={})=>{
      if(complete&&(!data.country||!data.businessType||[data.sellerName,data.contactEmail,data.address.line1,data.address.city,data.address.postalCode].some(blank)))throw new Error('Συμπλήρωσε τη χώρα, τη μορφή δραστηριότητας, την ταυτότητα και τα βασικά στοιχεία επικοινωνίας του πωλητή πριν από την οριστική υποβολή.');
      if(complete&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.contactEmail.trim()))throw Object.assign(new Error('Έλεγξε το email επικοινωνίας του καταστήματος.'),{code:'MERCHANT_INVALID_EMAIL',field:'contactEmail'});
      return structuredClone(data);
    }};
  }
  function renderPayments(value,{merchant=null,shippingPlan=null,changed=()=>{},guidance=null}={}){
    const data=Object.assign(paymentsBlank(),structuredClone(value??{}));data.manualMethods??=[];data.additionalMethods??=[];
    const root=make('div',undefined,{class:'merchant-editor payment-editor'}),online=select(onlineTypes,data.online,'Πώς θέλεις να δέχεσαι πληρωμές;'),onlineInfo=make('div',undefined,{class:'merchant-notice payment-online-info','aria-live':'polite'}),review=make('p',undefined,{class:'merchant-notice','aria-live':'polite'});
    root.append(make('p','Μια ξεκάθαρη επιλογή σήμερα. Έτοιμη καθοδήγηση για την ενεργοποίηση μετά την παράδοση.',{class:'field-help'}),field('Πώς θέλεις να δέχεσαι πληρωμές;',online,'Επίλεξε τον τρόπο που ταιριάζει στο κατάστημά σου. Οι επιλογές εδώ προετοιμάζουν τη ρύθμιση.'),onlineInfo);
    const extras=make('fieldset',undefined,{class:'merchant-section payment-additional'});extras.append(make('legend','Πρόσθετες προτιμήσεις'),make('p','Διάλεξε ό,τι σε ενδιαφέρει. Η διαθεσιμότητα εξαρτάται από τον λογαριασμό σου, τη χώρα του αγοραστή, το νόμισμα και τις προϋποθέσεις κάθε μεθόδου.',{class:'field-help'}));
    function arrayCheck(label,key,id,help){const item=check(label,data[key].includes(id)),box=make('div',undefined,{class:'merchant-choice-help'});box.append(item.node);if(help)box.append(make('p',help,{class:'field-help'}));item.input.addEventListener('change',()=>{data[key]=item.input.checked?[...new Set([...data[key],id])]:data[key].filter(value=>value!==id);refresh();changed();});return {box,input:item.input};}
    const klarna=arrayCheck('Με ενδιαφέρει το Klarna','additionalMethods','klarna','Θα ελέγξεις τη διαθεσιμότητα στο Shopify. Η επιλογή αυτή δεν εγγυάται έγκριση ή εμφάνιση στο checkout.'),otherMethod=arrayCheck('Με ενδιαφέρει άλλη μέθοδος','additionalMethods','other');extras.append(klarna.box,otherMethod.box);root.append(extras);
    const manuals=make('fieldset',undefined,{class:'merchant-section'});manuals.append(make('legend','Τραπεζική κατάθεση και αντικαταβολή'),make('p','Προαιρετικές επιλογές και στα δύο πακέτα. Θα λάβεις οδηγίες για να τις ενεργοποιήσεις και να διαχειρίζεσαι τις εισπράξεις σου.',{class:'field-help'}));
    for(const [key,label] of Object.entries(manualTypes))manuals.append(arrayCheck(`Θέλω ${label.toLocaleLowerCase('el-GR')}`,'manualMethods',key).box);
    manuals.append(make('p','Τα τραπεζικά στοιχεία και οι οδηγίες πληρωμής συμπληρώνονται απευθείας στο Shopify. Η παραγγελία με κατάθεση ή αντικαταβολή δεν επιβεβαιώνει αυτόματα την είσπραξη.',{class:'field-help'}));root.append(manuals);
    const other=make('textarea',undefined,{maxlength:'4000','aria-label':'Περιέγραψε τη μέθοδο πληρωμής που χρειάζεσαι'});other.value=data.other??'';other.addEventListener('input',()=>{data.other=other.value;changed();});const otherField=field('Περιέγραψε τη μέθοδο πληρωμής που χρειάζεσαι',other,'Πες μας ποια μέθοδο σε ενδιαφέρει και για ποιους πελάτες. Θα αξιολογήσουμε το αίτημα πριν προχωρήσουμε. Μην προσθέσεις τραπεζικά στοιχεία ή κωδικούς.');root.append(otherField,review);
    const activation=make('fieldset',undefined,{class:'merchant-section payment-activation'});activation.append(make('legend','Το τελευταίο βήμα θα είναι δικό σου'),make('p','Μετά την παράδοση του καταστήματος, ολοκληρώνεις την ενεργοποίηση πληρωμών απευθείας στο Shopify, με τα δικά σου στοιχεία. Για το Shopify Payments ισχύουν οι προϋποθέσεις και ο έλεγχος του Shopify.',{class:'field-help'}),make('p','Η συμμόρφωση του καταστήματος με τους τοπικούς νόμους και κανονισμούς είναι ευθύνη του πελάτη και η Molyvi δεν παρέχει σχετικές συμβουλές.',{class:'field-help'}));
    const ack=check('Γνωρίζω ότι θα ολοκληρώσω την ενεργοποίηση πληρωμών στο Shopify μετά την παράδοση.',data.activationAcknowledged===true,'Επιβεβαίωση ενημέρωσης για την ενεργοποίηση πληρωμών');ack.input.addEventListener('change',()=>{data.activationAcknowledged=ack.input.checked;changed();});activation.append(ack.node);root.append(activation);
    function refresh(){
      const supported=merchant?.country==='GR',isShopify=data.online==='shopify_payments';extras.hidden=!isShopify;klarna.box.hidden=!supported;
      onlineInfo.hidden=!data.online;onlineInfo.replaceChildren();
      if(isShopify){
        onlineInfo.append(make('strong','Online πληρωμές με Shopify Payments'));
        if(supported&&guidance?.greece?.cardBrands?.length&&guidance?.greece?.acceleratedCheckouts?.length)onlineInfo.append(make('p',`Για έδρα στην Ελλάδα, το Shopify Payments υποστηρίζει κάρτες ${guidance.greece.cardBrands.join(', ')}, καθώς και ${guidance.greece.acceleratedCheckouts.join(', ')}, εφόσον πληρούνται οι αντίστοιχες προϋποθέσεις.`));
        else if(supported)onlineInfo.append(make('p','Οι διαθέσιμες κάρτες και τα ψηφιακά πορτοφόλια θα επιβεβαιωθούν στο Shopify κατά την ενεργοποίηση.'));
        else onlineInfo.append(make('p',merchant?.country==='other'?'Η χώρα έδρας χρειάζεται αξιολόγηση. Δεν έχει επιβεβαιωθεί ποιες μέθοδοι είναι διαθέσιμες για το κατάστημά σου.':'Συμπλήρωσε πρώτα τη χώρα έδρας στα στοιχεία πωλητή, ώστε να δεις τις σχετικές πληροφορίες πληρωμών.'));
        onlineInfo.append(make('p','Δεν χρειάζεται σύνδεση με άλλον πάροχο για τις υποστηριζόμενες online πληρωμές. Η ενεργοποίηση και ο έλεγχος του λογαριασμού γίνονται από εσένα στο Shopify μετά την παράδοση.'));
      }else if(data.online==='manual_only')onlineInfo.append(make('p','Διάλεξε τουλάχιστον μία από τις παρακάτω χειροκίνητες μεθόδους. Η επιβεβαίωση πραγματικής είσπραξης θα γίνεται από εσένα.'));
      else if(data.online==='other')onlineInfo.append(make('p','Αποθήκευσε τη μέθοδο που χρειάζεσαι για αξιολόγηση. Η επιλογή δεν εγκρίνει αυτόματα νέο πάροχο ή διασύνδεση.'));
      const hasOther=data.online==='other'||isShopify&&data.additionalMethods.includes('other');otherField.hidden=!hasOther;review.hidden=!hasOther;review.textContent='Το αίτημά σου θα παραμείνει αποθηκευμένο για αξιολόγηση πριν από την οριστική υποβολή.';
    }
    online.addEventListener('change',()=>{data.online=online.value||null;if(data.online!=='shopify_payments'){data.additionalMethods=[];klarna.input.checked=false;otherMethod.input.checked=false;}refresh();changed();});refresh();
    return {node:root,read:({complete=false}={})=>{
      if(complete&&!data.online)throw new Error('Διάλεξε τον τρόπο πληρωμών πριν από την οριστική υποβολή.');
      if(complete&&data.online==='manual_only'&&!data.manualMethods.length)throw new Error('Διάλεξε τραπεζική κατάθεση, αντικαταβολή ή και τις δύο για τις χειροκίνητες πληρωμές.');
      if(complete&&!data.activationAcknowledged)throw new Error('Επιβεβαίωσε ότι διάβασες την ενημέρωση για την ενεργοποίηση πληρωμών.');
      return structuredClone(data);
    }};
  }
  return {renderMerchant,renderPayments,merchantSummary,paymentsSummary};
})();
