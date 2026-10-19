'use strict';
// Readiness has no side effects. Only an explicit acknowledgement records a
// preparation request. A separately authorized server worker may compose/install
// the exact approved development-store package; the browser grants no store rights.
window.MolyviBasicPreparation=(()=>{
  let enabled=false,api=null,context=()=>null,projectId=null,inFlight=false,lastRead=0,signature='',latest=null;
  const node=(tag,text)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;return e;};
  const panel=()=>document.getElementById('basic-preparation');
  function render(data){
    const p=panel();if(!p)return;
    const next=JSON.stringify(data);if(next===signature)return;signature=next;latest=data;p.hidden=false;p.replaceChildren(node('h2','Το κατάστημά σου παίρνει μορφή.'));
    const readiness=data.readiness,summary=readiness?.summary??{},request=data.request;
    p.append(node('p',`${summary.products??0} προϊόντα · ${summary.photos??0} φωτογραφίες · ${summary.pages??7} σελίδες`));
    const messages={inputs_pending:'Συμπλήρωσε και υπέβαλε τα στοιχεία που λείπουν. Μπορείς να συνεχίσεις από εκεί που σταμάτησες.',production_pending:'Έχουμε τα στοιχεία σου. Περιμένουμε να ολοκληρωθούν τα αποτελέσματα πριν ετοιμάσουμε το κατάστημα.',review_pending:'Μένουν οι παρακάτω έλεγχοι ή επιλογές πριν συνθέσουμε το κατάστημα.',ready_for_preparation:'Τα στοιχεία και τα αποτελέσματά σου είναι έτοιμα για προετοιμασία. Επιβεβαίωσε ότι ολοκλήρωσες τον κατάλογό σου.'};
    if(!request||request.sourceHash!==data.sourceHash||!readiness?.ready)p.append(node('p',messages[readiness?.state]??'Ελέγχουμε την ετοιμότητα του έργου.'));
    const blockers=readiness?.blockers??[];
    if(blockers.length){const details=node('details'),list=node('ul'),workspace=context(),tasks=workspace?.tasks??[],products=tasks.find(task=>task.id==='catalog')?.draft?.products??[];details.append(node('summary',`Τι απομένει (${blockers.length})`));for(const item of blockers){const label=item.productId?products.find(product=>product.id===item.productId)?.title:tasks.find(task=>task.id===item.taskId)?.title;list.append(node('li',`${label?label+': ':''}${item.message}`));}details.append(list);p.append(details);}
    const stale=request&&(request.stale===true||request.state==='stale'||request.sourceHash!==data.sourceHash);
    if(request&&!stale){
      const progress=data.installation;
      if(progress&&progress.stage!=='waiting_confirmation'){
        const text={preparing:'Συνθέτουμε το κατάστημά σου και ελέγχουμε τα αρχεία του.',installation_review:'Το πακέτο είναι έτοιμο. Ελέγχουμε τη σύνδεση με το δοκιμαστικό κατάστημα.',installing:'Εγκαθιστούμε τα προϊόντα, τις σελίδες και την εμφάνιση στο δοκιμαστικό κατάστημα.',installed_draft:'Η εγκατάσταση και ο έλεγχος του πακέτου ολοκληρώθηκαν. Το κατάστημα παραμένει σε Draft και δεν έχει δημοσιευτεί.',blocked:'Η διαδικασία σταμάτησε για έλεγχο από την ομάδα Molyvi. Το ήδη αποθηκευμένο υλικό σου διατηρείται.'}[progress.stage];
        if(text){const status=node('p',text);status.setAttribute('role','status');p.append(status);return;}
      }
      const labels={requested:'Η επιβεβαίωσή σου καταγράφηκε. Ακολουθεί η σύνθεση και ο έλεγχος του ιδιωτικού πακέτου.',preparing:'Το πακέτο βρίσκεται σε προετοιμασία.',prepared_for_installation_review:'Το πακέτο ετοιμάστηκε για τον εσωτερικό έλεγχο εγκατάστασης.',preparation_failed:'Η προετοιμασία χρειάζεται έλεγχο από την ομάδα Molyvi.',preparation_unknown:'Η προετοιμασία χρειάζεται έλεγχο από την ομάδα Molyvi.'};
      const status=node('p',labels[request.state]??'Το αίτημα προετοιμασίας έχει καταγραφεί. Η ομάδα Molyvi ελέγχει το επόμενο στάδιο.');status.setAttribute('role','status');p.append(status);return;
    }
    if(stale)p.append(node('p','Τα στοιχεία άλλαξαν μετά την προηγούμενη επιβεβαίωση. Έλεγξε τη νέα επιλογή σου πριν συνεχίσεις.'));
    if(!readiness?.ready)return;
    const label=node('label'),checkbox=node('input');checkbox.type='checkbox';checkbox.id='basic-preparation-confirm';
    label.append(checkbox,document.createTextNode(' Έχω ολοκληρώσει τον κατάλογό μου και επιβεβαιώνω τις επιλεγμένες φωτογραφίες για την προετοιμασία του καταστήματος.'));
    p.append(label,node('p','Η επιβεβαίωση αφορά τα τωρινά προϊόντα και τις εικόνες τους. Αν αλλάξεις κάποιο στοιχείο, θα χρειαστεί νέα επιβεβαίωση.'));
    const button=node('button','Επιβεβαίωση για προετοιμασία →'),feedback=node('p');button.type='button';button.disabled=true;feedback.setAttribute('role','status');checkbox.addEventListener('change',()=>button.disabled=!checkbox.checked);
    button.addEventListener('click',async()=>{
      if(!checkbox.checked||button.disabled)return;button.disabled=true;checkbox.disabled=true;
      const selectedProject=projectId,expectedSourceHash=latest.sourceHash;
      try{await api('/api/basic-preparation-request',{expectedSourceHash,acknowledged:true});if(projectId!==selectedProject)return;signature='';lastRead=0;await refresh(projectId,true);}
      catch(error){if(projectId!==selectedProject)return;feedback.textContent=error.code==='BASIC_PREPARATION_SOURCE_CHANGED'?'Τα στοιχεία άλλαξαν. Ανανέωσε τον έλεγχο και επιβεβαίωσε τη νέα επιλογή.':error.message;checkbox.disabled=false;button.disabled=!checkbox.checked;}
    });
    p.append(button,feedback);
  }
  async function refresh(id,force=false){
    if(!enabled||!id||!panel())return;
    if(projectId!==id){projectId=id;lastRead=0;signature='';latest=null;panel().hidden=true;}
    if(inFlight||(!force&&Date.now()-lastRead<5000))return;
    const selectedProject=projectId;inFlight=true;lastRead=Date.now();
    try{const data=await api('/api/basic-preparation');if(projectId===selectedProject){if(data.projectId!==selectedProject){panel().hidden=true;signature='';latest=null;return;}render(data);}}
    catch{if(projectId===selectedProject){panel().hidden=false;panel().replaceChildren(node('h2','Προετοιμασία καταστήματος'),node('p','Ο έλεγχος ετοιμότητας δεν είναι διαθέσιμος αυτή τη στιγμή. Τα αποθηκευμένα στοιχεία σου διατηρούνται.'));signature='';}}
    finally{inFlight=false;}
  }
  return {configure(options){enabled=options.enabled===true;api=options.api;context=options.context??(()=>null);if(!enabled&&panel())panel().hidden=true;},refresh};
})();
