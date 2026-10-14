'use strict';
window.MolyviProducts=(()=>{
  const make=(tag,text,attrs={})=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;for(const [key,value]of Object.entries(attrs))node.setAttribute(key,value);return node;};
  const uuid=()=>crypto.randomUUID();
  const plural=(count,single,many)=>`${count} ${count===1?single:many}`;
  function empty(){return {id:uuid(),title:'',description:'',price:'',stock:'',photos:[],improveTitle:false,improveDescription:false,...MolyviCatalog.initial()};}
  function read(){return [...document.querySelectorAll('.product-card')].map(card=>card.dataset.locked==='true'?JSON.parse(card.dataset.original):({id:card.dataset.id,
    ...Object.fromEntries(['title','description','price','stock'].map(key=>[key,card.querySelector(`[data-field="${key}"]`).value])),
    improveTitle:card.querySelector('[data-field="improveTitle"]').checked,improveDescription:card.querySelector('[data-field="improveDescription"]').checked,
    photos:JSON.parse(card.dataset.photos),...card.catalogEditor?.read()}));}
  function render(task,{materials,texts,states,galleries,galleryAction,photoClaims,photoClaimAction,changed,action}){
    const section=make('div',undefined,{id:'group-products',class:'product-list'});
    let products=structuredClone(task.draft.products??[]);if(!products.length)products=[empty()];
    function cards(){
      const latest=section.querySelectorAll('.product-card').length?read():products;
      products=latest;section.replaceChildren(make('p',`Το πακέτο σου περιλαμβάνει ${materials.productLimit} φωτογραφικές παρουσιάσεις. Μεγέθη που μοιράζονται τις ίδιες φωτογραφίες μετρούν μία φορά. Διαφορετικό χρώμα ή απεικόνιση μετρά χωριστά.`,{class:'field-help'}));
      const totals=make('div',undefined,{class:'catalog-totals','aria-live':'polite'});section.append(totals);
      products.forEach((product,index)=>{
        const card=make('section',undefined,{class:'product-card','data-id':product.id,'data-photos':JSON.stringify(product.photos??[]),'aria-label':`Προϊόν ${index+1}`});
        const state=states[product.id],head=make('div',undefined,{class:'product-heading'}),remove=make('button','Αφαίρεση προϊόντος',{type:'button',class:'secondary small'});
        if(state?.submission){
          const locked=state.submission;card.dataset.locked='true';card.dataset.original=JSON.stringify(locked.product);
          card.classList.add('product-locked');head.append(make('h3',`Προϊόν ${String(index+1).padStart(2,'0')}`),make('span','Υποβλήθηκε οριστικά',{class:'product-badge'}));card.append(head);
          card.append(make('h4',locked.productCopy.title.text),make('p',locked.productCopy.description.text,{class:'locked-description'}));
          if(locked.product.variants){const count=MolyviCatalog.summary([locked.product],materials.photosPerUnit??(materials.productLimit===25?5:3));card.append(make('p',`${plural(count.variants,'επιλογή αγοράς','επιλογές αγοράς')} · ${plural(count.visualUnits,'φωτογραφική παρουσίαση','φωτογραφικές παρουσιάσεις')} · ${count.initialPhotoSlots} αρχικές εικόνες`,{class:'field-help'}));}
          else card.append(make('p',`${locked.product.price} € · Απόθεμα ${locked.product.stock}`,{class:'field-help'}));
          const photos=make('div',undefined,{class:'product-photos'});
          for(const id of locked.product.photos){const asset=materials.assets.find(item=>item.id===id);if(asset){const figure=make('figure');figure.append(make('img',undefined,{src:asset.url,alt:asset.name,loading:'lazy'}),make('figcaption',asset.name));photos.append(figure);}}
          card.append(photos,make('p','Τα στοιχεία και οι επιλογές αυτού του προϊόντος έχουν κλειδώσει. Μπορείς να συνεχίσεις με τα υπόλοιπα.',{class:'field-help'}));
          const names={draft:'Δεν έχει υποβληθεί',preflight_queued:'Ξεκινά ο έλεγχος του προϊόντος',preflight_running:'Ελέγχουμε το προϊόν',queued:'Έτοιμο για επεξεργασία',running:'Σε επεξεργασία',completed:'Ολοκληρώθηκε η δοκιμαστική ροή',failed:'Χρειάζεται έλεγχος',paused_unknown:'Παύση για έλεγχο',paused_budget:'Παύση κόστους'};
          const waiting=(state.waitingFor??[]).map(id=>id==='branding'?'την εικόνα του καταστήματος':'τις επιλογές παρουσίασης φωτογραφιών').join(' και ');
          card.append(make('p',state.productionPlanReady?`Η παρουσίαση σχεδιάστηκε με την εγκεκριμένη εμφάνισή σου. ${state.imageProgress.ready} από ${state.imageProgress.planned} εικόνες έτοιμες.`:state.status==='waiting_dependencies'?`Περιμένει ${waiting}. Τα υπόλοιπα προϊόντα μπορούν να συνεχίσουν.`:names[state.status]??'Σε αναμονή',{class:'status'}));
          card.append(make('p',state.productionPlanReady?'Κάθε θέση έχει συνδεθεί με τις αρχικές φωτογραφίες αυτού του προϊόντος. Οι νέες εικόνες θα εμφανιστούν εδώ όταν δημιουργηθούν.':'Η προετοιμασία του έργου προσομοιώνεται. Οι διαθέσιμες εικόνες και οι αποφάσεις ελέγχου εμφανίζονται παρακάτω.',{class:'field-help'}));
          if(galleries[product.id])card.append(MolyviGallery.render(product.id,galleries[product.id],galleryAction,{claims:photoClaims,claimAction:photoClaimAction}));
          section.append(card);return;
        }
        remove.addEventListener('click',()=>{products=read().filter(item=>item.id!==product.id);section.querySelectorAll('.product-card').forEach(node=>node.remove());changed();cards();});
        head.append(make('h3',`Προϊόν ${String(index+1).padStart(2,'0')}`),remove);card.append(head);
        if(state?.skipped)card.append(make('p','Το κράτησες για αργότερα. Επέστρεψε όταν έχεις έτοιμα τα στοιχεία του.',{class:'field-help'}));
        for(const [key,label,help]of [
          ['title','Τίτλος προϊόντος','Ένας σαφής τίτλος δίνει στο προϊόν σου τη σωστή πρώτη εικόνα. Πρόσθεσε όσα το κάνουν αναγνωρίσιμο.'],
          ['description','Περιγραφή προϊόντος','Υλικά, διαστάσεις, χρώμα, μεγέθη και χρήση. Όσα μοιράζεσαι μάς βοηθούν να αναδείξουμε το προϊόν με ακρίβεια.'],
          ['price','Τιμή σε ευρώ','Η ακριβής τιμή δίνει στον πελάτη σου μια καθαρή εικόνα της αγοράς.'],
          ['stock','Απόθεμα','Η σωστή διαθεσιμότητα κάνει την εμπειρία αγοράς πιο αξιόπιστη.']
        ]){
          const group=make('div',undefined,{class:`field${['price','stock'].includes(key)?' legacy-product-commerce':''}`}),id=`product-${product.id}-${key}`;
          if(['price','stock'].includes(key)&&product.variants)group.hidden=true;
          const input=make(key==='description'?'textarea':'input',undefined,{id,'data-field':key,'aria-describedby':`${id}-help`,...(key!=='description'?{type:['price','stock'].includes(key)?'number':'text'}:{})});input.value=product[key]??'';
          if(['price','stock'].includes(key)){input.min='0';input.step=key==='stock'?'1':'.01';}else input.maxLength=key==='title'?400:12000;
          group.append(make('label',label+' *',{for:id}),input,make('p',help,{id:`${id}-help`,class:'field-help'}));
          if(['title','description'].includes(key)){
            const flag=key==='title'?'improveTitle':'improveDescription',choice=make('label',undefined,{class:'copy-choice'}),check=make('input',undefined,{type:'checkbox','data-field':flag});check.checked=product[flag]===true;
            choice.append(check,make('span',key==='title'?'Να βελτιώσουμε τον τίτλο με AI':'Να βελτιώσουμε την περιγραφή με AI'));
            group.append(choice,make('p','Πιο σαφές, χρήσιμο κείμενο για τους πελάτες σου, την αναζήτηση και τις απαντήσεις AI. Θα δεις την πρόταση πριν αντικαταστήσεις το δικό σου κείμενο.',{class:'field-help'}));
            const state=texts.products[product.id]?.[key]??{selected:'original',used:0,requests:[],selectionConfirmed:false};
            const panel=make('div',undefined,{class:'text-versions','data-text-field':key});panel.hidden=!check.checked;
            check.addEventListener('change',()=>{panel.hidden=!check.checked;});
            panel.append(make('strong','Η δική σου φωνή. Η δική σου επιλογή.'),
              make('p',`Έως ${texts.limit} AI εκδοχές για ${key==='title'?'τον τίτλο':'την περιγραφή'}, όταν τις χρειαστείς. Κράτησε όποια σε εκφράζει, ακόμη κι αν είναι η πρώτη. Το δικό σου κείμενο παραμένει πάντα διαθέσιμο.`,{class:'field-help'}));
            const choices=make('div',undefined,{class:'text-version-list'});
            const original=make('button',state.selected==='original'&&state.selectionConfirmed?'✓ Κρατάμε το δικό σου κείμενο':'Κράτησε το δικό σου κείμενο',{type:'button',class:'secondary small'});
            original.addEventListener('click',()=>action('textSelect',product.id,{field:key,variantId:'original'}));choices.append(original);
            state.requests.forEach((request,index)=>{
              if(request.status==='cancelled_stale'){
                choices.append(make('p','Τα στοιχεία άλλαξαν· το παλιό αίτημα ακυρώθηκε. Μπορείς να συνεχίσεις με το αρχικό σου κείμενο ή να ζητήσεις νέα εκδοχή.',{class:'field-help'}));
                return;
              }
              if(request.status!=='completed')return;
              const version=make('div',undefined,{class:'text-version'});
              version.append(make('span',`Εκδοχή ${index+1}`,{class:'field-help'}),make('p',request.text));
              const choose=make('button',state.selected===request.id?'✓ Η επιλογή σου':'Επιλογή αυτής της εκδοχής',{type:'button',class:'secondary small'});choose.disabled=!request.current;
              choose.addEventListener('click',()=>action('textSelect',product.id,{field:key,variantId:request.id}));version.append(choose);
              if(!request.current)version.append(make('p','Τα αρχικά στοιχεία άλλαξαν. Αυτή η εκδοχή παραμένει στο ιστορικό και χρειάζεται έλεγχο πριν χρησιμοποιηθεί.',{class:'field-help'}));choices.append(version);
            });panel.append(choices);
            const waiting=state.requests.some(request=>request.status==='awaiting_provider'),paused=state.requests.some(request=>['paused_unknown','needs_review'].includes(request.status));
            const generate=make('button',state.used?'Νέα AI εκδοχή':'Δημιουργία πρώτης AI εκδοχής',{type:'button',class:'secondary'});
            generate.disabled=waiting||paused||state.used>=texts.limit;
            generate.addEventListener('click',()=>action('textRequest',product.id,{field:key,requestId:uuid()}));panel.append(generate);
            panel.append(make('p',`${state.requests.filter(request=>request.status==='completed').length} έτοιμες AI εκδοχές · ${Math.max(0,texts.limit-state.used)} διαθέσιμες νέες επιλογές`,{class:'field-help'}));
            if(waiting)panel.append(make('p','Το αίτημά σου αποθηκεύτηκε για επεξεργασία στη δοκιμή Pro.',{class:'field-help'}));
            if(paused)panel.append(make('p','Χρειάζεται έλεγχος πριν δημιουργήσουμε άλλο κείμενο.',{class:'field-help'}));
            group.append(panel);
          }
          card.append(group);
        }
        card.catalogEditor=MolyviCatalog.render(product,{materials,action,changed:()=>{changed();updateTotals();}});card.append(card.catalogEditor.node);
        card.addEventListener('catalogmodechange',()=>{card.querySelectorAll('.legacy-product-commerce').forEach(node=>node.hidden=true);card.querySelector('.legacy-photo-review').hidden=true;updateTotals();});
        const photoGroup=make('div',undefined,{class:'field'}),photoId=`photos-${product.id}`;
        const input=make('input',undefined,{id:photoId,type:'file',multiple:'',accept:'image/png,image/jpeg,image/webp','aria-describedby':`${photoId}-help`});
        photoGroup.append(make('label','Οι φωτογραφίες αυτού του προϊόντος *',{for:photoId}),input,
          make('p','Δείξε μας το ίδιο προϊόν από διαφορετικές γωνίες, με καθαρό φως και ορατές λεπτομέρειες. Όσο πιο καθαρή η αφετηρία, τόσο πιο πιστή μπορεί να γίνει η τελική του εικόνα.',{id:`${photoId}-help`,class:'field-help'}),
          make('p',`Για την τοπική δοκιμή: PNG, JPEG ή WebP, έως 10 MB ανά αρχείο και ${product.variants?(materials.technicalLimits?.photosPerProduct??materials.limits.maxPhotos):materials.limits.maxPhotos} αρχικές φωτογραφίες ανά καταχώριση. Πρόκειται για όριο αρχείων της δοκιμής. Οι εικόνες που θα δημιουργήσουμε υπολογίζονται ανά φωτογραφική παρουσίαση.`,{class:'field-help'}));
        const photos=make('div',undefined,{class:'product-photos'});
        for(const id of product.photos??[]){
          const asset=materials.assets.find(item=>item.id===id);if(!asset)continue;
          const figure=make('figure'),image=make('img',undefined,{src:asset.url,alt:asset.name,loading:'lazy'}),removePhoto=make('button','Αφαίρεση',{type:'button',class:'secondary small'});
          removePhoto.addEventListener('click',()=>{card.dataset.photos=JSON.stringify(JSON.parse(card.dataset.photos).filter(photo=>photo!==id));figure.remove();card.catalogEditor.refreshPhotos();changed();updateTotals();const panel=card.querySelector('.legacy-photo-review'),button=make('button','Έλεγχος φωτογραφιών αυτού του προϊόντος',{type:'button',class:'secondary'});button.addEventListener('click',()=>action('review',product.id));panel.replaceChildren(make('p','Οι φωτογραφίες άλλαξαν. Θα ελέγξουμε τη νέα επιλογή πριν δημιουργήσουμε εικόνες.',{class:'field-help'}),button);});
          figure.append(image,make('figcaption',asset.name),removePhoto);photos.append(figure);
        }
        photoGroup.append(photos);
        input.addEventListener('change',()=>{if(input.files.length)action('upload',product.id,[...input.files]);});
        card.append(photoGroup);
        const review=materials.reviews[product.id],panel=make('div',undefined,{class:'photo-review legacy-photo-review'});panel.hidden=Boolean(product.variants);
        const reviewButton=make('button','Έλεγχος φωτογραφιών αυτού του προϊόντος',{type:'button',class:'secondary'});
        reviewButton.addEventListener('click',()=>action('review',product.id));
        if(!review)panel.append(make('p','Πριν δημιουργήσουμε νέες εικόνες, θα ελέγξουμε αν οι φωτογραφίες δίνουν μια συνεπή εικόνα του ίδιου προϊόντος.',{class:'field-help'}),reviewButton);
        else if(review.status==='awaiting_review')panel.append(make('strong','Οι φωτογραφίες σου περιμένουν έλεγχο'),make('p','Το αίτημα αποθηκεύτηκε για επεξεργασία στη δοκιμή Pro.',{class:'field-help'}));
        else if(review.status==='replacement_required')panel.append(make('strong','Ας δώσουμε στο προϊόν σου μια πιο καθαρή αφετηρία.'),make('p','Κάποιες φωτογραφίες αφήνουν αμφιβολία για το αν δείχνουν το ίδιο προϊόν. Αντικατάστησέ τες με λήψεις που δείχνουν καθαρά το ίδιο αντικείμενο και ζήτησε νέο έλεγχο. Οι σωστές λεπτομέρειες μάς βοηθούν να δημιουργήσουμε εικόνες πιο κοντά στο πραγματικό προϊόν.',{class:'field-help'}),reviewButton);
        else if(review.status==='awaiting_confirmation'){
          panel.append(make('strong','Μια τελευταία επιβεβαίωση πριν προχωρήσουμε.'),make('p','Οι νέες φωτογραφίες εξακολουθούν να αφήνουν μια μικρή αμφιβολία. Αφορούν όλες το ίδιο προϊόν; Η πιστότητα των εικόνων που θα δημιουργήσουμε εξαρτάται από την καθαρότητα και τη συνέπεια των φωτογραφιών που μας δίνεις.',{class:'field-help'}));
          const choice=make('label',undefined,{class:'copy-choice'}),check=make('input',undefined,{type:'checkbox'}),button=make('button','Επιβεβαίωση φωτογραφιών',{type:'button'});button.disabled=true;
          choice.append(check,make('span','Επιβεβαιώνω ότι όλες οι φωτογραφίες αφορούν το ίδιο προϊόν.'));check.addEventListener('change',()=>{button.disabled=!check.checked;});
          button.addEventListener('click',()=>{if(check.checked)action('confirm',product.id,review);});panel.append(choice,button);
        }else panel.append(make('strong',review.status==='confirmed'?'Η επιβεβαίωσή σου καταγράφηκε.':'Ο έλεγχος φωτογραφιών ολοκληρώθηκε.'),make('p',review.status==='confirmed'?'Θα βασιστούμε σε αυτές τις φωτογραφίες. Οι καθαρές λήψεις παραμένουν η βάση για πιστή παρουσίαση.':'Οι φωτογραφίες δίνουν μια συνεπή εικόνα του προϊόντος.',{class:'field-help'}));
        card.append(panel);
        card.append(make('div',undefined,{class:'catalog-product-summary','aria-live':'polite'}));
        const actions=make('div',undefined,{class:'actions product-actions'});
        for(const [name,label]of [['productSkip','Για αργότερα'],['productSave','Αποθήκευση προϊόντος'],['productSubmit','Οριστική υποβολή προϊόντος']]){
          const button=make('button',label,{type:'button',class:name==='productSubmit'?'':'secondary','data-product-action':name});button.addEventListener('click',()=>action(name,product.id));actions.append(button);
        }
        card.append(make('p','Υπέβαλε αυτό το προϊόν όταν είσαι έτοιμος. Ξεκινά ανεξάρτητα από τα υπόλοιπα, μόλις είναι έτοιμες οι απαραίτητες επιλογές παρουσίασης.',{class:'field-help'}),actions);section.append(card);
      });
      const add=make('button','+ Προσθήκη προϊόντος',{type:'button',class:'secondary'});add.disabled=products.length>=materials.productLimit;
      add.addEventListener('click',()=>{products=[...read(),empty()];section.querySelectorAll('.product-card').forEach(node=>node.remove());changed();cards();});
      section.append(add,make('p','Η επιλογή μιας ήδη αποθηκευμένης εκδοχής δεν δημιουργεί νέο κείμενο και δεν χρησιμοποιεί επιπλέον AI credits. Η δοκιμή Pro εκτελείται με χειρισμό της συνεδρίας μας.',{class:'field-help'}));
      updateTotals();
    }
    function updateTotals(){
      const cards=[...section.querySelectorAll('.product-card')],items=cards.map(card=>card.dataset.locked==='true'?JSON.parse(card.dataset.original):({id:card.dataset.id,photos:JSON.parse(card.dataset.photos),...card.catalogEditor?.read()})),perUnit=materials.photosPerUnit??(materials.productLimit===25?5:3),counts=MolyviCatalog.summary(items,perUnit),totals=section.querySelector('.catalog-totals');
      if(totals){totals.replaceChildren(make('strong','Η συλλογή σου μέχρι τώρα'),make('p',`${plural(counts.catalogProducts,'καταχώριση','καταχωρίσεις')} · ${plural(counts.variants,'επιλογή αγοράς','επιλογές αγοράς')} · ${counts.visualUnits}/${materials.productLimit} φωτογραφικές παρουσιάσεις · ${counts.initialPhotoSlots} αρχικές εικόνες`));if(counts.visualUnits>materials.productLimit)totals.append(make('p','Οι παρουσιάσεις ξεπερνούν το πακέτο σου. Προσάρμοσε την επιλογή σου πριν από την αποθήκευση ή την οριστική υποβολή.',{class:'catalog-warning'}));}
      cards.forEach((card,index)=>{const panel=card.querySelector('.catalog-product-summary');if(!panel)return;const count=MolyviCatalog.summary([items[index]],perUnit),issues=MolyviCatalog.problems(items[index]);panel.replaceChildren(make('strong','Πριν από την οριστική υποβολή'),make('p',`${plural(count.variants,'επιλογή αγοράς','επιλογές αγοράς')} → ${plural(count.visualUnits,'φωτογραφική παρουσίαση','φωτογραφικές παρουσιάσεις')} → ${count.initialPhotoSlots} αρχικές εικόνες`,{class:'field-help'}));if(issues.length){const list=make('ul',undefined,{class:'catalog-warning'});issues.forEach(message=>list.append(make('li',message)));panel.append(list);}const submit=card.querySelector('[data-product-action="productSubmit"]');if(submit){submit.disabled=issues.length>0||counts.visualUnits>materials.productLimit;submit.title=submit.disabled?'Συμπλήρωσε τις εκκρεμότητες που εμφανίζονται παραπάνω.':'';}});
    }
    section.addEventListener('input',updateTotals);section.addEventListener('change',updateTotals);
    cards();return section;
  }
  return {render,read,summary:(products,options={})=>MolyviCatalog.summary(products,options.photosPerUnit??3)};
})();
