import fs from 'node:fs/promises';
import path from 'node:path';
import {canonicalJson} from './intake-store.mjs';
import {safeRelative,sha256,escapeHtml as esc} from './service-handoff.mjs';
import {DeliveryRevision,writeRevisionFile,writeRevisionZip,revisionDigest} from './delivery-revision.mjs';
import {resolveDeliveryStorage,withDeliveryStorage,DELIVERY_STORAGE_MARKER} from './delivery-storage.mjs';

const need=(v,c)=>{if(!v)throw Error(c);};
const json=v=>Buffer.from(JSON.stringify(v,null,2)+'\n');
const digest=v=>sha256(canonicalJson(v));
const checkFile=async(root,e)=>{safeRelative(e.file);const a=await revisionDigest(root,e.file);need(a.bytes===e.bytes&&a.sha256===e.sha256,'DRAFT_DELIVERY_INPUT_CHANGED');};
export async function deliverySourceBytes(root){
 let bytes=0,files=0;const walk=async dir=>{for(const e of await fs.readdir(dir,{withFileTypes:true})){const p=path.join(dir,e.name),s=await fs.lstat(p);need(!s.isSymbolicLink(),'DRAFT_DELIVERY_SOURCE_PATH');if(s.isDirectory())await walk(p);else{need(s.isFile()&&s.nlink===1,'DRAFT_DELIVERY_SOURCE_PATH');bytes+=s.size;files++;}}};await walk(root);return{bytes,files};
}
const shell=(title,body)=>`<!doctype html><html lang="el"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · Molyvi</title><link rel="stylesheet" href="handoff.css"></head><body><main>${body}</main></body></html>`;
const css=`*{box-sizing:border-box}body{margin:0;background:#f7f2e9;color:#302b26;font:16px/1.65 system-ui,sans-serif}main{max-width:1100px;margin:auto;padding:42px 24px}h1{font-size:clamp(32px,5vw,60px);line-height:1.1}h2{margin-top:40px}h3{margin-top:25px}a{color:inherit;text-underline-offset:4px;overflow-wrap:anywhere}.tag{font-size:13px;letter-spacing:.12em;text-transform:uppercase}.lead{max-width:720px;font-size:20px}.notice{padding:20px;background:#fff;border-left:4px solid #b08b6b;margin:24px 0}.actions{display:flex;flex-wrap:wrap;gap:12px}.actions a{padding:12px 18px;border:1px solid #9e8a76;border-radius:8px;text-decoration:none}.stats,.gallery{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}.stats strong{display:block;font-size:30px}.gallery img{width:100%;height:auto;aspect-ratio:1;object-fit:contain;background:#fff}.product{padding:24px 0;border-top:1px solid #cbbfb2}details{padding:12px 0}table{width:100%;border-collapse:collapse}td,th{padding:10px;text-align:left;border-bottom:1px solid #cbbfb2}small,.meta{color:#61584e}.steps li{margin:10px 0}@media(max-width:600px){main{padding:25px 18px}.gallery{gap:5px}.lead{font-size:18px}.stats strong{font-size:24px}}`;

