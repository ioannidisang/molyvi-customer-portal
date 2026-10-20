import {readDeliveryStoredFile,assertDeliveryStorageRoot} from './delivery-storage.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import {serviceStoreCatalogCsv} from './service-store-package.mjs';

export const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
export const escapeHtml = value => String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
const fail = message => { throw new Error(message); };
const money = n => new Intl.NumberFormat('el-GR',{style:'currency',currency:'EUR'}).format(n/100);
export function safeRelative(file) {
  if(typeof file!=='string'||!file||/[\\:\x00-\x1f?#]/.test(file)||file.split('/').some(x=>!x||x==='.'||x==='..')||path.isAbsolute(file))fail('UNSAFE_HANDOFF_PATH');
  return file;
}
export async function ordinaryFile(root, file, storage) {
  if(storage){assertDeliveryStorageRoot(storage,root);return readDeliveryStoredFile(storage,file);}
  safeRelative(file); let current=path.resolve(root);
  if((await fs.lstat(current)).isSymbolicLink())fail('HANDOFF_SYMLINK');
  for(const part of file.split('/')) { current=path.join(current,part); if((await fs.lstat(current)).isSymbolicLink())fail('HANDOFF_SYMLINK'); }
  if(!(await fs.stat(current)).isFile())fail('HANDOFF_NOT_FILE');
  return fs.readFile(current);
}
export async function verifySealedRun(root, expectedHash) {
  const bytes=await ordinaryFile(root,'RUN-MANIFEST.json');
  if(sha256(bytes)!==expectedHash)fail('HANDOFF_RUN_HASH_MISMATCH');
  const manifest=JSON.parse(bytes);
  const seen=new Set();
  for(const item of manifest.files) {
    if(seen.has(item.file))fail('HANDOFF_DUPLICATE_FILE'); seen.add(item.file);
    const body=await ordinaryFile(root,item.file);
    if(body.length!==item.bytes||sha256(body)!==item.sha256)fail('HANDOFF_SOURCE_CHANGED');
  }
  return {fileCount:seen.size,manifestSha256:sha256(bytes)};
}
function adminLink(url, slug) {
  const u=new URL(url);
  if(u.origin!=='https://admin.shopify.com'||!u.pathname.startsWith(`/store/${slug}/`)||u.search||u.hash)fail('HANDOFF_WRONG_ADMIN_LINK');
  return u.href;
}
// Receipts are trusted operator evidence, not an automatic claim of delivery.
// Project, order and exact build identity must agree before projecting a handoff.
function restoredVisibility(installed){
  if(installed.finalState==null)return null;
  const state=installed.finalState;
  if(state.products!=='Draft / zero channels'||state.pages!=='Hidden'||state.collectionChannels!==0||installed.products.some(p=>String(p.finalStatus).toLowerCase()!=='draft')||installed.pages.some(p=>p.hidden!==true))fail('HANDOFF_RESTORATION_MISMATCH');
  return {products:'draft',productChannels:0,pages:'hidden',collectionChannels:0};
}
export function handoffVisibilityNotice(m){
  return m.finalVisibility?'Μετά τη δοκιμή τα προϊόντα επανήλθαν σε Draft χωρίς κανάλια, οι σελίδες σε Hidden και η συλλογή δεν διατίθεται στο Online Store. Η προεπισκόπηση μπορεί έτσι να δείχνει κενό κατάλογο. Τα αρχεία και τα αποτελέσματα της δοκιμής παραμένουν στον ιδιωτικό φάκελο.':'';
}
export function buildHandoffModel(plan, installed, checkout) {
  serviceStoreCatalogCsv(plan);
  if(installed.projectId!==plan.projectId||installed.orderId!==plan.orderId||installed.planHash!==plan.planHash||installed.store!==plan.targetStore||installed.runtimeStatus!=='PASS'||installed.liveThemePublished!==false)fail('HANDOFF_INSTALL_MISMATCH');
  if(checkout.sourceProjectId!==plan.projectId||checkout.sourceServiceOrderId!==plan.orderId||checkout.store!==plan.targetStore||checkout.themeId!==installed.theme.themeId||checkout.status!=='DEV_SHIPPING_AND_CHECKOUT_TEST_PASS'||checkout.order?.test!==true||checkout.order.paymentStatus!=='PAID'||checkout.themePublished!==false||checkout.shipping.collectionId!==installed.collection.shopifyId)fail('HANDOFF_CHECKOUT_MISMATCH');
  if(installed.theme.status!=='uploaded_unpublished'||plan.review.customerAcceptance!=='PENDING'||plan.review.legalCertification!==false)fail('HANDOFF_REQUIRES_REVIEW');
  for(const id of ['shipping-below-threshold','shipping-at-threshold','test-payment-decline','test-payment-success','order-admin-and-email','inventory-and-variant']) {
    const tests=checkout.testCases.filter(t=>t.id===id); if(tests.length!==1||tests[0].status!=='PASS')fail('HANDOFF_INCOMPLETE_QA');
  }
  const plannedZone=plan.operations.operations.data.shippingPlan.zones[0];
  if(plannedZone.basePriceMinor!==checkout.shipping.basePriceMinor||plannedZone.freeFromAmountMinor!==checkout.shipping.freeFromAmountMinor)fail('HANDOFF_SHIPPING_MISMATCH');
  const slug=plan.targetStore.replace(/\.myshopify\.com$/,'');
  if(!/^[a-z0-9-]+$/.test(slug))fail('HANDOFF_STORE_INVALID');
  const expectedIds=plan.products.map(p=>p.productId).sort();
  if(JSON.stringify(installed.products.map(p=>p.productId).sort())!==JSON.stringify(expectedIds)||new Set(expectedIds).size!==expectedIds.length)fail('HANDOFF_PRODUCT_MISMATCH');
  if(JSON.stringify(installed.pages.map(p=>p.documentId).sort())!==JSON.stringify(plan.pages.map(p=>p.documentId).sort()))fail('HANDOFF_PAGE_MISMATCH');
  const products=plan.products.map(p=>{
    const saved=installed.products.find(x=>x.productId===p.productId);
    if(saved.handle!==p.handle||saved.status!=='active'||saved.imagesUploaded!==p.photos.length)fail('HANDOFF_PRODUCT_MISMATCH');
    return {productId:p.productId,title:p.title,description:p.descriptionText,handle:p.handle,category:p.type,adminUrl:adminLink(saved.adminUrl,slug),variants:p.variants.map(v=>({sku:v.sku,size:v.size??null,color:v.color??null,priceMinor:v.priceMinor,stockAtBuild:v.stock,weightGrams:v.weightGrams})),photos:p.photos.map(i=>({file:safeRelative(i.fileName),alt:i.alt,sha256:i.sha256,position:i.position}))};
  });
  return {schemaVersion:1,kind:'molyvi_service_handoff',projectId:plan.projectId,serviceOrderId:plan.orderId,planHash:plan.planHash,store:plan.targetStore,brandName:plan.branding.brandName,status:'READY_FOR_REVIEW_NOT_ACCEPTED',customerAccepted:false,published:false,cloudArchiveActive:false,retentionClockStarted:false,finalVisibility:restoredVisibility(installed),counts:plan.counts,
    branding:{logoMode:plan.branding.logoMode,brandName:plan.branding.brandName,palette:plan.branding.palette,fontFamily:plan.branding.fontFamily},
    theme:{id:installed.theme.themeId,name:installed.theme.name,status:'unpublished',sha256:installed.theme.zipSha256},
    collection:{title:installed.collection.title,tag:installed.collection.ruleTag,adminUrl:adminLink(installed.collection.adminUrl,slug)},products,
    pages:plan.pages.map(p=>({id:p.documentId,title:p.title,htmlFile:`pages/${p.documentId}.html`,textFile:`pages/${p.documentId}.txt`,adminUrl:adminLink(installed.pages.find(x=>x.documentId===p.documentId).adminUrl,slug)})),
    shipping:{name:checkout.shipping.name,basePriceMinor:checkout.shipping.basePriceMinor,freeFromAmountMinor:checkout.shipping.freeFromAmountMinor,transitBusinessDays:checkout.shipping.transitBusinessDays,preparationBusinessDays:checkout.shipping.preparationBusinessDays,marketId:checkout.shipping.marketId,preparationTextOnly:true,legacyOptionsPreserved:checkout.shipping.legacyOptionsPreserved},
    checkout:{orderNumber:checkout.order.number,orderAdminUrl:adminLink(`https://admin.shopify.com/store/${slug}/orders/${checkout.order.id}`,slug),test:true,status:checkout.order.paymentStatus,fulfillment:checkout.order.fulfillmentStatus,totalMinor:checkout.order.totalMinor,emailStatus:checkout.order.emailStatus,taxMinor:checkout.order.taxMinor},
    inventoryEvidence:checkout.inventory.map(v=>({variantId:v.variantId,availableBefore:v.availableBefore,availableAfter:v.availableAfter,committedAfter:v.committedAfter,onHandAfter:v.onHandAfter})),
    publicationBlockers:plan.review.publicationBlockers.map(b=>({code:b.code,field:b.field})),verifiedAt:checkout.completedAt};
}
export const handoffCss=`:root{--ink:#292929;--paper:#f6f5f1;--line:#d9d5cd;--muted:#68645e}*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.65 Arial,sans-serif}a{color:inherit;text-underline-offset:4px}a:focus-visible,summary:focus-visible{outline:3px solid #7c5830;outline-offset:5px}header,main,footer{max-width:1160px;margin:auto;padding:28px}header{display:flex;justify-content:space-between;gap:20px;border-bottom:1px solid var(--line)}.brand{font-size:25px;font-weight:700;letter-spacing:-1px;text-decoration:none}.eyebrow,small{font-size:12px;letter-spacing:1.2px;text-transform:uppercase;color:var(--muted)}.hero{padding:52px 0 38px;max-width:860px}h1{font-size:clamp(36px,6vw,66px);line-height:1.06;letter-spacing:-2px;font-weight:500;margin:20px 0}h2{font-size:30px;line-height:1.2;letter-spacing:-.6px}h3{font-size:21px;line-height:1.35}p{max-width:78ch}.lead{font-size:20px;color:var(--muted)}.actions{display:flex;flex-wrap:wrap;gap:12px;margin:28px 0}.button{background:var(--ink);color:white;padding:12px 18px;text-decoration:none;border-radius:3px}.button.secondary{background:white;color:var(--ink);border:1px solid var(--line)}.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:var(--line);border:1px solid var(--line)}.stats div{background:var(--paper);padding:22px}.stats strong{display:block;font-size:32px;line-height:1.2}.notice{border-left:3px solid #9b8c75;background:#eeebe5;padding:18px 22px;margin:24px 0}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px}.card{border:1px solid var(--line);padding:24px;background:#fff}.card a{overflow-wrap:anywhere}.gallery{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}.gallery img{width:100%;height:auto;aspect-ratio:1;object-fit:contain;background:white}.product{border-top:1px solid var(--line);padding:32px 0}.product h3{max-width:64ch}.meta{color:var(--muted);font-size:14px}section{scroll-margin-top:20px;margin:44px 0}details{border-bottom:1px solid var(--line);padding:18px 0}summary{cursor:pointer;font-size:20px}nav{display:flex;gap:16px;flex-wrap:wrap}.steps{padding-left:22px}.steps li{margin:12px 0}.chapter{padding:24px 0;border-top:1px solid var(--line)}.chapter h3{margin-bottom:7px}.chapter p{margin-top:0}.source{font-size:13px;overflow-wrap:anywhere}.contents{display:grid;grid-template-columns:repeat(2,1fr);gap:8px}footer{border-top:1px solid var(--line);font-size:13px;color:var(--muted)}@media(max-width:650px){header,main,footer{padding:20px}.hero{padding:24px 0}.grid,.contents{grid-template-columns:1fr}.stats{grid-template-columns:repeat(2,1fr)}.gallery{gap:4px}h1{letter-spacing:-1px}.lead{font-size:18px}}@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}@media print{header,.actions,nav{display:none}body{background:white;font-size:11pt}.chapter{break-before:page}a{color:inherit}}`;
export function pageShell(title, body){return `<!doctype html><html lang="el"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${escapeHtml(title)} · Molyvi</title><link rel="stylesheet" href="handoff.css"></head><body><header><a class="brand" href="index.html">Molyvi</a><span class="eyebrow">Basic / Ιδιωτική πρόβα παράδοσης</span></header><main>${body}</main><footer>Molyvi · Περιβάλλον δοκιμής · Φάκελος προς έλεγχο, χωρίς καταγεγραμμένη τελική αποδοχή.</footer></body></html>`;}
export function renderHandoffHome(m){
  return pageShell('Ο φάκελος του καταστήματός σου',`<div class="hero"><span class="eyebrow">Το επόμενο κεφάλαιο του καταστήματός σου</span><h1>Όλα στη θέση τους.</h1><p class="lead">Οι φωτογραφίες, τα κείμενα και οι οδηγίες σου. Σε έναν φάκελο, έτοιμα για τον τελικό έλεγχο.</p><p>${escapeHtml(m.brandName)} · Δοκιμή καταστήματος #${escapeHtml(m.checkout.orderNumber)}</p><div class="actions"><a class="button" href="handbook.html">Άνοιξε το εγχειρίδιο</a><a class="button secondary" href="Molyvi-Service-Handbook.pdf" download>Εγχειρίδιο PDF</a><a class="button secondary" href="Molyvi-Service-Delivery.zip" download>Όλος ο φάκελος ZIP</a></div></div><div class="stats">${Object.entries({Προϊόντα:m.counts.products,Παραλλαγές:m.counts.variants,Φωτογραφίες:m.counts.photos,Σελίδες:m.counts.pages}).map(([k,v])=>`<div><strong>${v}</strong>${k}</div>`).join('')}</div><div class="notice"><strong>Έτοιμο για έλεγχο.</strong> Η εγκατάσταση και η δοκιμαστική αγορά ελέγχθηκαν. Το κατάστημα παραμένει δοκιμαστικό. Οι τελικές εγκρίσεις και οι ρυθμίσεις πραγματικής λειτουργίας ακολουθούν.</div>${handoffVisibilityNotice(m)?`<div class="notice">${escapeHtml(handoffVisibilityNotice(m))}</div>`:''}<nav aria-label="Ενότητες φακέλου"><a href="#files">Αρχεία</a><a href="#photos">Φωτογραφίες</a><a href="#pages">Σελίδες</a><a href="#next">Τι απομένει</a></nav><section id="files"><h2>Τα χρήσιμα, συγκεντρωμένα.</h2><div class="grid"><article class="card"><h3>Κατάλογος & εμφάνιση</h3><p>Οι τίτλοι, οι περιγραφές και τα SKU του συγκεκριμένου έργου, μαζί με την παλέτα.</p><p><a download href="catalogue.json">Κατάλογος JSON</a> · <a download href="branding.json">Παλέτα</a></p><p><a download href="theme/MOLYVI_Service_STILL_Draft.zip">Αντίγραφο του draft θέματος</a></p><p class="meta">Οι τιμές και οι αρχικές ποσότητες είναι δοκιμαστικές. Δεν είναι τρέχουσα απογραφή ή νέο αρχείο import.</p></article><article class="card"><h3>Η δοκιμή ολοκληρώθηκε</h3><p>Παραγγελία #${m.checkout.orderNumber}: ${money(m.checkout.totalMinor)}, TEST / Paid / Unfulfilled. Email: ${['SENT_NOT_CONFIRMED_RECEIVED','DELIVERED_REPORTED_BY_SHOPIFY'].includes(m.checkout.emailStatus)?'καταγεγραμμένη αποστολή από το Shopify. Η παραλαβή στα εισερχόμενα δεν έχει επιβεβαιωθεί.':'η αποστολή και η παραλαβή χρειάζονται επιβεβαίωση.'}</p><p>Μεταφορικά ${money(m.shipping.basePriceMinor)}, δωρεάν από ${money(m.shipping.freeFromAmountMinor)}.</p><p><a href="${m.checkout.orderAdminUrl}" target="_blank" rel="noopener noreferrer">Δες τη δοκιμαστική παραγγελία</a></p></article></div></section><section id="photos"><h2>Η συλλογή σου, ανά προϊόν.</h2><p>Άνοιξε οποιαδήποτε εικόνα για το πλήρες αρχείο. Οι εικόνες χρειάζονται τον τελικό έλεγχο πιστότητας από τον ιδιοκτήτη.</p>${m.products.map((p,i)=>`<article class="product"><small>${String(i+1).padStart(2,'0')} / ${m.products.length}</small><h3>${escapeHtml(p.title.replace(/^Molyvi Service QA — /,''))}</h3><div class="gallery">${p.photos.map(x=>`<a href="${x.file}" target="_blank" rel="noopener" aria-label="Άνοιγμα εικόνας ${x.position}: ${escapeHtml(p.title)}"><img src="${x.file}" width="1000" height="1000" loading="lazy" alt="${escapeHtml(x.alt)}"></a>`).join('')}</div><p class="meta">${p.variants.map(v=>escapeHtml(v.size??'Μία επιλογή')).join(' · ')} · ${p.photos.length} εικόνες</p><a href="${p.adminUrl}" target="_blank" rel="noopener noreferrer">Άνοιγμα προϊόντος στο Shopify</a></article>`).join('')}</section><section id="pages"><h2>Τα κείμενα του καταστήματος.</h2><p>Τα νομικά κείμενα είναι προσχέδια με εικονικά στοιχεία. Χρειάζονται πραγματικά στοιχεία και τελικό έλεγχο πριν από δημοσίευση.</p>${m.pages.map(p=>`<details><summary>${escapeHtml(p.title.replace(/^Molyvi Service QA — /,''))}</summary><p><a href="${p.htmlFile}">Προβολή HTML</a> · <a download href="${p.textFile}">Λήψη κειμένου</a> · <a href="${p.adminUrl}" target="_blank" rel="noopener noreferrer">Στο Shopify</a></p></details>`).join('')}</section><section id="next"><h2>Από τον έλεγχο στην παράδοση.</h2><ol class="steps"><li>Έλεγχος εμφάνισης, φωτογραφιών και περιεχομένου της συγκεκριμένης έκδοσης.</li><li>Ένας τελικός γύρος έως πέντε μικρών προσαρμογών του συμφωνημένου scope.</li><li>Πραγματικά στοιχεία πωλητή, τιμές, απόθεμα, φόροι και έλεγχος πολιτικών.</li><li>Ενεργοποίηση πληρωμών από τον ιδιοκτήτη, εξουσιοδοτημένη σύνδεση domain και τελικός έλεγχος πριν από launch.</li></ol><p>Η κατασκευή του δοκιμαστικού καταστήματος έχει ελεγχθεί. Πριν από εμπορική λειτουργία ολοκληρώνονται η αποδοχή υλικού και πολιτικών, τα πραγματικά στοιχεία και η κοστολόγηση.</p><p class="meta">Η διετής φύλαξη στο cloud είναι σχεδιαζόμενη παροχή. Αυτή η έκδοση ελέγχου δεν ενεργοποιεί περίοδο φύλαξης.</p></section>`);
}
export async function sealDelivery(directory, model){
  const files=[];
  async function walk(rel=''){for(const entry of await fs.readdir(path.join(directory,rel),{withFileTypes:true})){if(entry.isSymbolicLink())fail('HANDOFF_SYMLINK');const file=rel?`${rel}/${entry.name}`:entry.name;if(file==='delivery-manifest.json')continue;if(entry.isDirectory())await walk(file);else {const b=await ordinaryFile(directory,file);files.push({file,bytes:b.length,sha256:sha256(b)});}}}
  await walk();files.sort((a,b)=>a.file.localeCompare(b.file));
  const manifest={schemaVersion:1,kind:'molyvi_handoff_manifest',projectId:model.projectId,serviceOrderId:model.serviceOrderId,planHash:model.planHash,status:model.status,customerAccepted:false,published:false,files};
  await fs.writeFile(path.join(directory,'delivery-manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});return manifest;
}
export async function createHandoffServer({directory,zipFile,port}){
  const manifestBytes=await ordinaryFile(directory,'delivery-manifest.json'),manifest=JSON.parse(manifestBytes),routes=new Map();
  const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.txt':'text/plain; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp','.pdf':'application/pdf','.zip':'application/zip','.md':'text/plain; charset=utf-8'};
  for(const item of manifest.files){const bytes=await ordinaryFile(directory,item.file);if(bytes.length!==item.bytes||sha256(bytes)!==item.sha256)fail('HANDOFF_FILE_CHANGED');routes.set('/'+item.file,{bytes,type:types[path.extname(item.file)]??'application/octet-stream'});}
  routes.set('/delivery-manifest.json',{bytes:manifestBytes,type:types['.json']});
  if(zipFile){const receipt=JSON.parse(await ordinaryFile(path.dirname(zipFile),'delivery-zip-receipt.json'));const bytes=await ordinaryFile(path.dirname(zipFile),path.basename(zipFile));if(sha256(bytes)!==receipt.sha256||receipt.deliveryManifestSha256!==sha256(manifestBytes))fail('HANDOFF_ZIP_CHANGED');routes.set('/Molyvi-Service-Delivery.zip',{bytes,type:types['.zip']});}
  return http.createServer((req,res)=>{if(req.headers.host!==`127.0.0.1:${port}`||!['GET','HEAD'].includes(req.method)||req.headers['sec-fetch-site']==='cross-site'){res.writeHead(403);res.end();return;} const resource=routes.get(req.url==='/'?'/index.html':req.url);res.writeHead(resource?200:404,{'Content-Type':resource?.type??'text/plain','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; img-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"});res.end(req.method==='HEAD'?undefined:resource?.bytes??'Not found');});
}

