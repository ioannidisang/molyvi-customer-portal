'use strict';
window.MolyviGallery=(()=>{
  const make=(tag,text,attrs={})=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;for(const [key,value]of Object.entries(attrs))node.setAttribute(key,value);return node;};
  function enlarge(candidate,label){
    const dialog=document.getElementById('photo-viewer');document.getElementById('photo-viewer-title').textContent=label;
    const image=document.getElementById('photo-viewer-image');image.src=candidate.url;image.alt=label;dialog.showModal();
  }
  const claimDrafts=new Map();
  const claimNames={awaiting_review:'Η αναφορά καταχωρίστηκε',confirmed:'Επιβεβαιώθηκε διαφορά στο προϊόν',not_confirmed:'Δεν επιβεβαιώθηκε διαφορά στο προϊόν',needs_specialist:'Ο έλεγχος δεν έδωσε ασφαλές συμπέρασμα',escalated:'Ζητήθηκε επανεξέταση από ειδικό'};
  function reviewProgress(claim){
    const queue=claim.reviewQueue;
    if(!queue)return 'Η αναφορά αποθηκεύτηκε και περιμένει σύγκριση με τις αρχικές φωτογραφίες. Ο αυτόματος έλεγχος δεν έχει ενεργοποιηθεί σε αυτή τη δοκιμή.';
    if(['daily_limit','daily_attempt_limit','usage_limit','rate_limit'].includes(queue.reason))return 'Ο έλεγχος περιμένει να είναι ξανά διαθέσιμη η υπηρεσία. Το αίτημά σου έχει αποθηκευτεί και δεν χρειάζεται να το υποβάλεις ξανά.';
    if(queue.status==='running')return 'Συγκρίνουμε την εικόνα με το αρχικό υλικό και τις οδηγίες σου. Η απόφαση θα εμφανιστεί εδώ μόλις ολοκληρωθεί ο διπλός έλεγχος.';
    if(queue.status==='queued')return queue.completedPasses?'Ο πρώτος έλεγχος ολοκληρώθηκε. Ακολουθεί δεύτερος ανεξάρτητος έλεγχος πριν από την απόφαση.':'Η εικόνα μπήκε στην ουρά αυτόματου ελέγχου. Δεν χρειάζεται άλλη ενέργεια από εσένα.';
    if(queue.status==='paused'){
      if(queue.reason==='provider_unavailable')return 'Η αναφορά αποθηκεύτηκε. Ο αυτόματος έλεγχος δεν είναι ενεργός σε αυτή τη δοκιμή· οι εικόνες και τα credits σου διατηρούνται.';
      return 'Ο αυτόματος έλεγχος σταμάτησε προσωρινά για τεχνική επαλήθευση. Το αίτημά σου παραμένει αποθηκευμένο· δεν έγινε νέα χρέωση credits.';
    }
    return 'Ο διπλός έλεγχος ολοκληρώθηκε. Η απόφαση και τυχόν επιστροφή credits εμφανίζονται εδώ.';
  }
  function claimPanel(productId,slotId,candidate,gallery,claims,claimAction,label){
    const key=`${productId}-${slotId}-${candidate.id}`,claim=claims.find(item=>item.productId===productId&&item.slotId===slotId&&item.candidateId===candidate.id);
    if(claim){
      claimDrafts.delete(key);
      const panel=make('section',undefined,{class:'photo-claim-status','aria-label':`Αναφορά — ${label}`,'data-claim-id':claim.id});
      panel.append(make('strong',claimNames[claim.status]??'Η αναφορά σου'),make('p',claim.description,{class:'photo-claim-description'}));
      if(claim.explanation)panel.append(make('p',claim.explanation));
      if(claim.status==='awaiting_review')panel.append(make('p',reviewProgress(claim),{class:'note','data-review-status':claim.reviewQueue?.status??'unavailable'}));
      if(claim.remediation?.status==='credits_restored')panel.append(make('p',claim.remediation.alreadyRestored?`Τα ${claim.remediation.amount} credits αυτής της εικόνας είχαν ήδη επιστραφεί. Δεν έγινε δεύτερη πίστωση.`:`Επιστράφηκαν ${claim.remediation.amount} credits στο υπόλοιπό σου. Μπορείς να τα χρησιμοποιήσεις όταν επιλέξεις.`,{class:'field-help'}));
      if(claim.remediation?.status==='entitlement_restored'){
        const replacementStatus=claim.remediation.entitlementStatus;
        panel.append(make('p',replacementStatus==='consumed'?'Το δικαίωμα αποκατάστασης χρησιμοποιήθηκε στην τοπική δοκιμή.':replacementStatus==='reserved'?'Το δικαίωμα αποκατάστασης έχει δεσμευτεί για το αίτημα που υπέβαλες.':'Στην τοπική δοκιμή αποκαταστάθηκε ένα δικαίωμα αντικατάστασης αυτής της εικόνας. Δεν ξεκινά νέα δημιουργία χωρίς αίτημά σου.',{class:'field-help'}));
      }
      else if(claim.remediation?.status==='remediation_pending')panel.append(make('p','Η αποκατάσταση εκκρεμεί. Δεν έχουν επιστραφεί credits.',{class:'field-help'}));
      if(claim.canEscalate){
        const escalate=make('button','Ζήτησε έλεγχο από ειδικό',{type:'button',class:'secondary small','aria-label':`Ζήτησε έλεγχο από ειδικό — ${label}`});
        escalate.addEventListener('click',()=>claimAction({action:'escalate',claimId:claim.id}));panel.append(escalate);
      }
      if(claim.status==='escalated')panel.append(make('p','Το αίτημα επανεξέτασης αποθηκεύτηκε τοπικά. Δεν έχει αποσταλεί σε ομάδα εξυπηρέτησης.',{class:'note'}));
      return panel;
    }
    const draft=claimDrafts.get(key)??{description:'',open:false,requestId:crypto.randomUUID()};claimDrafts.set(key,draft);
    const details=make('details',undefined,{class:'photo-claim'});details.open=draft.open;
    details.append(make('summary','Το προϊόν διαφέρει',{'aria-label':`Το προϊόν διαφέρει — ${label}`}));
    details.addEventListener('toggle',()=>{draft.open=details.open;});
    const id=`claim-${key}`,description=make('textarea',undefined,{id,maxlength:'2000',required:'','aria-describedby':`${id}-help`,placeholder:'Για παράδειγμα: το δαχτυλίδι μου έχει 3 πέτρες, ενώ εδώ εμφανίζονται 4.'});description.value=draft.description;
    description.addEventListener('input',event=>{draft.description=description.value;description.setCustomValidity('');event.stopPropagation();});
    const submit=make('button','Αναφορά διαφοράς',{type:'button',class:'secondary small','aria-label':`Αναφορά διαφοράς — ${label}`});
    submit.addEventListener('click',async()=>{
      const value=description.value.trim();description.setCustomValidity(value?'':'Περιέγραψε τη διαφορά που εντοπίζεις στο ίδιο το προϊόν.');
      if(!description.reportValidity())return;
      const completed=await claimAction({action:'open',productId,slotId,candidateId:candidate.id,galleryHash:gallery.sourceHash,requestId:draft.requestId,kind:'product_difference',description:value});
      if(completed)claimDrafts.delete(key);
    });
    details.append(make('p','Διαφέρει κάποιο χαρακτηριστικό του προϊόντος από τις αρχικές φωτογραφίες σου; Δείξε μας ποιο, για να εξεταστεί η συγκεκριμένη εικόνα.',{class:'field-help'}),make('label','Ποια διαφορά εντοπίζεις; *',{for:id}),description,
      make('p','Αριθμός στοιχείων, σχήμα, χρώμα ή αναλογίες του προϊόντος. Για διαφορετικό φως, φόντο ή ύφος, μπορείς να ζητήσεις νέα εκδοχή χωρίς αναφορά.',{id:`${id}-help`,class:'field-help'}),submit);
    return details;
  }
  function render(productId,gallery,action,{claims=[],claimAction}={}){
    const section=make('section',undefined,{class:'result-gallery','aria-label':'Οι φωτογραφίες του προϊόντος'});
    section.append(make('h4','Η εικόνα του προϊόντος σου. Η δική σου επιλογή.'),make('p','Διάλεξε την εκδοχή που σε εκφράζει. Όρισε την κύρια φωτογραφία και βάλε τις υπόλοιπες στη σειρά που θέλεις.',{class:'field-help'}));
    section.append(make('p','Κάθε φωτογραφία περιλαμβάνει 3 πρόσθετες αναδημιουργίες, όταν τις ζητήσεις. Δεν χρειάζεται αιτιολόγηση ή έγκριση. Η αρχική και οι νέες εκδοχές παραμένουν διαθέσιμες για επιλογή.',{class:'field-help'}));
    section.append(make('p','Τοπική δοκιμή: οι εικόνες εισάγονται από τον χειριστή. Οι ολοκληρωμένες αποφάσεις ελέγχου εμφανίζονται στη σχετική αναφορά. Η αυτόματη παραγωγή νέων εικόνων και η αποστολή σε ομάδα εξυπηρέτησης παραμένουν προς σύνδεση.',{class:'note'}));
    gallery.order.forEach((slotId,position)=>{
      const slot=gallery.slots.find(slot=>slot.id===slotId),number=/photo-(\d+)$/.exec(slotId)?.[1]??String(position+1),unitIndex=slot.visualUnitId?[...new Set(gallery.slots.map(item=>item.visualUnitId).filter(Boolean))].indexOf(slot.visualUnitId)+1:null,label=`${slot.visualUnitId?`${slot.color||`Παρουσίαση ${unitIndex}`} · `:''}Φωτογραφία ${number}`,article=make('article',undefined,{class:'photo-slot','data-slot-id':slotId});
      const head=make('div',undefined,{class:'product-heading'});head.append(make('h5',`${label} · ${slot.role==='white'?'Λευκό φόντο':'Lifestyle'}`));
      if(position===0)head.append(make('span','Κύρια φωτογραφία',{class:'product-badge'}));article.append(head);
      const versions=make('div',undefined,{class:'photo-candidates'});
      slot.candidates.forEach((candidate,index)=>{
        const regularVersion=slot.candidates.slice(0,index+1).filter(item=>item.kind!=='replacement').length-1;
        const name=candidate.kind==='replacement'?'Εικόνα αποκατάστασης':index===0?'Αρχική':`${regularVersion}η νέα εκδοχή`,figure=make('figure',undefined,{class:slot.selected===candidate.id?'photo-candidate selected':'photo-candidate'});
        const zoom=make('button',undefined,{type:'button',class:'photo-zoom','aria-label':`Μεγέθυνση — ${label}, ${name}`});zoom.append(make('img',undefined,{src:candidate.url,alt:`${label} — ${name}`,loading:'lazy'}));zoom.addEventListener('click',()=>enlarge(candidate,`${label} — ${name}`));
        const choose=make('button',slot.selected===candidate.id?'✓ Η επιλογή σου':'Κρατάω αυτή',{type:'button',class:'secondary small','aria-label':`Κρατάω αυτή — ${label}, ${name}`,'aria-pressed':String(slot.selected===candidate.id)});
        choose.addEventListener('click',()=>action(productId,{action:'select',slotId,candidateId:candidate.id,galleryHash:gallery.sourceHash,revision:gallery.revision}));
        figure.append(zoom,make('figcaption',name),choose);
        if(claimAction)figure.append(claimPanel(productId,slotId,candidate,gallery,claims,claimAction,`${label}, ${name}`));
        versions.append(figure);
      });article.append(versions);
      if(!slot.candidates.length)article.append(make('p','Η θέση είναι έτοιμη. Η εικόνα περιμένει δημιουργία.',{class:'field-help'}));
      const layout=make('div',undefined,{class:'actions photo-layout'});
      const sendOrder=order=>action(productId,{action:'layout',order,galleryHash:gallery.sourceHash,revision:gallery.revision});
      if(position>0){const primary=make('button','Κύρια φωτογραφία',{type:'button',class:'secondary small','aria-label':`Κύρια φωτογραφία — ${label}`});primary.addEventListener('click',()=>sendOrder([slotId,...gallery.order.filter(id=>id!==slotId)]));layout.append(primary);}
      for(const [offset,text]of [[-1,'Πιο μπροστά'],[1,'Πιο πίσω']]){
        const button=make('button',text,{type:'button',class:'secondary small','aria-label':`${text} — ${label}`});button.disabled=position+offset<0||position+offset>=gallery.order.length;
        button.addEventListener('click',()=>{const order=[...gallery.order];[order[position],order[position+offset]]=[order[position+offset],order[position]];sendOrder(order);});layout.append(button);
      }article.append(layout);
      const pending=slot.requests.some(request=>request.status==='awaiting_provider');
      const details=make('details',undefined,{class:'regeneration-options'});details.append(make('summary','Νέα εκδοχή'));
      const id=`regen-${productId}-${slotId}`,mode=make('select',undefined,{id});
      for(const [value,text]of [['same_style','Άλλη εκδοχή στο ίδιο ύφος'],['specific_change','Θέλω συγκεκριμένη αλλαγή']])mode.append(make('option',text,{value}));
      const change=make('textarea',undefined,{id:`${id}-change`,maxlength:'2000',placeholder:'Για παράδειγμα: πιο ζεστό φως ή πιο απλό περιβάλλον.'}),changeGroup=make('div');changeGroup.hidden=true;
      changeGroup.append(make('label','Τι θέλεις να αλλάξει;',{for:`${id}-change`}),change,make('p','Οι συγκεκριμένες λεπτομέρειες μας βοηθούν να πλησιάσουμε την εικόνα σου, διατηρώντας το πραγματικό προϊόν.',{class:'field-help'}));
      mode.addEventListener('change',()=>{changeGroup.hidden=mode.value!=='specific_change';});
      const generate=make('button','Δημιουργία νέας εκδοχής',{type:'button',class:'secondary','aria-label':`Δημιουργία νέας εκδοχής — ${label}`});generate.disabled=!slot.candidates.length||pending||slot.paused||slot.remaining===0;
      generate.addEventListener('click',()=>action(productId,{action:'request',slotId,galleryHash:gallery.sourceHash,requestId:crypto.randomUUID(),mode:mode.value,change:mode.value==='specific_change'?change.value:''}));
      details.append(make('label','Πώς θέλεις να συνεχίσουμε;',{for:id}),mode,changeGroup,generate);
      const availableReplacement=(slot.replacementEntitlements??[]).find(item=>item.status==='available');
      if(availableReplacement){
        const replace=make('button','Δημιουργία εικόνας αποκατάστασης',{type:'button',class:'secondary','aria-label':`Δημιουργία εικόνας αποκατάστασης — ${label}`});replace.disabled=!slot.candidates.length||pending||slot.paused;
        replace.addEventListener('click',()=>action(productId,{action:'replacement',slotId,entitlementId:availableReplacement.id,galleryHash:gallery.sourceHash,requestId:crypto.randomUUID(),mode:mode.value,change:mode.value==='specific_change'?change.value:''}));
        details.append(make('p','Έχεις διαθέσιμη μία εικόνα αποκατάστασης από επιβεβαιωμένη αναφορά. Δημιουργείται μόνο όταν τη ζητήσεις, χωρίς να αφαιρείται από τις 3 αναδημιουργίες.',{class:'field-help'}),replace);
      }
      article.append(details);
      article.append(make('p',`${slot.remaining} διαθέσιμες αναδημιουργίες για αυτή τη φωτογραφία`,{class:'field-help'}));
      if(pending)article.append(make('p','Το αίτημά σου αποθηκεύτηκε. Η πραγματική δημιουργία AI παραμένει προς σύνδεση στην τοπική δοκιμή.',{class:'status'}));
      if(slot.paused)article.append(make('p','Η δημιουργία έχει προσωρινά σταματήσει για τεχνικό έλεγχο. Οι διαθέσιμες εκδοχές παραμένουν εδώ.',{class:'status'}));
      if(slot.remaining===0&&!pending)article.append(make('p','Διάλεξε ανάμεσα στις διαθέσιμες εκδοχές. Η αγορά πρόσθετων εικόνων θα προστεθεί σε επόμενο βήμα.',{class:'field-help'}));
      section.append(article);
    });
    section.append(make('p','Η επιλογή υπάρχουσας εκδοχής και η αλλαγή σειράς αποθηκεύονται αυτόματα. Δεν δημιουργούν νέα εικόνα και δεν χρησιμοποιούν επιπλέον AI credits.',{class:'field-help'}));return section;
  }
  return {render};
})();
