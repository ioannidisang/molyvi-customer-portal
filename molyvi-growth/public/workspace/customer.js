'use strict';
let account=null,busy=false,codeRequests=false,realEmailEnabled=false;
const $=id=>document.getElementById(id);
const errors={INVALID_LOGIN:'Το email και ο κωδικός δεν ταιριάζουν ή ο κωδικός έχει ήδη χρησιμοποιηθεί. Χρησιμοποίησε έναν νέο κωδικό.',LOGIN_RATE_LIMIT:'Έγιναν αρκετές προσπάθειες. Περίμενε 15 λεπτά πριν δοκιμάσεις ξανά.',SESSION_REQUIRED:'Συνδέσου ξανά για να συνεχίσεις.',DELIVERY_VERSION_CHANGED:'Υπάρχει διαφορετική έκδοση του φακέλου. Ανανέωσε και έλεγξέ την πριν επιβεβαιώσεις.',DELIVERY_FILE_CHANGED:'Ο φάκελος χρειάζεται έλεγχο πριν συνεχίσεις.',CSRF_REQUIRED:'Ανανέωσε τη σελίδα πριν συνεχίσεις.'};
Object.assign(errors,{INVALID_FEEDBACK:'Διάλεξε θέμα και γράψε την παρατήρησή σου, έως 2.000 χαρακτήρες.',FEEDBACK_REQUEST_CONFLICT:'Το αίτημα έχει ήδη καταγραφεί με διαφορετικά στοιχεία. Άνοιξε ξανά τις παρατηρήσεις πριν συνεχίσεις.',FEEDBACK_RATE_LIMIT:'Έχεις καταγράψει αρκετές παρατηρήσεις την τελευταία ώρα. Δοκίμασε ξανά αργότερα.',FEEDBACK_STORAGE_LIMIT:'Ο χώρος παρατηρήσεων αυτής της έκδοσης έχει συμπληρωθεί. Επικοινώνησε με την υποστήριξη.'});
const feedbackCategories={appearance:'Εμφάνιση και δομή',photos:'Φωτογραφίες προϊόντων',text:'Τίτλοι και περιγραφές',seller:'Στοιχεία επιχείρησης',orders:'Αποστολές και πληρωμές',policies:'Πολιτικές και ενημερωτικές σελίδες',other:'Άλλο'};
const feedbackStatuses={received:'Καταγράφηκε',in_review:'Σε έλεγχο',needs_information:'Χρειάζεται διευκρίνιση',answered:'Απαντήθηκε'};
const dateLabel=value=>new Intl.DateTimeFormat('el-GR',{dateStyle:'medium',timeStyle:'short',timeZone:'Europe/Athens'}).format(new Date(value));
function node(tag,text,attrs={}){const n=document.createElement(tag);if(text!==undefined)n.textContent=text;for(const [k,v]of Object.entries(attrs))n.setAttribute(k,v);return n;}
function feedbackPanel(data,delivery){
  const box=node('div',undefined,{class:'delivery-status-panel delivery-feedback-panel'});
  box.append(node('h4','Οι παρατηρήσεις σου. Στη σωστή έκδοση.'),node('p','Πες μας ποιο σημείο θέλεις να ελέγξουμε και τι θα ήθελες να αλλάξει. Όσο πιο συγκεκριμένη η περιγραφή, τόσο πιο εύκολα θα καταλάβουμε την αλλαγή που έχεις στο μυαλό σου.'));
  const history=node('div',undefined,{'aria-live':'polite'});
  function showHistory(items){history.replaceChildren(node('h4','Όσα έχουν καταγραφεί.'));if(!items.length)history.append(node('p','Δεν υπάρχουν ακόμη παρατηρήσεις για αυτή την έκδοση.',{class:'muted'}));for(const item of items){const entry=node('article',undefined,{class:'feedback-entry'});entry.append(node('h5',feedbackCategories[item.category]??'Παρατήρηση'),node('p',item.message,{class:'feedback-message'}),node('p',`${feedbackStatuses[item.status]??'Καταγράφηκε'} · ${dateLabel(item.createdAt)}`,{class:'muted'}));for(const reply of item.replies??[]){const answer=node('div',undefined,{class:'feedback-reply'});answer.append(node('h5','Απάντηση από τη Molyvi'),node('p',reply.message,{class:'feedback-message'}),node('p',`${feedbackStatuses[reply.status]??'Απάντηση'} · ${dateLabel(reply.createdAt)}`,{class:'muted'}));entry.append(answer);}history.append(entry);}}
  showHistory(data.items);const refresh=node('button','Ανανέωση ιστορικού',{type:'button',class:'secondary'});refresh.addEventListener('click',()=>run(async()=>{const latest=await api('/api/customer/delivery-feedback?deliveryId='+encodeURIComponent(delivery.id));showHistory(latest.items);}));box.append(history,refresh);
  const form=node('form'),prefix=`feedback-${delivery.id}`,category=node('select',undefined,{id:prefix+'-category',required:''}),message=node('textarea',undefined,{id:prefix+'-message',rows:'5',maxlength:'2000',required:'','aria-describedby':prefix+'-help'}),result=node('p','',{role:'status','aria-live':'polite'});
  category.append(node('option','Διάλεξε θέμα',{value:''}));for(const [value,label]of Object.entries(feedbackCategories))category.append(node('option',label,{value}));
  form.append(node('label','Σε ποιο σημείο αφορά;',{for:prefix+'-category'}),category,node('label','Τι θέλεις να ελέγξουμε;',{for:prefix+'-message'}),message,node('p','Για ένα προϊόν, γράψε το όνομά του και τον αριθμό φωτογραφίας. Μην συμπεριλάβεις κωδικούς πρόσβασης ή στοιχεία πληρωμής. Το κείμενο αποθηκεύεται όταν πατήσεις «Καταγραφή παρατήρησης».',{id:prefix+'-help',class:'muted'}),node('button','Καταγραφή παρατήρησης',{type:'submit'}),result);
  let pending=null;
  form.addEventListener('submit',e=>{e.preventDefault();if(!form.reportValidity())return;run(async()=>{const command={deliveryId:delivery.id,manifestHash:delivery.manifestHash,category:category.value,message:message.value.trim()},signature=JSON.stringify(command);if(!pending||pending.signature!==signature)pending={signature,command:{...command,requestId:crypto.randomUUID()}};try{const receipt=await api('/api/customer/delivery-feedback',pending.command);showHistory(receipt.feedback.items);message.value='';pending=null;result.textContent='Η παρατήρησή σου καταγράφηκε για αυτή την έκδοση. Δεν ξεκίνησε νέα εργασία και δεν χρεώθηκαν credits.';}catch(error){result.textContent=error.message;throw error;}});});
  box.append(form,node('p','Η καταγραφή κρατά το αίτημά σου για έλεγχο. Δεν αλλάζει τις οριστικές απαντήσεις ή τον φάκελο και δεν αποτελεί έγκριση, εντολή παραγωγής ή υπόσχεση δωρεάν διόρθωσης. Για αναδημιουργία εικόνας ή αναφορά διαφορετικού προϊόντος, χρησιμοποίησε την αντίστοιχη επιλογή στη συλλογή φωτογραφιών του έργου.',{class:'muted'}));return box;
}
function reviewStatusPanel(data){
  const box=node('div',undefined,{class:'delivery-status-panel'});
  box.append(node('h4','Μια καθαρή εικόνα. Πριν το επόμενο βήμα.'),node('p',`Κοινά βήματα: ${data.common.submitted}/${data.common.total} · Προϊόντα που υποβλήθηκαν: ${data.products.submitted}/${data.products.total}`,{class:'muted'}));
  const photoTitles={matches:'Οι φωτογραφίες συμφωνούν με τις επιλογές σου.',changed:'Οι επιλογές σου έχουν αλλάξει.',not_ready:'Οι φωτογραφίες χρειάζονται ακόμη ένα βήμα.',unavailable:'Δεν υπάρχει ακόμη σύγκριση φωτογραφιών για αυτόν τον φάκελο.'};
  box.append(node('h4',photoTitles[data.photos.status]??photoTitles.unavailable));
  if(data.photos.status==='matches')box.append(node('p',`Οι ${data.photos.selectedCount} επιλεγμένες φωτογραφίες είναι ίδιες και στην ίδια σειρά με αυτή την έκδοση. Ο έλεγχος αφορά τις αποθηκευμένες επιλογές τη στιγμή που τον ανοίγεις.`));
  else if(data.photos.status==='changed')box.append(node('p','Ο φάκελος διατηρεί την έκδοση που παραδόθηκε. Οι νεότερες επιλογές σου χρειάζονται νέα έκδοση φακέλου, πριν από τον τελικό έλεγχο.'));
  if(data.photos.changedProducts.length){const list=node('ul');for(const item of data.photos.changedProducts)list.append(node('li',`${item.title}${item.positions.length?` · Φωτογραφίες ${item.positions.join(', ')}`:''}`));box.append(list);}
  box.append(node('p','Η συμφωνία επιλογών δεν αποτελεί έγκριση ποιότητας ή πιστότητας. Έλεγξε τις φωτογραφίες σε σχέση με τα δικά σου προϊόντα.',{class:'muted'}));
  box.append(node('h4','Τα στοιχεία που απομένουν.'));
  if(data.content.status==='available'){
    box.append(node('p',data.content.pendingCount?`${data.content.pendingCount} στοιχεία χρειάζονται συμπλήρωση ή επιβεβαίωση πριν από πραγματική λειτουργία.`:'Δεν εμφανίζονται ελλείψεις στα δηλωμένα στοιχεία. Παραμένει ο τελικός έλεγχος καταλληλότητας των πολιτικών.'));
    for(const group of data.content.groups){const details=node('details'),summary=node('summary',`${group.title} · ${group.items.length}`),list=node('ul');for(const item of group.items)list.append(node('li',item.label));details.append(summary,list);box.append(details);}
  }else box.append(node('p','Ο έλεγχος στοιχείων θα εμφανιστεί όταν είναι διαθέσιμα τα προσχέδια του έργου.'));
  box.append(node('p','Αυτός ο έλεγχος δεν αλλάζει τα αρχεία ή τις επιλογές σου και δεν καταγράφει τελική αποδοχή. Η εγκυρότητα των πολιτικών και η ενεργοποίηση πληρωμών ολοκληρώνονται από τον ιδιοκτήτη. Το κατάστημα παραμένει αδημοσίευτο.',{class:'muted'}));
  return box;
}
async function api(url,payload){const response=await fetch(url,payload?{method:'POST',headers:{'Content-Type':'application/json',...(account?{'X-Molyvi-Csrf':account.csrfToken}:{})},body:JSON.stringify(payload)}:{cache:'no-store'});const data=await response.json();if(!response.ok){const e=new Error(errors[data.error]??'Η ενέργεια δεν ολοκληρώθηκε. Προσπάθησε ξανά.');e.code=data.error;throw e;}return data;}
function render(){
  $('login-panel').hidden=Boolean(account);$('account-panel').hidden=!account;$('logout').hidden=!account;
  $('operator-link').hidden=!account?.operatorAccess;
  $('request-code').hidden=Boolean(account)||!codeRequests;$('code-request-help').hidden=Boolean(account)||!codeRequests;
  $('code-help').textContent=realEmailEnabled?'Ζήτησε έναν νέο κωδικό στο email σου και χρησιμοποίησέ τον μέσα σε 15 λεπτά. Κάθε κωδικός ισχύει για μία σύνδεση.':'Στην τοπική δοκιμή χρησιμοποιούμε τον ιδιωτικό κωδικό ελέγχου.';
  $('code-request-help').textContent=realEmailEnabled?'Συμπλήρωσε το email σου και επίλεξε «Νέος κωδικός». Αν δεν τον βρεις, έλεγξε και την ανεπιθύμητη αλληλογραφία.':'Στη δοκιμή χωρίς αποστολέα, το μήνυμα αποθηκεύεται ιδιωτικά για τον εσωτερικό έλεγχο.';
  if(!account)return;
  $('greeting').textContent=`Καλώς επέστρεψες, ${account.account.name}.`;
  const projects=$('projects');projects.replaceChildren();
  if(!account.projects.length)projects.append(node('p','Μόλις συνδεθεί η παραγγελία σου, το έργο θα εμφανιστεί εδώ.'));
  for(const p of account.projects){
    const card=node('article',undefined,{class:'card'}),head=node('div',undefined,{class:'project-title'}),title=node('div');
    title.append(node('h2',p.label),node('p',p.orderId,{class:'muted'}));head.append(title,node('span',p.deliveries.length?'Έτοιμος φάκελος ελέγχου':'Το έργο σου',{class:'status'}));card.append(head);
    const actions=node('div',undefined,{class:'actions'}),open=node('button','Συνέχεια στο έργο →',{type:'button'});open.addEventListener('click',()=>run(async()=>{account=await api('/api/customer/select',{projectId:p.id});location.assign('/workspace/');}));actions.append(open);card.append(actions);
    for(const [deliveryIndex,d] of p.deliveries.entries()){
      const section=node('section',undefined,{class:'delivery'}),base=`/customer-files/${d.id}/`;
      section.append(node('h3','Ο φάκελος του καταστήματός σου.'),node('p',`Έκδοση ${p.deliveries.length-deliveryIndex} · ${dateLabel(d.preparedAt)}`,{class:'muted'}),node('p','Οι φωτογραφίες, τα κείμενα και οι οδηγίες, συγκεντρωμένα σε μια συγκεκριμένη έκδοση.'));
      const links=node('div',undefined,{class:'actions'});
      for(const [label,file]of [['Δες τον φάκελο','index.html'],['Εγχειρίδιο PDF','Molyvi-Service-Handbook.pdf'],['Λήψη όλων των αρχείων','Molyvi-Service-Delivery.zip']])links.append(node('a',label,{class:'button secondary',href:base+file,...(file.endsWith('.zip')?{download:''}:{target:'_blank',rel:'noopener noreferrer'})}));section.append(links);
      const inspect=node('button','Έλεγχος πριν την παράδοση',{type:'button',class:'secondary','aria-expanded':'false','aria-controls':`delivery-status-${d.id}`}),status=node('div',undefined,{id:`delivery-status-${d.id}`,hidden:''});
      inspect.addEventListener('click',()=>{if(!status.hidden){status.hidden=true;inspect.setAttribute('aria-expanded','false');return;}run(async()=>{const result=await api('/api/customer/delivery-status?deliveryId='+encodeURIComponent(d.id));status.replaceChildren(reviewStatusPanel(result));status.hidden=false;inspect.setAttribute('aria-expanded','true');});});section.append(inspect,status);
      const feedbackToggle=node('button','Παρατηρήσεις για αυτή την έκδοση',{type:'button',class:'secondary','aria-expanded':'false','aria-controls':`delivery-feedback-${d.id}`}),feedback=node('div',undefined,{id:`delivery-feedback-${d.id}`,hidden:''});
      feedbackToggle.addEventListener('click',()=>{if(!feedback.hidden){feedback.hidden=true;feedbackToggle.setAttribute('aria-expanded','false');return;}run(async()=>{if(!feedback.childNodes.length){const data=await api('/api/customer/delivery-feedback?deliveryId='+encodeURIComponent(d.id));feedback.replaceChildren(feedbackPanel(data,d));}feedback.hidden=false;feedbackToggle.setAttribute('aria-expanded','true');});});section.append(feedbackToggle,feedback);
      if(d.reviewedAt){section.append(node('p',`Ο τεχνικός έλεγχος της δοκιμής καταγράφηκε στις ${new Intl.DateTimeFormat('el-GR',{dateStyle:'medium',timeStyle:'short',timeZone:'Europe/Athens'}).format(new Date(d.reviewedAt))}.`,{class:'muted'}));}
      else {
        const form=node('form'),label=node('label',undefined,{class:'review-label'}),check=node('input',undefined,{type:'checkbox',required:''});
        label.append(check,node('span','Έλεγξα αυτή την έκδοση και ολοκλήρωσα τον τεχνικό έλεγχο της δοκιμής.'));form.append(label,node('button','Καταγραφή τεχνικού ελέγχου',{type:'submit'}));
        form.addEventListener('submit',e=>{e.preventDefault();if(!check.checked)return;run(async()=>{await api('/api/customer/review',{deliveryId:d.id,manifestHash:d.manifestHash,acknowledged:true});account=await api('/api/customer/me');render();$('message').textContent='Ο έλεγχος αποθηκεύτηκε για αυτή την έκδοση. Δεν έγινε δημοσίευση καταστήματος.';});});section.append(form);
      }
      card.append(section);
    }
    projects.append(card);
  }
}
async function run(fn){if(busy)return;busy=true;document.querySelectorAll('button').forEach(b=>b.disabled=true);$('message').textContent='';try{await fn();}catch(e){$('message').textContent=e.message;if(e.code==='SESSION_REQUIRED'){account=null;render();}}finally{busy=false;document.querySelectorAll('button').forEach(b=>b.disabled=false);}}
$('login-form').addEventListener('submit',e=>{e.preventDefault();run(async()=>{await api('/api/customer/login',{address:$('email').value.trim(),code:$('access-code').value.trim()});$('access-code').value='';account=await api('/api/customer/me');render();});});
$('logout').addEventListener('click',()=>run(async()=>{await api('/api/customer/logout',{});account=null;render();$('message').textContent='Αποσυνδέθηκες. Το έργο και τα αρχεία σου παραμένουν αποθηκευμένα.';}));
$('request-code').addEventListener('click',()=>{if(!$('email').reportValidity())return;run(async()=>{await api('/api/customer/request-code',{address:$('email').value.trim()});$('message').textContent=realEmailEnabled?'Αν υπάρχει λογαριασμός με αυτό το email, θα λάβεις τον προσωπικό κωδικό σου. Περίμενε ένα λεπτό πριν ζητήσεις ξανά.':'Η αποστολή email δεν είναι ακόμη ενεργή σε αυτή τη δοκιμή. Ο κωδικός προετοιμάζεται για τον εσωτερικό έλεγχο.';});});
(async()=>{try{const config=await api('/api/service-config');codeRequests=config.customerCodeRequests;realEmailEnabled=config.realEmailEnabled;account=await api('/api/customer/me');}catch(e){if(e.code!=='SESSION_REQUIRED')$('message').textContent=e.message;}render();})();
