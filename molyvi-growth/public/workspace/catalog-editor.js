'use strict';
window.MolyviCatalog=(()=>{
  const make=(tag,text,attrs={})=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;for(const [key,value] of Object.entries(attrs))node.setAttribute(key,value);return node;};
  const uuid=()=>crypto.randomUUID(), text=value=>value??'', normal=value=>text(value).trim().toLocaleLowerCase('el');
  const money=value=>value===''?null:/^\d+(?:\.\d{1,2})?$/.test(value)?Math.round(Number(value)*100):NaN, integer=value=>value===''?null:Number(value);
  const newVariant=()=>({id:uuid(),sku:null,color:null,size:null,priceMinor:null,stock:null,weightGrams:null});
  const newUnit=()=>({id:uuid(),color:null,variantIds:[],sourceAssetIds:[],representationNote:''});
  function initial(){const variant=newVariant(),unit=newUnit();unit.variantIds=[variant.id];return {category:'',facts:[],variants:[variant],visualUnits:[unit]};}
  function summary(products,photosPerUnit=3){return products.reduce((total,product)=>{total.catalogProducts++;total.variants+=product.variants?.length??1;total.visualUnits+=product.visualUnits?.length??1;total.initialPhotoSlots+=(product.visualUnits?.length??1)*photosPerUnit;return total;},{catalogProducts:0,variants:0,visualUnits:0,initialPhotoSlots:0});}
  function problems(product){
    if(!Array.isArray(product.variants))return [];
    const messages=[],variants=product.variants,units=product.visualUnits??[],assigned=new Map();
    if(!variants.length)messages.push('Πρόσθεσε τουλάχιστον μία επιλογή αγοράς.');
    if(!units.length)messages.push('Πρόσθεσε τουλάχιστον μία φωτογραφική παρουσίαση.');
    if(variants.some(variant=>variant.priceMinor===null||variant.stock===null))messages.push('Συμπλήρωσε τιμή και απόθεμα για κάθε επιλογή αγοράς.');
    if(variants.some(variant=>variant.priceMinor!==null&&(!Number.isSafeInteger(variant.priceMinor)||variant.priceMinor<0)||variant.stock!==null&&(!Number.isSafeInteger(variant.stock)||variant.stock<0)||variant.weightGrams!==null&&(!Number.isSafeInteger(variant.weightGrams)||variant.weightGrams<0)))messages.push('Οι τιμές χρειάζονται έως δύο δεκαδικά και το απόθεμα και βάρος ολόκληρους θετικούς αριθμούς ή μηδέν.');
    units.forEach((unit,index)=>{
      if(!unit.variantIds.length)messages.push(`Στην παρουσίαση ${index+1}, διάλεξε ποια μεγέθη ή επιλογές αφορά.`);
      if(!unit.sourceAssetIds.length)messages.push(`Στην παρουσίαση ${index+1}, διάλεξε τουλάχιστον μία αρχική φωτογραφία.`);
      for(const id of unit.variantIds){assigned.set(id,(assigned.get(id)??0)+1);const variant=variants.find(value=>value.id===id);if(!variant||normal(variant.color)!==normal(unit.color)){messages.push(`Στην παρουσίαση ${index+1}, το χρώμα πρέπει να συμφωνεί με τις επιλογές που συνδέεις.`);break;}}
    });
    if(variants.some(variant=>assigned.get(variant.id)!==1))messages.push('Σύνδεσε κάθε επιλογή αγοράς με μία μόνο φωτογραφική παρουσίαση.');
    return [...new Set(messages)];
  }
  function reviewPanel(review,unit,productId,action){
    const panel=make('div',undefined,{class:'photo-review'}),button=make('button','Έλεγχος αυτών των φωτογραφιών',{type:'button',class:'secondary small'});
    button.disabled=!unit.sourceAssetIds.length;button.addEventListener('click',()=>action('review',productId,{visualUnitId:unit.id}));
    if(!review)panel.append(make('p','Θα ελέγξουμε αν αυτές οι λήψεις δείχνουν το ίδιο προϊόν, στο συγκεκριμένο χρώμα και τρόπο παρουσίασης.',{class:'field-help'}),button);
    else if(review.status==='awaiting_review')panel.append(make('strong','Οι φωτογραφίες περιμένουν έλεγχο'),make('p','Το αίτημα αποθηκεύτηκε για τη δοκιμή Pro.',{class:'field-help'}));
    else if(review.status==='replacement_required')panel.append(make('strong','Ας δώσουμε στο προϊόν σου μια πιο καθαρή αφετηρία.'),make('p','Κάποιες λήψεις αφήνουν αμφιβολία για το προϊόν ή το χρώμα. Διάλεξε καθαρότερες φωτογραφίες της ίδιας επιλογής και ζήτησε νέο έλεγχο.',{class:'field-help'}),button);
    else if(review.status==='awaiting_confirmation'){
      panel.append(make('strong','Μια τελευταία επιβεβαίωση πριν προχωρήσουμε.'),make('p','Οι νέες λήψεις αφήνουν ακόμη μια αμφιβολία. Η πιστότητα της εικόνας ξεκινά από τις καθαρές λεπτομέρειες που μοιράζεσαι μαζί μας.',{class:'field-help'}));
      const choice=make('label',undefined,{class:'copy-choice'}),check=make('input',undefined,{type:'checkbox'}),confirm=make('button','Επιβεβαίωση φωτογραφιών',{type:'button',class:'small'});confirm.disabled=true;
      choice.append(check,make('span','Επιβεβαιώνω ότι αυτές οι φωτογραφίες δείχνουν το ίδιο προϊόν, χρώμα και παρουσίαση.'));check.addEventListener('change',()=>{confirm.disabled=!check.checked;});confirm.addEventListener('click',()=>{if(check.checked)action('confirm',productId,{...review,visualUnitId:unit.id});});panel.append(choice,confirm);
    }else if(['matched','confirmed'].includes(review.status))panel.append(make('strong',review.status==='confirmed'?'Η επιβεβαίωσή σου καταγράφηκε.':'Ο έλεγχος αυτής της παρουσίασης ολοκληρώθηκε.'),make('p','Οι φωτογραφίες συνδέονται μόνο με τις επιλογές που όρισες εδώ.',{class:'field-help'}));
    else panel.append(make('strong','Χρειαζόμαστε πιο καθαρές φωτογραφίες.'),make('p','Αντικατάστησε τις λήψεις που δεν διαβάζονται καθαρά και ζήτησε νέο έλεγχο.',{class:'field-help'}),button);
    return panel;
  }
  function render(product,{materials,action,changed}){
    const root=make('div',undefined,{class:'catalog-editor'});let data=structuredClone(product),variantInputs=[],unitInputs=[],dirtyUnits=new Set();
    const metadata=make('div',undefined,{class:'catalog-metadata'}),categoryId=`category-${product.id}`,category=make('select',undefined,{id:categoryId}),custom=make('input',undefined,{type:'text',maxlength:'300','aria-label':'Η δική σου κατηγορία προϊόντος'});
    const categories=['Κοσμήματα','Ένδυση','Αντικείμενα σπιτιού','Αξεσουάρ'];category.append(make('option','Επίλεξε κατηγορία',{value:''}));for(const value of categories)category.append(make('option',value,{value}));category.append(make('option','Άλλο',{value:'__other'}));
    category.value=categories.includes(data.category)?data.category:data.category?'__other':'';custom.value=category.value==='__other'?data.category:'';custom.hidden=category.value!=='__other';category.addEventListener('change',()=>{custom.hidden=category.value!=='__other';changed();});
    metadata.append(make('label','Κατηγορία προϊόντος',{for:categoryId}),category,custom,make('p','Η σωστή κατηγορία μάς βοηθά να μιλήσουμε τη γλώσσα του προϊόντος σου.',{class:'field-help'}));
    const factsId=`facts-${product.id}`,facts=make('textarea',undefined,{id:factsId,rows:'4',placeholder:'Υλικό: ασήμι 925\nΔιάμετρος: 18 χιλιοστά'});facts.value=(data.facts??[]).join('\n');
    metadata.append(make('label','Οι λεπτομέρειες που πρέπει να γνωρίζουμε',{for:factsId}),facts,make('p','Γράψε ένα επιβεβαιωμένο χαρακτηριστικό σε κάθε γραμμή: υλικά, διαστάσεις, φινίρισμα ή χρήση. Οι συγκεκριμένες πληροφορίες δίνουν στα κείμενα και στις εικόνες μεγαλύτερη ακρίβεια.',{class:'field-help'}));root.append(metadata);
    const detail=make('div',undefined,{class:'catalog-detail'});root.append(detail);
    function read(){
      const result={category:category.value==='__other'?custom.value:category.value,facts:facts.value.split(/\r?\n/).map(value=>value.trim()).filter(Boolean)};
      if(!Array.isArray(data.variants))return result;
      result.variants=variantInputs.map(({variant,inputs})=>({...variant,sku:inputs.sku.value||null,color:inputs.color.value||null,size:inputs.size.value||null,priceMinor:money(inputs.priceMinor.value),stock:integer(inputs.stock.value),weightGrams:integer(inputs.weightGrams.value)}));
      result.visualUnits=unitInputs.map(({unit,color,note,variantChoices,photoChoices})=>({...unit,color:color.value||null,representationNote:note.value,variantIds:variantChoices.filter(input=>input.checked).map(input=>input.value),sourceAssetIds:photoChoices.filter(input=>input.checked).map(input=>input.value)}));
      return result;
    }
    function snapshot(){data={...data,...read()};}
    function draw(){
      detail.replaceChildren();variantInputs=[];unitInputs=[];
      if(!Array.isArray(data.variants)){
        const convert=make('button','Πρόσθεσε μεγέθη, χρώματα ή ξεχωριστή παρουσίαση',{type:'button',class:'secondary'});
        convert.addEventListener('click',()=>{snapshot();const card=root.closest('.product-card'),variant=newVariant(),unit=newUnit();variant.priceMinor=money(card.querySelector('[data-field="price"]').value);variant.stock=integer(card.querySelector('[data-field="stock"]').value);unit.variantIds=[variant.id];unit.sourceAssetIds=JSON.parse(card.dataset.photos);data.variants=[variant];data.visualUnits=[unit];draw();root.dispatchEvent(new Event('catalogmodechange',{bubbles:true}));changed();});
        detail.append(convert,make('p','Το ήδη αποθηκευμένο προϊόν παραμένει όπως είναι. Πρόσθεσε επιλογές μόνο αν τις χρειάζεσαι.',{class:'field-help'}));return;
      }
      detail.append(make('h4','Κάθε επιλογή, στη σωστή θέση.'),make('p','Δώσε ξεχωριστή γραμμή για κάθε συνδυασμό μεγέθους και χρώματος που θα μπορεί να αγοράσει ο πελάτης σου. Απλά μεγέθη του ίδιου χρώματος μπορούν να μοιράζονται τις ίδιες φωτογραφίες.',{class:'field-help'}));
      const variants=make('div',undefined,{class:'catalog-variants'});
      data.variants.forEach((variant,index)=>{
        const row=make('fieldset',undefined,{class:'catalog-variant'}),inputs={};row.append(make('legend',`Επιλογή αγοράς ${index+1}`));
        for(const [key,label,kind] of [['sku','Κωδικός προϊόντος','text'],['color','Χρώμα','text'],['size','Μέγεθος','text'],['priceMinor','Τιμή σε ευρώ *','number'],['stock','Απόθεμα *','number'],['weightGrams','Βάρος σε γραμμάρια','number']]){
          const id=`variant-${variant.id}-${key}`,group=make('div',undefined,{class:'field'}),input=make('input',undefined,{id,type:kind});input.value=key==='priceMinor'&&variant[key]!==null?variant[key]/100:text(variant[key]);
          if(kind==='number'){input.min='0';input.step=key==='priceMinor'?'.01':'1';}else input.maxLength=300;
          group.append(make('label',label,{for:id}),input);row.append(group);inputs[key]=input;
          if(['color','size','sku'].includes(key))input.addEventListener('change',()=>{const previous=variant.color;snapshot();if(key==='color'){const updated=data.variants.find(item=>item.id===variant.id);for(const unit of data.visualUnits){if(unit.variantIds.includes(variant.id)&&normal(unit.color)===normal(previous)&&unit.variantIds.every(id=>normal(data.variants.find(item=>item.id===id)?.color)===normal(updated.color))){unit.color=updated.color;dirtyUnits.add(unit.id);}}}draw();changed();});
        }
        const remove=make('button','Αφαίρεση επιλογής',{type:'button',class:'secondary small'});remove.addEventListener('click',()=>{snapshot();data.variants=data.variants.filter(item=>item.id!==variant.id);for(const unit of data.visualUnits){unit.variantIds=unit.variantIds.filter(id=>id!==variant.id);dirtyUnits.add(unit.id);}draw();changed();});row.append(remove);variants.append(row);variantInputs.push({variant,inputs});
      });detail.append(variants);
      const addVariant=make('button','+ Μέγεθος ή χρώμα',{type:'button',class:'secondary'});addVariant.addEventListener('click',()=>{snapshot();data.variants.push(newVariant());draw();changed();});detail.append(addVariant);
      detail.append(make('h4','Οι φωτογραφίες που μοιράζονται οι επιλογές σου.'),make('p','Κάθε διαφορετικό χρώμα χρειάζεται τη δική του παρουσίαση και μετρά χωριστά στο πακέτο. Το ίδιο ισχύει αν χρειάζεται διαφορετικό πρόσωπο ή διαφορετική απεικόνιση, όπως ανδρικό και παιδικό. Τα μεγέθη που χρησιμοποιούν τις ίδιες φωτογραφίες μετρούν μία φορά.',{class:'field-help'}));
      const photos=JSON.parse(root.closest('.product-card')?.dataset.photos??JSON.stringify(product.photos??[]));
      data.visualUnits.forEach((unit,index)=>{
        const group=make('fieldset',undefined,{class:'catalog-unit'});group.append(make('legend',`Φωτογραφική παρουσίαση ${index+1}`));
        const colorId=`unit-${unit.id}-color`,color=make('input',undefined,{id:colorId,type:'text',maxlength:'300'});color.value=text(unit.color);
        group.append(make('label','Χρώμα αυτής της παρουσίασης',{for:colorId}),color,make('p','Γράψε το ίδιο χρώμα με τις επιλογές που συνδέεις παρακάτω. Αν δεν υπάρχει χρώμα ως επιλογή, άφησέ το κενό και στα δύο σημεία.',{class:'field-help'}));
        const noteId=`unit-${unit.id}-note`,note=make('textarea',undefined,{id:noteId,rows:'2',maxlength:'8000'});note.value=unit.representationNote??'';
        group.append(make('label','Κάτι που πρέπει να φαίνεται διαφορετικά;',{for:noteId}),note,make('p','Για παράδειγμα: παιδικό μέγεθος φορεμένο σε παιδικό μοντέλο. Οι σαφείς οδηγίες μάς βοηθούν να επιλέξουμε τη σωστή παρουσίαση.',{class:'field-help'}));
        const variantChoices=[],choices=make('div',undefined,{class:'choices'});group.append(make('p','Αυτές οι επιλογές θα χρησιμοποιούν τις ίδιες φωτογραφίες:',{class:'catalog-choice-title'}));
        data.variants.forEach((variant,position)=>{const label=make('label',undefined,{class:'choice'}),input=make('input',undefined,{type:'checkbox',value:variant.id});input.checked=unit.variantIds.includes(variant.id);variantChoices.push(input);label.append(input,make('span',[variant.color,variant.size,variant.sku].filter(Boolean).join(' · ')||`Επιλογή ${position+1}`));choices.append(label);});group.append(choices);
        group.append(make('p','Διάλεξε τις αρχικές φωτογραφίες γι’ αυτή την παρουσίαση:',{class:'catalog-choice-title'}));
        const photoChoices=[],photoList=make('div',undefined,{class:'catalog-source-choices'});
        for(const id of photos){const asset=materials.assets.find(item=>item.id===id);if(!asset)continue;const label=make('label',undefined,{class:'catalog-source-choice'}),input=make('input',undefined,{type:'checkbox',value:id});input.checked=unit.sourceAssetIds.includes(id);photoChoices.push(input);label.append(make('img',undefined,{src:asset.url,alt:asset.name,loading:'lazy'}),input,make('span',asset.name));photoList.append(label);}
        if(!photoChoices.length)photoList.append(make('p','Ανέβασε πρώτα τις φωτογραφίες του προϊόντος από το πεδίο που ακολουθεί. Μετά θα εμφανιστούν εδώ για να τις συνδέσεις.',{class:'field-help'}));group.append(photoList);
        const existingReview=materials.unitReviews?.[product.id]?.[unit.id];const panel=reviewPanel(dirtyUnits.has(unit.id)?null:existingReview,unit,product.id,action);group.append(panel);
        const invalidate=()=>{dirtyUnits.add(unit.id);snapshot();const replacement=reviewPanel(null,data.visualUnits.find(item=>item.id===unit.id),product.id,action);replacement.prepend(make('p','Η επιλογή άλλαξε. Θα ελέγξουμε τα τωρινά στοιχεία πριν από τη δημιουργία εικόνων.',{class:'field-help'}));group.querySelector('.photo-review')?.replaceWith(replacement);changed();};
        for(const input of [color,note,...variantChoices,...photoChoices])input.addEventListener('change',invalidate);
        const remove=make('button','Αφαίρεση παρουσίασης',{type:'button',class:'secondary small'});remove.addEventListener('click',()=>{snapshot();data.visualUnits=data.visualUnits.filter(item=>item.id!==unit.id);draw();changed();});group.append(remove);detail.append(group);unitInputs.push({unit,color,note,variantChoices,photoChoices});
      });
      const addUnit=make('button','+ Ξεχωριστό χρώμα ή παρουσίαση',{type:'button',class:'secondary'});addUnit.addEventListener('click',()=>{snapshot();data.visualUnits.push(newUnit());draw();changed();});detail.append(addUnit);
    }
    draw();root.addEventListener('input',changed);return {node:root,read,structured:()=>Array.isArray(data.variants),refreshPhotos(){snapshot();const available=JSON.parse(root.closest('.product-card')?.dataset.photos??'[]');for(const unit of data.visualUnits??[]){const before=unit.sourceAssetIds.length;unit.sourceAssetIds=unit.sourceAssetIds.filter(id=>available.includes(id));if(before!==unit.sourceAssetIds.length)dirtyUnits.add(unit.id);}draw();}};
  }
  return {initial,summary,problems,render};
})();
