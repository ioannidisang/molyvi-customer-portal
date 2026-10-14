'use strict';
let account=null,busy=false,codeRequests=false,realEmailEnabled=false;
const $=id=>document.getElementById(id);
const errors={INVALID_LOGIN:'Το email και ο κωδικός δεν ταιριάζουν ή ο κωδικός έχει ήδη χρησιμοποιηθεί. Χρησιμοποίησε έναν νέο κωδικό.',LOGIN_RATE_LIMIT:'Έγιναν αρκετές προσπάθειες. Περίμενε 15 λεπτά πριν δοκιμάσεις ξανά.',SESSION_REQUIRED:'Συνδέσου ξανά για να συνεχίσεις.',DELIVERY_VERSION_CHANGED:'Υπάρχει διαφορετική έκδοση του φακέλου. Ανανέωσε και έλεγξέ την πριν επιβεβαιώσεις.',DELIVERY_FILE_CHANGED:'Ο φάκελος χρειάζεται έλεγχο πριν συνεχίσεις.',CSRF_REQUIRED:'Ανανέωσε τη σελίδα πριν συνεχίσεις.'};
function node(tag,text,attrs={}){const n=document.createElement(tag);if(text!==undefined)n.textContent=text;for(const [k,v]of Object.entries(attrs))n.setAttribute(k,v);return n;}
async function api(url,payload){const response=await fetch(url,payload?{method:'POST',headers:{'Content-Type':'application/json',...(account?{'X-Molyvi-Csrf':account.csrfToken}:{})},body:JSON.stringify(payload)}:{cache:'no-store'});const data=await response.json();if(!response.ok){const e=new Error(errors[data.error]??'Η ενέργεια δεν ολοκληρώθηκε. Προσπάθησε ξανά.');e.code=data.error;throw e;}return data;}
function render(){
  $('login-panel').hidden=Boolean(account);$('account-panel').hidden=!account;$('logout').hidden=!account;
  $('request-code').hidden=Boolean(account)||!codeRequests;$('code-request-help').hidden=Boolean(account)||!codeRequests;
  if(!account)return;
  $('greeting').textContent=`Καλώς επέστρεψες, ${account.account.name}.`;
  const projects=$('projects');projects.replaceChildren();
  if(!account.projects.length)projects.append(node('p','Μόλις συνδεθεί η παραγγελία σου, το έργο θα εμφανιστεί εδώ.'));
  for(const p of account.projects){
    const card=node('article',undefined,{class:'card'}),head=node('div',undefined,{class:'project-title'}),title=node('div');
    title.append(node('h2',p.label),node('p',p.orderId,{class:'muted'}));head.append(title,node('span',p.deliveries.length?'Έτοιμος φάκελος ελέγχου':'Το έργο σου',{class:'status'}));card.append(head);
    const actions=node('div',undefined,{class:'actions'}),open=node('button','Συνέχεια στο έργο →',{type:'button'});open.addEventListener('click',()=>run(async()=>{account=await api('/api/customer/select',{projectId:p.id});location.assign('/workspace/');}));actions.append(open);card.append(actions);
    for(const d of p.deliveries){
      const section=node('section',undefined,{class:'delivery'}),base=`/customer-files/${d.id}/`;
      section.append(node('h3','Ο φάκελος του καταστήματός σου.'),node('p','Οι φωτογραφίες, τα κείμενα και οι οδηγίες, συγκεντρωμένα σε μια συγκεκριμένη έκδοση.'));
      const links=node('div',undefined,{class:'actions'});
      for(const [label,file]of [['Δες τον φάκελο','index.html'],['Εγχειρίδιο PDF','Molyvi-Service-Handbook.pdf'],['Λήψη όλων των αρχείων','Molyvi-Service-Delivery.zip']])links.append(node('a',label,{class:'button secondary',href:base+file,...(file.endsWith('.zip')?{download:''}:{target:'_blank',rel:'noopener noreferrer'})}));section.append(links);
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
