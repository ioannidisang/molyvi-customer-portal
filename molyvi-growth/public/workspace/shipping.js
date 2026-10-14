'use strict';
window.MolyviShipping=(()=>{
  const make=(tag,text,attrs={})=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;for(const [key,value] of Object.entries(attrs))node.setAttribute(key,value);return node;};
  const modes={flat:'Σταθερή χρέωση ανά παραγγελία',free_from_amount:'Δωρεάν από ένα ποσό αγορών',always_free:'Πάντα δωρεάν',weight_increment:'Χρέωση ανά βάρος',other:'Άλλο'};
  const decimal=(value,places)=>{
    const raw=String(value??'').trim();if(!raw)return null;
    const normal=raw.replace(',','.');if(!new RegExp(`^\\d+(?:\\.\\d{1,${places}})?$`).test(normal))return raw;
    const [whole,fraction='']=normal.split('.');if(whole.length>16)return raw;
    const parsed=BigInt(whole)*10n**BigInt(places)+BigInt(fraction.padEnd(places,'0'));
    return parsed<=BigInt(Number.MAX_SAFE_INTEGER)?Number(parsed):raw;
  };
  const integer=value=>{const raw=String(value??'').trim();return !raw?null:/^\d+$/.test(raw)&&Number.isSafeInteger(Number(raw))?Number(raw):raw;};
  const shown=(value,places)=>value===null||value===undefined?'':typeof value==='number'?String(value/10**places).replace('.',','):String(value);
  const amount=value=>Number.isSafeInteger(value)?new Intl.NumberFormat('el-GR',{style:'currency',currency:'EUR'}).format(value/100):'ποσό προς συμπλήρωση';
  const weight=value=>Number.isSafeInteger(value)?`${new Intl.NumberFormat('el-GR',{maximumFractionDigits:3}).format(value/1000)} κιλά`:'βάρος προς συμπλήρωση';
  const newZone=()=>({id:crypto.randomUUID(),label:'',countries:[],mode:null,basePriceMinor:null,initialWeightGrams:null,incrementWeightGrams:null,incrementPriceMinor:null,incrementMode:null,freeFromAmountMinor:null,freeMaxWeightGrams:null,other:''});
  function summary(plan,policy={}){
    if(!plan)return ['Δεν έχουν συμπληρωθεί κανόνες αποστολής.'];
    const countries=new Map((policy.countries??[]).map(item=>[item.code,item.name])),lines=[];
    for(const [index,zone] of (plan.zones??[]).entries()){
      const names=(zone.countries??[]).filter(Boolean).map(code=>countries.get(code)??code).join(', ')||'χώρα προς επιλογή';
      const prefix=`${zone.label||`Ζώνη ${index+1}`} · ${names}: `;let rule='τρόπος χρέωσης προς επιλογή';
      if(zone.mode==='flat')rule=`${amount(zone.basePriceMinor)} ανά παραγγελία`;
      if(zone.mode==='free_from_amount')rule=`${amount(zone.basePriceMinor)} ανά παραγγελία, δωρεάν για αγορές από ${amount(zone.freeFromAmountMinor)}`;
      if(zone.mode==='always_free')rule='δωρεάν αποστολή';
      if(zone.mode==='weight_increment'){
        const interval=zone.incrementMode==='complete_interval'?'πλήρες':zone.incrementMode==='started_interval'?'ξεκινημένο':'διάστημα προς επιλογή —';
        rule=`${amount(zone.basePriceMinor)} έως ${weight(zone.initialWeightGrams)}, συν ${amount(zone.incrementPriceMinor)} για κάθε ${interval} πρόσθετο διάστημα ${weight(zone.incrementWeightGrams)}`;
        if(zone.freeFromAmountMinor!==null&&zone.freeFromAmountMinor!==undefined)rule+=`, δωρεάν για αγορές από ${amount(zone.freeFromAmountMinor)}`;
      }
      if(['free_from_amount','weight_increment'].includes(zone.mode)&&zone.freeFromAmountMinor!==null&&zone.freeFromAmountMinor!==undefined&&zone.freeMaxWeightGrams!==null&&zone.freeMaxWeightGrams!==undefined)rule+=` και έως ${weight(zone.freeMaxWeightGrams)} συνολικά· πάνω από αυτό ισχύει η κανονική χρέωση της ζώνης`;
      if(zone.mode==='other')rule=`άλλος τρόπος, προς αξιολόγηση${zone.other?` — ${zone.other}`:''}`;
      lines.push(prefix+rule+'.');
    }
    const usesWeight=(plan.zones??[]).some(zone=>zone.mode==='weight_increment'||zone.mode==='free_from_amount'&&zone.freeMaxWeightGrams!==null&&zone.freeMaxWeightGrams!==undefined);
    if(usesWeight)lines.push(`Βάρος συσκευασίας: ${weight(plan.packageWeightGrams)}.`);
    for(const [key,label] of [['preparationTime','Προετοιμασία'],['transitTime','Μεταφορά']]){
      const time=plan[key];
      if(!time)lines.push(`${label}: δεν έχει δοθεί εκτίμηση χρόνου.`);
      else lines.push(`${label}: ${time.minDays??'…'}–${time.maxDays??'…'} ${time.dayType==='business'?'εργάσιμες':time.dayType==='calendar'?'ημερολογιακές':'ημέρες προς προσδιορισμό —'} ημέρες.`);
    }
    if(plan.pickupRequested===true)lines.push('Ζητήθηκε παραλαβή από ένα φυσικό σημείο· ακολουθεί έλεγχος και ρύθμιση στο Shopify.');
    if(plan.pickupRequested===false)lines.push('Δεν ζητήθηκε παραλαβή από φυσικό σημείο.');
    return lines;
  }
  function render(value,{policy={},changed=()=>{},onEstimate}={}){
    const data=value?structuredClone(value):{schemaVersion:1,currency:'EUR',packageWeightGrams:null,zones:[newZone()],preparationTime:null,transitTime:null,pickupRequested:null};
    data.zones??=[];const countries=[...(policy.countries??[])].sort((a,b)=>a.name.localeCompare(b.name,'el')),maxZones=policy.destinationZoneCountMax??1,oneCountry=policy.destinationCountryCount===1||maxZones===1;
    const allowedModes=policy.modes??['flat','free_from_amount','always_free'],canWeight=policy.weightIncrementIncluded===true,canCap=policy.freeShippingWeightCapIncluded===true;
    const root=make('div',undefined,{class:'shipping-editor'}),zonesRoot=make('div',undefined,{class:'shipping-zones'}),warnings=make('ul',undefined,{class:'shipping-warnings','aria-live':'polite'}),summaryBox=make('div',undefined,{class:'shipping-plan-summary'});
    const countryControls=[],requiredChoices=[];let updating=false,packageField;
    function read({complete=false}={}){if(complete)for(const validate of requiredChoices){const problem=validate();if(problem)throw new Error(problem);}const result=structuredClone(data);result.zones=result.zones.map(zone=>({...zone,countries:(zone.countries??[]).filter(Boolean),freeMaxWeightGrams:['free_from_amount','weight_increment'].includes(zone.mode)?zone.freeMaxWeightGrams:null}));return result;}
    function selection(options,value,label){const input=make('select',undefined,{'aria-label':label});input.append(make('option','Επίλεξε…',{value:''}));for(const [key,text] of options)input.append(make('option',text,{value:key}));if(value&&!options.some(([key])=>key===value))input.append(make('option',`${value} — προς έλεγχο`,{value}));input.value=value??'';return input;}
    function field(label,input,help){const node=make('label',undefined,{class:'field'});node.append(make('span',label),input);if(help)node.append(make('span',help,{class:'field-help'}));return node;}
    function numberField(label,target,key,places,help,update=refresh){
      const input=make('input',undefined,{type:'text',inputmode:places?'decimal':'numeric',autocomplete:'off','aria-label':label});input.value=shown(target[key],places);
      input.addEventListener('input',()=>{target[key]=places?decimal(input.value,places):integer(input.value);input.setCustomValidity(typeof target[key]==='string'?places===2?'Γράψε μη αρνητικό ποσό με έως δύο δεκαδικά.':places===3?'Γράψε μη αρνητικό βάρος με έως τρία δεκαδικά.':'Γράψε ολόκληρο μη αρνητικό αριθμό.':'');update();});
      return {node:field(label,input,help),input};
    }
    function checkbox(label,checked){const node=make('label',undefined,{class:'shipping-check'}),input=make('input',undefined,{type:'checkbox'});input.checked=checked;node.append(input,make('span',label));return {node,input};}
    function refresh(notify=true){
      if(updating)return;
      const plan=read(),messages=[],seen=new Set();
      for(const zone of plan.zones){for(const code of zone.countries){if(seen.has(code))messages.push('Κράτησε κάθε χώρα σε μία μόνο ζώνη, ώστε η χρέωσή της να είναι ξεκάθαρη.');seen.add(code);}if(zone.mode==='other')messages.push('Η επιλογή «Άλλο» αποθηκεύεται για αξιολόγηση. Θα τη διευκρινίσουμε πριν από την οριστική υποβολή.');}
      for(const key of ['preparationTime','transitTime']){const time=plan[key];if(time&&Number.isInteger(time.minDays)&&Number.isInteger(time.maxDays)&&time.minDays>time.maxDays)messages.push('Στις εκτιμήσεις χρόνου, η δεύτερη τιμή πρέπει να είναι ίση ή μεγαλύτερη από την πρώτη.');}
      for(const {input,zone,index} of countryControls){for(const option of input.options){option.disabled=Boolean(option.value&&option.value!==input.value&&data.zones.some(item=>(item.countries??[]).some((code,i)=>code===option.value&&(item!==zone||i!==index))));}}
      warnings.replaceChildren(...[...new Set(messages)].map(message=>make('li',message)));warnings.hidden=!messages.length;
      summaryBox.replaceChildren(make('strong','Οι επιλογές σου, με μια ματιά'),make('ul'));summaryBox.lastChild.append(...summary(plan,policy).map(line=>make('li',line)));
      if(packageField)packageField.hidden=!canWeight&&!canCap||!plan.zones.some(zone=>zone.mode==='weight_increment'||zone.mode==='free_from_amount'&&zone.freeMaxWeightGrams!==null&&zone.freeMaxWeightGrams!==undefined);
      if(notify)changed();
    }
    function renderZones(){
      updating=true;countryControls.length=0;requiredChoices.length=0;zonesRoot.replaceChildren();
      data.zones.forEach((zone,zoneIndex)=>{
        const box=make('fieldset',undefined,{class:'shipping-zone'});box.append(make('legend',oneCountry?'Ο προορισμός σου':`Ζώνη ${zoneIndex+1}`));
        if(!oneCountry){const label=make('input',undefined,{type:'text',maxlength:'120','aria-label':`Όνομα ζώνης ${zoneIndex+1}`});label.value=zone.label??'';label.addEventListener('input',()=>{zone.label=label.value;refresh();});box.append(field('Όνομα ζώνης — προαιρετικό',label,'Δώσε ένα όνομα που σε βοηθά να ξεχωρίζεις αυτή την ομάδα χωρών.'));}
        const destinations=make('div',undefined,{class:'shipping-countries'});zone.countries??=[];if(!zone.countries.length)zone.countries.push('');
        zone.countries.forEach((country,index)=>{
          const row=make('div',undefined,{class:'shipping-country-row'}),input=selection(countries.map(item=>[item.code,item.name]),country,oneCountry?'Χώρα αποστολής':`Χώρα ${index+1} · ζώνη ${zoneIndex+1}`);row.append(input);countryControls.push({input,zone,index});
          input.addEventListener('change',()=>{zone.countries[index]=input.value;refresh();});
          if(!oneCountry&&zone.countries.length>1){const remove=make('button','Αφαίρεση',{type:'button',class:'secondary small','aria-label':`Αφαίρεση χώρας ${index+1} από τη ζώνη ${zoneIndex+1}`});remove.addEventListener('click',()=>{zone.countries.splice(index,1);renderZones();refresh();});row.append(remove);}destinations.append(row);
        });
        box.append(make('p',oneCountry?'Σε ποια χώρα θα στέλνεις;':'Ποιες χώρες μοιράζονται αυτόν τον κανόνα;',{class:'field-help'}),destinations);
        if(!oneCountry){const add=make('button','+ Πρόσθεσε χώρα',{type:'button',class:'secondary small shipping-add'});add.addEventListener('click',()=>{zone.countries.push('');renderZones();refresh();});box.append(add);}
        const mode=selection([...allowedModes,'other'].filter((item,index,list)=>list.indexOf(item)===index).map(key=>[key,modes[key]??key]),zone.mode,`Τρόπος χρέωσης · ζώνη ${zoneIndex+1}`),rateRoot=make('div',undefined,{class:'shipping-rate-fields'});
        box.append(field('Πώς θέλεις να χρεώνεται η αποστολή;',mode,'Οι δικές σου τιμές γίνονται ένας ξεκάθαρος κανόνας για κάθε παραγγελία.'));
        const base=numberField('Χρέωση αποστολής (€)',zone,'basePriceMinor',2),initial=numberField('Η αρχική χρέωση καλύπτει έως (κιλά)',zone,'initialWeightGrams',3),increment=numberField('Πρόσθετο διάστημα βάρους (κιλά)',zone,'incrementWeightGrams',3),extra=numberField('Πρόσθετη χρέωση ανά διάστημα (€)',zone,'incrementPriceMinor',2),threshold=numberField('Δωρεάν για αγορές από (€)',zone,'freeFromAmountMinor',2),cap=numberField('Δωρεάν αποστολή έως συνολικό βάρος (κιλά)',zone,'freeMaxWeightGrams',3);
        const weightGrid=make('div',undefined,{class:'shipping-grid'});weightGrid.append(initial.node,increment.node,extra.node);
        const rounding=selection([['complete_interval','Για κάθε πλήρες πρόσθετο διάστημα'],['started_interval','Για κάθε ξεκινημένο πρόσθετο διάστημα']],zone.incrementMode,`Τρόπος προσαύξησης · ζώνη ${zoneIndex+1}`),roundingField=field('Πότε προστίθεται η επόμενη χρέωση;',rounding,'Πλήρες: η αύξηση εφαρμόζεται μόλις συμπληρωθεί όλο το πρόσθετο διάστημα. Ξεκινημένο: εφαρμόζεται μόλις αρχίσει το επόμενο διάστημα.');
        rounding.addEventListener('change',()=>{zone.incrementMode=rounding.value||null;refresh();});weightGrid.append(roundingField);
        const freeCheck=checkbox('Θέλω και δωρεάν αποστολή από ένα ποσό αγορών',zone.freeFromAmountMinor!==null&&zone.freeFromAmountMinor!==undefined),capCheck=checkbox('Θέλω όριο βάρους για τη δωρεάν αποστολή',zone.freeMaxWeightGrams!==null&&zone.freeMaxWeightGrams!==undefined);
        requiredChoices.push(()=>zone.mode==='weight_increment'&&freeCheck.input.checked&&zone.freeFromAmountMinor===null?'Συμπλήρωσε το ποσό από το οποίο προσφέρεις δωρεάν αποστολή ή αφαίρεσε την επιλογή.':canCap&&(zone.mode==='free_from_amount'||zone.mode==='weight_increment'&&freeCheck.input.checked)&&capCheck.input.checked&&zone.freeMaxWeightGrams===null?'Συμπλήρωσε το όριο βάρους για τη δωρεάν αποστολή ή αφαίρεσε την επιλογή.':null);
        const capGroup=make('div',undefined,{class:'shipping-advanced'});capGroup.append(capCheck.node,cap.node,make('p','Το συνολικό βάρος περιλαμβάνει προϊόντα και συσκευασία. Πάνω από το όριο ισχύει η κανονική χρέωση αυτής της ζώνης.',{class:'field-help'}));
        const other=make('textarea',undefined,{maxlength:'4000','aria-label':`Ο δικός σου τρόπος αποστολής · ζώνη ${zoneIndex+1}`});other.value=zone.other??'';other.addEventListener('input',()=>{zone.other=other.value;refresh();});const otherField=field('Περίγραψε αυτό που χρειάζεσαι',other,'Μερικές σαφείς λεπτομέρειες μάς βοηθούν να αξιολογήσουμε σωστά το αίτημά σου. Η επιλογή αυτή χρειάζεται έλεγχο πριν προχωρήσουμε.');
        const note=make('p',undefined,{class:'shipping-rule-note'});
        function visibility(){
          const isWeight=zone.mode==='weight_increment',hasThreshold=zone.mode==='free_from_amount'||isWeight&&freeCheck.input.checked;
          base.node.hidden=!['flat','free_from_amount','weight_increment'].includes(zone.mode);weightGrid.hidden=!isWeight||!canWeight;
          freeCheck.node.hidden=!isWeight||!canWeight;threshold.node.hidden=!hasThreshold;capGroup.hidden=!hasThreshold||!canCap;cap.node.hidden=!capCheck.input.checked;
          otherField.hidden=zone.mode!=='other';note.hidden=!['always_free','weight_increment'].includes(zone.mode);note.textContent=zone.mode==='always_free'?'Κάθε παραγγελία σε αυτή τη ζώνη θα έχει δωρεάν αποστολή.':zone.mode==='weight_increment'?'Η χρέωση θα βασίζεται στα δηλωμένα βάρη των προϊόντων και της συσκευασίας. Συμπλήρωσέ τα για να προκύπτει σωστά το τελικό βάρος.':'';
        }
        mode.addEventListener('change',()=>{zone.mode=mode.value||null;if(!['free_from_amount','weight_increment'].includes(zone.mode)){zone.freeMaxWeightGrams=null;cap.input.value='';capCheck.input.checked=false;}visibility();refresh();});
        freeCheck.input.addEventListener('change',()=>{if(!freeCheck.input.checked){zone.freeFromAmountMinor=null;threshold.input.value='';zone.freeMaxWeightGrams=null;cap.input.value='';capCheck.input.checked=false;}visibility();refresh();});
        capCheck.input.addEventListener('change',()=>{if(!capCheck.input.checked){zone.freeMaxWeightGrams=null;cap.input.value='';}visibility();refresh();});
        rateRoot.append(base.node,weightGrid,freeCheck.node,threshold.node,capGroup,otherField,note);box.append(rateRoot);
        if(!oneCountry&&data.zones.length>1){const remove=make('button','Αφαίρεση ζώνης',{type:'button',class:'secondary small'});remove.addEventListener('click',()=>{data.zones.splice(zoneIndex,1);renderZones();refresh();});box.append(remove);}visibility();zonesRoot.append(box);
      });
      if(data.zones.length<maxZones){const add=make('button',data.zones.length?'+ Πρόσθεσε ζώνη αποστολής':'+ Πρόσθεσε χώρα αποστολής',{type:'button',class:'secondary shipping-add'});add.addEventListener('click',()=>{data.zones.push(newZone());renderZones();refresh();});zonesRoot.append(add);}
      updating=false;
    }
    root.append(make('p',oneCountry?'Ένας προορισμός. Ο δικός σου τρόπος αποστολής. Διάλεξε τη χώρα και τις χρεώσεις που ταιριάζουν στο κατάστημά σου.':`Χώρες με κοινές χρεώσεις, στην ίδια ζώνη. Οργάνωσε έως ${maxZones} ζώνες για μια καθαρή εμπειρία αγοράς.`,{class:'field-help'}),zonesRoot);
    if(!canWeight)root.append(make('p','Η χρέωση ανά βάρος και το όριο βάρους δωρεάν αποστολής περιλαμβάνονται στο μεγαλύτερο πακέτο.',{class:'field-help'}));
    packageField=numberField('Βάρος συσκευασίας (κιλά)',data,'packageWeightGrams',3,'Συμπλήρωσε το πραγματικό βάρος της συσκευασίας. Αν δεν προστίθεται βάρος, δήλωσε 0. Το κενό σημαίνει ότι δεν το γνωρίζουμε ακόμη.').node;root.append(packageField);
    const timing=make('div',undefined,{class:'shipping-timing'});timing.append(make('h4','Πότε φτάνει η παραγγελία;'),make('p','Μια καθαρή εκτίμηση δίνει σιγουριά στον αγοραστή. Προτείνουμε να συμπληρώσεις τους χρόνους· μπορείς να τους αλλάξεις αργότερα. Αν τους αφήσεις κενούς, δεν θα προσθέσουμε αυτή την ενημέρωση στο κατάστημα.',{class:'field-help'}));
    for(const [key,title,help] of [['preparationTime','Προετοιμασία παραγγελίας','Ο χρόνος που χρειάζεσαι μέχρι να παραδώσεις την παραγγελία για αποστολή.'],['transitTime','Μεταφορά μέχρι τον πελάτη','Η συνήθης διάρκεια της διαδρομής, μετά την παράδοση για αποστολή.']]){
      const time=data[key]??{minDays:null,maxDays:null,dayType:null},panel=make('div',undefined,{class:'shipping-time-range'}),grid=make('div',undefined,{class:'shipping-grid'});
      const from=numberField('Από ημέρες',time,'minDays',0,undefined,saveTime),to=numberField('Έως ημέρες',time,'maxDays',0,undefined,saveTime),type=selection([['business','Εργάσιμες ημέρες'],['calendar','Ημερολογιακές ημέρες']],time.dayType,`Τύπος ημερών · ${title}`);
      from.input.setAttribute('aria-label',`${title} · από ημέρες`);to.input.setAttribute('aria-label',`${title} · έως ημέρες`);
      function saveTime(){data[key]=[time.minDays,time.maxDays,time.dayType].every(item=>item===null)?null:time;refresh();}
      type.addEventListener('change',()=>{time.dayType=type.value||null;saveTime();});grid.append(from.node,to.node,field('Οι ημέρες είναι',type));panel.append(make('h5',`${title} — προαιρετικό`),grid,make('p',help,{class:'field-help'}));timing.append(panel);
    }
    root.append(timing);
    const pickup=make('div',undefined,{class:'shipping-pickup'}),pickupChoice=selection([['yes','Ναι, από ένα φυσικό σημείο'],['no','Όχι']],data.pickupRequested===true?'yes':data.pickupRequested===false?'no':'','Παραλαβή από φυσικό σημείο');pickupChoice.addEventListener('change',()=>{data.pickupRequested=pickupChoice.value===''?null:pickupChoice.value==='yes';refresh();});pickup.append(make('h4','Μια ακόμη επιλογή παραλαβής'),field('Θέλεις παραλαβή από φυσικό σημείο; — προαιρετικό',pickupChoice,'Καταγράφουμε την προτίμησή σου. Για την ενεργοποίηση θα χρειαστούμε αργότερα μόνο τα στοιχεία που ζητά το Shopify.'));root.append(pickup,warnings,summaryBox);
    if(onEstimate){
      const preview=make('details',undefined,{class:'shipping-preview'}),grid=make('div',undefined,{class:'shipping-grid'}),scenario={country:'',currency:'EUR',subtotalMinor:null,itemsWeightGrams:null},country=selection(countries.map(item=>[item.code,item.name]),'','Χώρα δοκιμαστικής παραγγελίας'),subtotal=numberField('Αξία προϊόντων (€)',scenario,'subtotalMinor',2,undefined,()=>{output.textContent='';}),itemsWeight=numberField('Συνολικό βάρος προϊόντων (κιλά)',scenario,'itemsWeightGrams',3,'Χωρίς τη συσκευασία· χρειάζεται μόνο για κανόνες που εξαρτώνται από το βάρος.',()=>{output.textContent='';}),button=make('button','Υπολόγισε την αποστολή',{type:'button',class:'secondary'}),output=make('p','',{class:'shipping-rule-note','aria-live':'polite'});
      preview.addEventListener('input',event=>event.stopPropagation());preview.addEventListener('change',event=>event.stopPropagation());
      country.addEventListener('change',()=>{scenario.country=country.value;output.textContent='';});grid.append(field('Χώρα προορισμού',country),subtotal.node,itemsWeight.node);
      button.addEventListener('click',async()=>{if(!scenario.country||!Number.isSafeInteger(scenario.subtotalMinor)||scenario.subtotalMinor<0||scenario.itemsWeightGrams!==null&&(!Number.isSafeInteger(scenario.itemsWeightGrams)||scenario.itemsWeightGrams<0)){output.textContent='Διάλεξε χώρα και συμπλήρωσε έγκυρο ποσό αγορών. Αν προσθέσεις βάρος, γράψε έως τρία δεκαδικά.';return;}button.disabled=true;output.textContent='Υπολογίζουμε τον αποθηκευμένο κανόνα σου…';try{const result=await onEstimate(structuredClone(scenario));const messages={uncovered_destination:'Δεν έχεις ορίσει κανόνα για αυτή τη χώρα.',missing_weight:`Χρειάζεται ${result.missing?.includes('packageWeightGrams')?'το βάρος συσκευασίας στον αποθηκευμένο κανόνα σου':'το βάρος των προϊόντων αυτής της παραγγελίας'} για να προκύψει σωστά η χρέωση.`,incomplete:'Συμπλήρωσε και αποθήκευσε τον κανόνα της ζώνης πριν τον υπολογισμό.',review_required:'Ο τρόπος αποστολής χρειάζεται αξιολόγηση πριν μπορέσουμε να υπολογίσουμε χρέωση.',invalid_plan:'Έλεγξε και αποθήκευσε τις επιλογές αποστολής πριν τον υπολογισμό.',invalid_request:'Έλεγξε τη χώρα, το ποσό και το βάρος της δοκιμαστικής παραγγελίας.',calculation_limit:'Αυτός ο υπολογισμός χρειάζεται επιπλέον έλεγχο.'};output.textContent=result.status==='quoted'?`Εκτιμώμενα μεταφορικά: ${amount(result.amountMinor)}.`:messages[result.status]??'Χρειάζονται ακόμη στοιχεία για να υπολογίσουμε αυτή την παραγγελία.';}catch(error){output.textContent=error.message||'Ο υπολογισμός δεν ολοκληρώθηκε. Δοκίμασε ξανά.';}finally{button.disabled=false;}});
      preview.append(make('summary','Δοκίμασε μια παραγγελία'),make('p','Προεπισκόπηση του κανόνα σου. Αποθήκευσε πρώτα τις επιλογές σου. Ο υπολογισμός δεν ενεργοποιεί χρεώσεις στο Shopify.',{class:'field-help'}),grid,button,output);root.append(preview);
    }
    renderZones();refresh(false);return {node:root,read};
  }
  return {render,summary,parseAmount:value=>decimal(value,2),parseWeight:value=>decimal(value,3)};
})();