// Private service operation. The caller owns the real application's exclusive
// production lease for the entire prepare/verify/register sequence.
// No provider, email, AI, payment, publication or deletion interface is accepted.
export async function prepareDraftDelivery({app,config}){
 const {source,controlRoot,packageRoot,themeRoot,completionFile,reviewFile,handbookFile,scope}=config;
 const guard=config.guard??(()=>{});guard();
 const {projectId,accountId,ownerId,orderId,sourceHash,planHash,themeId,previousDeliveries,inputs}=scope;
 const read=async file=>JSON.parse(await fs.readFile(file));
 const assertSource=async()=>{const record=await app.workspaces.read(projectId,ownerId);need(digest(record)===sourceHash,'DRAFT_DELIVERY_SOURCE_CHANGED');return record;};
 const previous=()=>app.accounts.db.prepare('SELECT * FROM deliveries WHERE project_id=? ORDER BY created,rowid').all(projectId);
 const rowPins=rows=>rows.map(r=>({id:r.id,manifestHash:r.manifest_hash,zipHash:r.zip_hash}));
 need(app.accounts.project(accountId,projectId).owner_id===ownerId&&app.accounts.project(accountId,projectId).order_id===orderId,'DRAFT_DELIVERY_OWNER');
 const beforeRows=previous();need(JSON.stringify(rowPins(beforeRows))===JSON.stringify(previousDeliveries),'DRAFT_DELIVERY_PREVIOUS_CHANGED');
 await assertSource();
 for(const p of inputs){guard();await checkFile(p.root,p);}
 const plan=await read(path.join(packageRoot,'package-plan.json')),pm=await read(path.join(packageRoot,'manifest.json')),complete=await read(completionFile),review=await read(reviewFile);
 const resources=complete.result?.resources??[],remote=(key)=>{const matches=resources.filter(r=>r.key===key);need(matches.length===1&&/^\d+$/.test(matches[0].remoteId),'DRAFT_DELIVERY_RESOURCE');return matches[0].remoteId;};
 need(plan.projectId===projectId&&plan.orderId===orderId&&plan.planHash===planHash&&plan.binding.sourceRecordHash===sourceHash&&plan.targetStore===scope.store,'DRAFT_DELIVERY_BINDING');
 need(pm.projectId===projectId&&pm.planHash===planHash&&pm.sourceRecordHash===sourceHash,'DRAFT_DELIVERY_PACKAGE');
 need(complete.result.status==='verified'&&complete.sourceHash===sourceHash&&complete.result.confirmation.planHash===planHash&&complete.result.publicationAuthorized===false&&complete.result.newChargesAuthorized===false&&remote('theme')===themeId,'DRAFT_DELIVERY_INSTALLATION');
 need(complete.result.eventCount===118&&resources.length===59&&new Set(resources.map(r=>r.key)).size===59,'DRAFT_DELIVERY_INSTALLATION');
 need(review.projectId===projectId&&review.themeId===themeId&&review.sourceHash===sourceHash&&review.coverage.loadedGalleryImages===30&&review.coverage.pages===7,'DRAFT_DELIVERY_VISUAL_BINDING');
 need(plan.counts.products===10&&plan.counts.photos===30&&plan.counts.pages===7&&plan.products.length===10,'DRAFT_DELIVERY_COUNTS');
 for(const e of pm.files)await checkFile(packageRoot,e);
 const original=await new DeliveryRevision(app.deliveries).source(beforeRows.at(-1));
 const byHash=new Map();for(const e of original.entries.values())byHash.set(e.sha256,e);
 const stage=path.join(controlRoot,'prepared');await fs.mkdir(stage,{recursive:false,mode:0o700});
 const entries=new Map();
 const add=async(file,bytes)=>{guard();safeRelative(file);need(!entries.has(file),'DRAFT_DELIVERY_DUPLICATE');if(!Buffer.isBuffer(bytes))bytes=Buffer.from(bytes);need(bytes.length<=10*1024*1024,'DRAFT_DELIVERY_MEMBER_LIMIT');await writeRevisionFile(stage,file,bytes);entries.set(file,{file,bytes:bytes.length,sha256:sha256(bytes),root:stage});};
 const admin='https://admin.shopify.com/store/'+scope.store.replace('.myshopify.com','');
 const products=plan.products.map(p=>({...p,shopifyId:remote('catalog:'+p.productId),adminUrl:admin+'/products/'+remote('catalog:'+p.productId),photos:p.photos.map(photo=>{
  const old=byHash.get(photo.sha256);need(old&&old.bytes===photo.bytes&&/\.(png|jpg|webp)$/.test(old.file),'DRAFT_DELIVERY_PHOTO_MISMATCH');safeRelative(old.file);const current=entries.get(old.file);need(!current||current.sha256===old.sha256,'DRAFT_DELIVERY_DUPLICATE');entries.set(old.file,old);return{position:photo.position,sha256:photo.sha256,bytes:photo.bytes,file:old.file,alt:photo.alt,role:photo.role};
 })}));
 need(products.flatMap(p=>p.photos).length===30&&entries.size===30,'DRAFT_DELIVERY_PHOTO_COUNT');
 const pages=plan.pages.map(p=>({pageId:p.documentId,title:p.title,handle:p.handle,shopifyId:remote('page:'+p.documentId),htmlFile:'pages/'+p.documentId+'.html',textFile:'pages/'+p.documentId+'.txt',adminUrl:admin+'/pages/'+remote('page:'+p.documentId)}));
 for(const e of pm.files.filter(e=>/^pages\//.test(e.file)||e.file==='branding.json'||e.file==='catalog.csv'))await add(e.file,await fs.readFile(path.join(packageRoot,e.file)));
 const themeFile='theme/MOLYVI_Basic_Draft.zip',themeRaw=await fs.readFile(path.join(themeRoot,'MOLYVI_Basic_Draft.zip'));
 need(sha256(themeRaw)===complete.result.confirmation.themeZipSha256,'DRAFT_DELIVERY_THEME_CHANGED');await add(themeFile,themeRaw);
 const editor=admin+'/themes/'+themeId+'/editor';
 const installed={schemaVersion:1,projectId,orderId,planHash,sourceHash,store:scope.store,status:'INSTALLED_DRAFT_REVIEW_REQUIRED',theme:{id:themeId,status:'UNPUBLISHED',editorUrl:editor,sha256:sha256(themeRaw)},products:products.map(p=>({productId:p.productId,shopifyId:p.shopifyId,adminUrl:p.adminUrl,status:'DRAFT',variants:p.variants})),collection:{id:remote('collection'),published:false},pages:pages.map(p=>({...p,visible:false})),installationCompletedAt:complete.finishedAt,installationReceiptHash:complete.completionHash,journalHead:complete.result.journalHead,customerAccepted:false,published:false,checkoutTested:false};
 const catalogue={schemaVersion:1,projectId,orderId,planHash,counts:plan.counts,products};
 const remaining=review.remainingFields??[];
 const note='Η εγκατάσταση και η ιδιωτική προβολή του νέου Draft ελέγχθηκαν. Δεν έγινε νέα δοκιμαστική αγορά. Οι τιμές 1,00 € και τα αποθέματα είναι δοκιμαστικά. Οι πολιτικές περιέχουν στοιχεία δοκιμής. Η έκδοση παραμένει προς έλεγχο και δεν αποτελεί αποδοχή ή δημοσίευση.';
 const qa={...review,portalDelivery:{version:3,newInstallationBound:true,previousVersionsPreserved:true},limitations:review.limitations.filter(x=>!x.startsWith('Portal delivery v2')),checkoutTested:false,customerAccepted:false,published:false};
 await add('installed-resources.json',json(installed));await add('catalogue.json',json(catalogue));await add('visual-review.json',json(qa));
 await add('version-history.json',json({schemaVersion:1,projectId,version:3,previousDeliveries,previousFilesPreserved:true,customerAccepted:false,published:false}));
 await add('handoff.css',css);await add('README.txt',`Molyvi · #1005 · Έκδοση 3\n${note}\n\nΆνοιξε index.html. Το ZIP περιλαμβάνει τις 30 επιλεγμένες εικόνες, τις 7 σελίδες, το ακριβές Draft θέμα και το εγχειρίδιο. Οι προηγούμενες εκδόσεις παραμένουν στην εφαρμογή.\n${editor}\n`);
 const sections=[['Η έκδοση που παραλαμβάνεις',note],['Νέο προϊόν','Στο Shopify Admin άνοιξε Products και Add product. Συμπλήρωσε τίτλο, περιγραφή, εικόνες, τιμή, απόθεμα και στοιχεία αποστολής όπου απαιτούνται. Αποθήκευσε αρχικά ως Draft. Έλεγξε τις πληροφορίες πριν το διαθέσεις στο Online Store.'],['Παραλλαγές και απόθεμα','Στο προϊόν συμπλήρωσε επιλογές όπως μέγεθος και χρώμα. Έλεγξε ξεχωριστά τιμή, SKU, διαθέσιμο απόθεμα και εικόνα κάθε παραλλαγής. Στη δοκιμή τα S/M έχουν απόθεμα 5 και το L μηδενικό για πουκάμισο και σακάκι.'],['Συλλογές και κατηγορίες','Στο Products → Collections οργανώνεις προϊόντα με χειροκίνητη επιλογή ή συνθήκες. Η σύνδεση μιας συλλογής στο μενού είναι χωριστή ρύθμιση. Η παρούσα συλλογή παραμένει αδημοσίευτη.'],['Εμφάνιση και σελίδες','Χρησιμοποίησε τον σύνδεσμο του συγκεκριμένου Draft. Άλλαξε κείμενα, χρώματα και ενότητες μόνο στο σωστό θέμα. Οι 7 σελίδες είναι Hidden. Η προεπισκόπηση δεν δημοσιεύει το κατάστημα.'],['Παραγγελίες','Στο Orders βλέπεις πληρωμή, στοιχεία και κατάσταση παραγγελίας. Καταχώριζε αποστολή ή επιστροφή μόνο όταν έχει γίνει η αντίστοιχη ενέργεια. Δεν υπάρχει διασύνδεση ERP ή courier. Τα παραστατικά εκδίδονται χωριστά από τη διαδικασία πληρωμής.'],['Πριν από πραγματική λειτουργία','Συμπλήρωσε τα πραγματικά στοιχεία επιχείρησης, τιμές, ποσότητες, αποστολές και πολιτικές. Η ενεργοποίηση πληρωμών γίνεται από τον ιδιοκτήτη με τα στοιχεία που ζητά ο πάροχος. Ακολουθούν σύνδεση domain, έλεγχος αγοράς και χωριστή έγκριση δημοσίευσης.'],['Έλεγχος και βοήθεια','Από τη Molyvi μπορείς να δεις κάθε προηγούμενη έκδοση και να στείλεις συγκεκριμένο αίτημα με αναφορά στο προϊόν ή τη σελίδα. Οι έως 5 μικρές προσαρμογές απαιτούν την προβλεπόμενη έγκριση. Η λήψη του φακέλου δεν σημαίνει αποδοχή.']];
 const handBody='<p class="tag">Molyvi · #1005 · Έκδοση 3</p><h1>Το κατάστημά σου, βήμα βήμα.</h1><p><a href="index.html">Πίσω στον φάκελο</a> · <a href="'+editor+'" target="_blank" rel="noopener noreferrer">Άνοιξε το Draft</a></p>'+sections.map(([h,p])=>'<section><h2>'+esc(h)+'</h2><p>'+esc(p)+'</p></section>').join('');
 await add('handbook.html',shell('Εγχειρίδιο',handBody));await add('Molyvi-Service-Handbook.pdf',await fs.readFile(handbookFile));
 const index=`<p class="tag">Molyvi · Έργο #1005 · Έκδοση 3</p><h1>Το νέο Draft.<br>Όλα συγκεντρωμένα.</h1><p class="lead">Η εμφάνιση, ο κατάλογος και τα αρχεία του συγκεκριμένου καταστήματος. Έτοιμα για τον δικό σου έλεγχο.</p><div class="notice">${esc(note)}</div><div class="actions"><a href="${editor}" target="_blank" rel="noopener noreferrer">Άνοιξε το Draft στο Shopify</a><a href="handbook.html">Οδηγίες χρήσης</a><a href="Molyvi-Service-Handbook.pdf">Εγχειρίδιο PDF</a><a href="Molyvi-Service-Delivery.zip" download>Κατέβασε όλο τον φάκελο</a></div><p class="meta">Η προβολή στο Shopify απαιτεί πρόσβαση στο δοκιμαστικό κατάστημα.</p><div class="stats"><div><strong>10</strong>προϊόντα · 14 παραλλαγές</div><div><strong>30</strong>επιλεγμένες φωτογραφίες</div><div><strong>7</strong>σελίδες</div></div><h2>Η εμφάνιση και τα στοιχεία σου</h2><p><a href="${themeFile}" download>Αντίγραφο Draft θέματος</a> · <a href="branding.json">Παλέτα</a> · <a href="catalogue.json">Κατάλογος</a></p><h2>Φωτογραφίες ανά προϊόν</h2>${products.map((p,i)=>`<article class="product"><small>${String(i+1).padStart(2,'0')} / 10</small><h3>${esc(p.title)}</h3><div class="gallery">${p.photos.map(x=>`<a href="${x.file}" target="_blank" rel="noopener"><img src="${x.file}" width="1000" height="1000" loading="lazy" alt="${esc(x.alt)}"></a>`).join('')}</div><p><a href="${p.adminUrl}" target="_blank" rel="noopener noreferrer">Προϊόν στο Shopify</a></p><p class="meta">${p.variants.map(v=>`${esc(v.optionValues.join(' / '))}: ${v.price} € · Απόθεμα ${v.stock}`).join(' | ')}. Στοιχεία δοκιμής.</p></article>`).join('')}<h2>Οι σελίδες του καταστήματος</h2>${pages.map(p=>`<details><summary>${esc(p.title)}</summary><p><a href="${p.htmlFile}">Δες το κείμενο</a> · <a href="${p.textFile}" download>Λήψη κειμένου</a> · <a href="${p.adminUrl}" target="_blank" rel="noopener noreferrer">Στο Shopify</a></p></details>`).join('')}<h2>Τι απομένει πριν από τη λειτουργία</h2>${remaining.map(g=>`<h3>${esc(g.title)}</h3><ul>${g.items.map(x=>`<li>${esc(x)}</li>`).join('')}</ul>`).join('')}<p>Ακολουθούν η δική σου αξιολόγηση εικόνων και περιεχομένου, οι πραγματικές ρυθμίσεις και ο έλεγχος αγοράς. Τα νομικά κείμενα είναι προσχέδια για τελικό έλεγχο από τον ιδιοκτήτη.</p><h2>Το ιστορικό παραμένει διαθέσιμο</h2><p>Οι εκδόσεις 1 και 2 διατηρούνται στην εφαρμογή μαζί με τα αιτήματά τους. Αυτός ο φάκελος αφορά αποκλειστικά το νέο Draft ${themeId}.</p>`;
 await add('index.html',shell('Έκδοση 3 · Νέο Draft',index));
 const files=[...entries.values()].sort((a,b)=>a.file.localeCompare(b.file));need(files.length<=256,'DRAFT_DELIVERY_FILE_LIMIT');
 const model={schemaVersion:1,kind:'molyvi_handoff_manifest',projectId,serviceOrderId:orderId,planHash,sourceHash,status:'INSTALLED_DRAFT_REVIEW_REQUIRED',customerAccepted:false,published:false,previousDeliveryId:beforeRows.at(-1).id,shopifyApplied:true,checkoutTested:false,themeId,files:files.map(({file,bytes,sha256})=>({file,bytes,sha256}))};
 const raw=json(model),manifestHash=sha256(raw);await writeRevisionFile(stage,'delivery-manifest.json',raw);
 const beforeSpace=await deliverySourceBytes(source),logical=files.reduce((a,e)=>a+e.bytes,raw.length),projected=logical+files.length*400+raw.length+4096;
 need(beforeSpace.bytes+projected+12582912<=512000000,'DRAFT_DELIVERY_SOURCE_CAP');
 need(Number((await fs.statfs(source)).bavail)*Number((await fs.statfs(source)).bsize)>projected*2+12582912,'DRAFT_DELIVERY_DISK_CAP');
 const zip=await writeRevisionZip(stage,[...files,{file:'delivery-manifest.json',bytes:raw.length,sha256:manifestHash}]);
 guard();need(zip.bytes<=128*1024*1024,'DRAFT_DELIVERY_ZIP_CAP');await assertSource();
 const canonical=path.join(controlRoot,manifestHash);await fs.mkdir(canonical,{recursive:false,mode:0o700});
 await fs.rename(path.join(stage,'Molyvi-Service-Delivery.zip'),path.join(canonical,'Molyvi-Service-Delivery.zip'));
 await writeRevisionFile(canonical,'delivery-manifest.json',raw);await writeRevisionFile(canonical,DELIVERY_STORAGE_MARKER,json({schemaVersion:1,format:'molyvi_delivery_zip_v1',projectId,serviceOrderId:orderId,manifestHash,zipHash:zip.sha256,zipBytes:zip.bytes,memberCount:files.length+1,logicalBytes:logical}));
 const verify=async root=>{const storage=await resolveDeliveryStorage({root,manifestRaw:raw,manifestHash,zipHash:zip.sha256,projectId,orderId});need(storage,'DRAFT_DELIVERY_ARCHIVE_REQUIRED');await withDeliveryStorage(storage,async archive=>{for(const e of model.files)await archive.digest(e.file,{bytes:e.bytes,sha256:e.sha256});});};await verify(canonical);
 for(const p of inputs)await checkFile(p.root,p);
 for(const row of beforeRows)need(JSON.stringify(app.accounts.db.prepare('SELECT * FROM deliveries WHERE id=?').get(row.id))===JSON.stringify(row),'DRAFT_DELIVERY_HISTORY_CHANGED');
 await assertSource();const finalSpace=await deliverySourceBytes(source);need(finalSpace.bytes+zip.bytes+raw.length+4096+12582912<=512000000,'DRAFT_DELIVERY_SOURCE_CAP');
 await fs.rename(canonical,path.join(app.deliveries.storage,manifestHash));await verify(path.join(app.deliveries.storage,manifestHash));
 guard();const row=app.accounts.transaction(()=>{need(JSON.stringify(rowPins(previous()))===JSON.stringify(previousDeliveries),'DRAFT_DELIVERY_PREVIOUS_CHANGED');const r=app.accounts.registerDelivery({projectId,manifestHash,zipHash:zip.sha256});app.accounts.audit('draft_delivery_linked',accountId,r.id);return r;});
 return{status:'PASS',allowAutomaticStart:true,deliveryId:row.id,manifestHash,zip,version:3,projectId,themeId,sourceHash,previousDeliveries,files:files.length,photos:30,customerAccepted:false,published:false,checkoutTested:false,notificationSent:false,sourceBefore:beforeSpace,sourceAfter:await deliverySourceBytes(source),finishedAt:new Date().toISOString()};
}
