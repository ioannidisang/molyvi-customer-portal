import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {pipeline} from 'node:stream/promises';
import {IntakeError,PRIVATE_ROOT} from './lib/intake-store.mjs';
import {TaskStore} from './lib/task-store.mjs';
import {createWorkspace,editTask,submitTask,editProduct,submitProduct,approveTask,claimJob,finishJob,viewWorkspace} from './lib/task-workspace.mjs';
import {estimateShipping} from './lib/shipping-plan.mjs';
import {uploadPhoto,readPhoto,readGeneratedPhoto} from './lib/product-assets.mjs';
import {uploadLogo,readLogo} from './lib/logo-assets.mjs';
import {selectPhotoCandidate,setPhotoLayout,requestPhotoRegeneration,requestPhotoReplacement} from './lib/product-gallery.mjs';
import {openPhotoClaim,requestClaimEscalation} from './lib/photo-claims.mjs';
import {enqueuePhotoClaimReview,createPhotoReviewQueue,publicPhotoReviewQueue} from './lib/photo-review-queue.mjs';
import {requestPhotoReview,confirmPhotoIdentity} from './lib/product-materials.mjs';
import {requestTextVariant,selectTextVariant} from './lib/product-text.mjs';
import {createPaidOrder} from './lib/service-offer.mjs';
import {exportProjectContract} from './lib/project-contract.mjs';
import {createProductProductionQueue,enqueuePendingProductProduction,publicProductProductionQueue} from './lib/product-production-queue.mjs';
import {previewStoreContent,reviewStoreContent} from './lib/store-content.mjs';
import {createServicePaymentBridge} from './lib/service-payment-bridge.mjs';
import {createServiceProductionQueue} from './lib/service-production-queue.mjs';
import {createRequestBoundary} from './lib/hosted-request-boundary.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
const json=(res,status,body,headers={})=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers});res.end(JSON.stringify(body));};
async function body(req,limit=32_768) {
  if(!/^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers['content-type']??''))throw new IntakeError('JSON_REQUIRED',415);
  const chunks=[];let size=0;
  for await(const chunk of req) {size+=chunk.length;if(size>limit)throw new IntakeError('PAYLOAD_TOO_LARGE',413);chunks.push(chunk);}
  try {return JSON.parse(Buffer.concat(chunks).toString());}catch {throw new IntakeError('INVALID_JSON',400);}
}
function keys(value,allowed) {if(!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).some(key=>!allowed.includes(key)))throw new IntakeError('INVALID_REQUEST',400);}

export async function createWorkspaceApp({site=path.join(root,'public/workspace'),storage=path.join(PRIVATE_ROOT,'molyvi-task-preview'),workerDelayMs=250,photoReviewer,reviewQueueOptions={},productProvider,productionQueueOptions={},serviceProvider,serviceProductionOptions={},servicePayments,allowDemoOrders=true,customerAccess,deployment}={}) {
  const boundary=createRequestBoundary(deployment);
  if(boundary.hosted&&(!customerAccess||photoReviewer||productProvider||serviceProvider||servicePayments))throw new IntakeError('HOSTED_STAGING_CUSTOMER_MODE_REQUIRED',500);
  if(customerAccess){if(servicePayments)throw new IntakeError('CUSTOMER_PAYMENT_MODE_CONFLICT',500);allowDemoOrders=false;}
  const realSite=await fs.realpath(site),store=await new TaskStore(storage).ready();
  const overlap=path.relative(realSite,store.storage);
  const reverse=path.relative(store.storage,realSite);
  if(!overlap || (!overlap.startsWith('..')&&!path.isAbsolute(overlap)) || !reverse || (!reverse.startsWith('..')&&!path.isAbsolute(reverse)))throw new IntakeError('PRIVATE_STORAGE_OVERLAPS_SITE',500);
  const sessions=new Map(),pumps=new Map();
  const paymentBridge=servicePayments?createServicePaymentBridge({...servicePayments,store}):null;
  const sessionCookie=(session)=>{const token=crypto.randomBytes(32).toString('hex');sessions.set(token,session);return `molyvi_demo=${token}; HttpOnly; SameSite=Strict; Path=/`;};
  const photoQueue=createPhotoReviewQueue({...reviewQueueOptions,store,provider:photoReviewer,enabled:Boolean(photoReviewer)});
  const productQueue=createProductProductionQueue({...productionQueueOptions,store,provider:productProvider,enabled:Boolean(productProvider)});
  const serviceQueue=createServiceProductionQueue({...serviceProductionOptions,store,provider:serviceProvider,enabled:Boolean(serviceProvider)});
  const view=record=>{
    const visible=viewWorkspace(record),queues=publicPhotoReviewQueue(record);
    visible.serviceProduction=serviceQueue.status();
    visible.productProduction=publicProductProductionQueue(record).map(job=>
      !productProvider&&['queued','running'].includes(job.status)?{...job,status:'paused',reason:'provider_unavailable'}:
      productQueue.status().lastError&&['queued','running'].includes(job.status)?{...job,status:'paused',reason:'automatic_production_unavailable'}:job);
    visible.photoClaims=visible.photoClaims.map(claim=>{
      let reviewQueue=queues.find(item=>item.claimId===claim.id)??null;
      if(reviewQueue&&!photoReviewer&&['queued','running'].includes(reviewQueue.status))reviewQueue={...reviewQueue,status:'paused',reason:'provider_unavailable'};
      else if(reviewQueue&&photoQueue.status().lastError&&['queued','running'].includes(reviewQueue.status))reviewQueue={...reviewQueue,status:'paused',reason:'automatic_review_unavailable'};
      return {...claim,reviewQueue};
    });
    return visible;
  };
  let closing=false,activeDownloads=0,activeRequests=0;
  const signalPhotoQueue=()=>{if(!closing)void photoQueue.tick().catch(()=>{/* Persisted queue state retains evidence and bounded recovery. */});};
  const signalProductQueue=()=>{if(!closing)void productQueue.tick().catch(()=>{/* Persisted attempts prevent blind retries. */});};
  const pump=session=>{
    if(closing || pumps.has(session.projectId))return;
    if(serviceProvider)void serviceQueue.tick();
    const running=(async()=>{
      while(!closing) {
        const {result:job}=await store.transact(session.projectId,session.ownerId,record=>record.order.paymentMode==='local_simulation'?claimJob(record):null);
        if(!job)return;
        await new Promise(resolve=>setTimeout(resolve,workerDelayMs));
        // Synthetic worker: zero provider calls, no generated image/logo, no Shopify writes.
        await store.transact(session.projectId,session.ownerId,record=>finishJob(record,{jobId:job.id,leaseToken:job.lease.token,success:true,costEur:0,
          output:{simulated:true,taskId:job.taskId,phase:job.phase,submissionHash:job.inputs.submissionHash,message:job.phase==='preflight'?'Δοκιμαστικός έλεγχος ολοκληρώθηκε.':'Δοκιμαστικό αποτέλεσμα ροής — δεν είναι παραδοτέο.'}}));
      }
    })().catch(()=>{/* Keep persisted running leases for bounded reconciliation; never replay unknown work. */}).finally(()=>pumps.delete(session.projectId));
    pumps.set(session.projectId,running);
  };
  const server=http.createServer(async(req,res)=>{
    if(boundary.hosted){
      if(activeRequests>=8){res.setHeader('Connection','close');return json(res,429,{error:'SERVER_BUSY'});}
      activeRequests++;let released=false;const release=()=>{if(!released){released=true;activeRequests--;}};res.once('finish',release);res.once('close',release);
    }
    try {
      const port=server.address()?.port,{origin,client,health}=boundary.inspect(req,port),url=new URL(req.url,origin);
      if(boundary.hosted){res.setHeader('Strict-Transport-Security','max-age=31536000');res.setHeader('Referrer-Policy','no-referrer');}
      if(health){customerAccess.accounts.db.prepare('SELECT 1').get();return json(res,200,req.method==='HEAD'?undefined:{status:'ok'});}
      // Server-to-server delivery uses HMAC, not a browser session or Origin.
      if(url.pathname==='/webhooks/shopify/orders-paid'&&req.method==='POST'){
        if(!paymentBridge)throw new IntakeError('PAYMENT_ADAPTER_UNAVAILABLE',503);
        if(req.headers.origin||req.headers['sec-fetch-site'])throw new IntakeError('PAYMENT_SERVER_DELIVERY_REQUIRED',403);
        if(!/^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers['content-type']??''))throw new IntakeError('JSON_REQUIRED',415);
        const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>1_048_576)throw new IntakeError('PAYLOAD_TOO_LARGE',413);chunks.push(chunk);}
        return json(res,200,await paymentBridge.receive(Buffer.concat(chunks),req.headers));
      }
      // Opening the public sign-in page from an email or another site is a
      // normal top-level navigation. Cross-site API/subresource requests remain blocked.
      const publicEntryNavigation=boundary.hosted&&['GET','HEAD'].includes(req.method)&&['/','/customer/'].includes(url.pathname)&&req.headers['sec-fetch-mode']==='navigate'&&req.headers['sec-fetch-dest']==='document';
      if(req.headers.origin && req.headers.origin!==origin || req.headers['sec-fetch-site']==='cross-site'&&!publicEntryNavigation)throw new IntakeError('ORIGIN_NOT_ALLOWED',403);
      if(url.pathname.startsWith('/api/')) {
        if(req.method==='POST' && req.headers.origin!==origin)throw new IntakeError('ORIGIN_REQUIRED',403);
        if(url.pathname==='/api/service-config'&&req.method==='GET')return json(res,200,{allowDemoOrders,servicePayments:paymentBridge?.status()??null,customerAccess:Boolean(customerAccess),customerCodeRequests:Boolean(customerAccess?.notifications),deploymentMode:boundary.hosted?'hosted_staging':'local_test',realEmailEnabled:Boolean(customerAccess?.notifications?.transport?.enabled)});
        if(customerAccess?.notifications&&url.pathname==='/api/customer/request-code'&&req.method==='POST'){
          const command=await body(req,1024);keys(command,['address']);
          return json(res,202,customerAccess.notifications.requestCode({...command,client}));
        }
        if(customerAccess&&url.pathname==='/api/customer/login'&&req.method==='POST'){
          const command=await body(req,1024);keys(command,['address','code']);
          const login=customerAccess.accounts.login({...command,client});
          return json(res,200,{signedIn:true},{'Set-Cookie':`${boundary.cookieName}=${login.token}${boundary.cookieSuffix}; Max-Age=${Math.floor((login.expires-customerAccess.accounts.now())/1000)}`});
        }
        const customerToken=customerAccess?String(req.headers.cookie??'').split(';').map(p=>p.trim()).find(p=>p.startsWith(boundary.cookieName+'='))?.slice(boundary.cookieName.length+1):null;
        const customerSession=customerAccess?customerAccess.accounts.authenticate(customerToken):null;
        if(customerSession&&req.method==='POST')customerAccess.accounts.assertCsrf(customerSession,req.headers['x-molyvi-csrf']);
        if(customerSession&&url.pathname==='/api/customer/me'&&req.method==='GET')return json(res,200,customerAccess.accounts.view(customerSession));
        if(customerSession&&url.pathname==='/api/customer/select'&&req.method==='POST'){
          const command=await body(req,1024);keys(command,['projectId']);
          const selected=customerAccess.accounts.select(customerToken,command.projectId);return json(res,200,customerAccess.accounts.view(selected));
        }
        if(customerSession&&url.pathname==='/api/customer/logout'&&req.method==='POST'){
          keys(await body(req,1024),[]);customerAccess.accounts.logout(customerToken);
          return json(res,200,{signedOut:true},{'Set-Cookie':`${boundary.cookieName}=${boundary.cookieSuffix}; Max-Age=0`});
        }
        if(customerSession&&url.pathname==='/api/customer/review'&&req.method==='POST'){
          const command=await body(req,2048);keys(command,['deliveryId','manifestHash','acknowledged']);
          await customerAccess.deliveries.verify(customerAccess.accounts.delivery(customerSession.accountId,command.deliveryId));
          return json(res,200,customerAccess.accounts.review(customerSession,command));
        }
        if(url.pathname==='/api/service-intent'&&req.method==='POST'){
          if(!paymentBridge)throw new IntakeError('PAYMENT_ADAPTER_UNAVAILABLE',503);
          const command=await body(req);keys(command,['packageId']);
          const opened=await paymentBridge.openIntent(command);
          return json(res,201,{workspace:view(opened.record),accessKey:opened.accessKey,checkoutConfigured:opened.checkoutConfigured},
            {'Set-Cookie':sessionCookie(opened.session)});
        }
        if(url.pathname==='/api/service-access'&&req.method==='POST'){
          if(!paymentBridge)throw new IntakeError('PAYMENT_ADAPTER_UNAVAILABLE',503);
          const command=await body(req,1024);keys(command,['accessKey']);
          const session=await paymentBridge.access(command.accessKey);
          return json(res,200,view(await store.read(session.projectId,session.ownerId)),{'Set-Cookie':sessionCookie(session)});
        }
        if(url.pathname==='/api/demo-order' && req.method==='POST') {
          if(!allowDemoOrders)throw new IntakeError('DEMO_ORDER_DISABLED',409);
          keys(await body(req),[]);
          const ownerId=crypto.randomUUID(),token=crypto.randomBytes(32).toString('hex');
          const project=createWorkspace({ownerId,order:createPaidOrder({id:`DEMO-${crypto.randomUUID()}`,packageId:'basic',branding:false}),budgetEur:0});
          await store.create(project);
          sessions.set(token,{ownerId,projectId:project.id});
          return json(res,201,view(project),{'Set-Cookie':`molyvi_demo=${token}; HttpOnly; SameSite=Strict; Path=/`});
        }
        const cookie=String(req.headers.cookie??'').split(';').map(part=>part.trim()).find(part=>part.startsWith('molyvi_demo='))?.slice(12);
        const session=customerSession??sessions.get(cookie);
        if(!session)throw new IntakeError('SESSION_REQUIRED',401);
        if(!session.projectId)throw new IntakeError('PROJECT_REQUIRED',409);
        if(url.pathname==='/api/service-checkout'&&req.method==='POST'){
          if(!paymentBridge)throw new IntakeError('PAYMENT_ADAPTER_UNAVAILABLE',503);
          keys(await body(req),[]);
          return json(res,200,await paymentBridge.checkout(session));
        }
        if(url.pathname==='/api/logo-upload' && req.method==='POST') {
          const command=await body(req,6_000_000);keys(command,['name','mime','data']);
          const {record,result}=await uploadLogo(store,session,command);
          return json(res,201,{workspace:view(record),receipt:result});
        }
        if(url.pathname.startsWith('/api/logo/') && req.method==='GET') {
          const {asset,bytes}=await readLogo(store,session,url.pathname.slice(10));
          res.writeHead(200,{'Content-Type':asset.mime,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'"});res.end(bytes);return;
        }
        if(url.pathname==='/api/photo-upload' && req.method==='POST') {
          const command=await body(req,14_000_000);keys(command,['productId','name','mime','data']);
          const {record,result}=await uploadPhoto(store,session,command);
          return json(res,201,{workspace:view(record),receipt:result});
        }
        if(url.pathname.startsWith('/api/photo/') && req.method==='GET') {
          const {asset,bytes}=await readPhoto(store,session,url.pathname.slice(11));
          res.writeHead(200,{'Content-Type':asset.mime,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'"});res.end(bytes);return;
        }
        if(url.pathname==='/api/photo-review' && req.method==='POST') {
          const command=await body(req);keys(command,['action','productId','visualUnitId','reviewId','fingerprint','acknowledged']);
          if(!['review','confirm'].includes(command.action))throw new IntakeError('INVALID_ACTION',400);
          const {record,result}=await store.transact(session.projectId,session.ownerId,record=>{
            const receipt=command.action==='review'?requestPhotoReview(record,command):confirmPhotoIdentity(record,command);
            if(command.action==='review')enqueuePendingProductProduction(record);
            return receipt;
          });
          json(res,200,{workspace:view(record),receipt:result});
          if(command.action==='review')signalProductQueue();
          return;
        }
        if(url.pathname==='/api/product-text' && req.method==='POST') {
          const command=await body(req);keys(command,['action','productId','field','requestId','variantId']);
          if(!['request','select'].includes(command.action))throw new IntakeError('INVALID_ACTION',400);
          const {record,result}=await store.transact(session.projectId,session.ownerId,record=>{
            const receipt=command.action==='request'?requestTextVariant(record,command):selectTextVariant(record,command);
            if(command.action==='request')enqueuePendingProductProduction(record);
            return receipt;
          });
          json(res,200,{workspace:view(record),receipt:result});
          if(command.action==='request')signalProductQueue();
          return;
        }
        if(url.pathname.startsWith('/api/generated-photo/') && req.method==='GET') {
          const {asset,bytes}=await readGeneratedPhoto(store,session,url.pathname.slice('/api/generated-photo/'.length));
          res.writeHead(200,{'Content-Type':asset.mime,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'"});res.end(bytes);return;
        }
        if(url.pathname==='/api/product-gallery' && req.method==='POST') {
          const command=await body(req);keys(command,['action','productId','slotId','galleryHash','revision','candidateId','order','requestId','mode','change','entitlementId']);
          if(!['select','layout','request','replacement'].includes(command.action))throw new IntakeError('INVALID_ACTION',400);
          if(command.entitlementId!==undefined&&command.action!=='replacement')throw new IntakeError('INVALID_REQUEST',400);
          const operation={select:selectPhotoCandidate,layout:setPhotoLayout,request:requestPhotoRegeneration,replacement:requestPhotoReplacement}[command.action];
          const {record,result}=await store.transact(session.projectId,session.ownerId,record=>operation(record,command));
          return json(res,200,{workspace:view(record),receipt:result});
        }
        if(url.pathname==='/api/photo-claims' && req.method==='POST') {
          const command=await body(req);
          if(command?.action==='open')keys(command,['action','productId','slotId','candidateId','galleryHash','requestId','kind','description']);
          else if(command?.action==='escalate')keys(command,['action','claimId']);
          else throw new IntakeError('INVALID_ACTION',400);
          const operation=command.action==='open'?openPhotoClaim:requestClaimEscalation;
          const {action,...payload}=command;
          const {record,result}=await store.transact(session.projectId,session.ownerId,record=>{
            const receipt=operation(record,payload);
            if(action==='open')enqueuePhotoClaimReview(record,{claimId:receipt.id});
            return receipt;
          });
          json(res,200,{workspace:view(record),receipt:result});
          if(action==='open')signalPhotoQueue();
          return;
        }
        if(url.pathname==='/api/product' && req.method==='POST') {
          const command=await body(req,1_048_576);keys(command,['action','product','revision','acknowledged']);
          if(!['save','skip','submit'].includes(command.action))throw new IntakeError('INVALID_ACTION',400);
          const {record,result}=await store.transact(session.projectId,session.ownerId,record=>command.action==='submit'?submitProduct(record,command):editProduct(record,command));
          json(res,200,{workspace:view(record),receipt:result});pump(session);return;
        }
        if(url.pathname==='/api/workspace' && req.method==='GET') {
          const record=await store.read(session.projectId,session.ownerId);json(res,200,view(record));pump(session);return;
        }
        if(url.pathname==='/api/project-contract' && req.method==='GET') {
          return json(res,200,await exportProjectContract(store,session),{'Content-Disposition':'attachment; filename="molyvi-project-specification.json"'});
        }
        if(url.pathname==='/api/content-preview' && req.method==='GET') {
          return json(res,200,previewStoreContent(await store.read(session.projectId,session.ownerId)));
        }
        if(url.pathname==='/api/content-review' && req.method==='POST') {
          const command=await body(req,1024);keys(command,['bundleHash','acknowledged']);
          const {record,result}=await store.transact(session.projectId,session.ownerId,record=>reviewStoreContent(record,command));
          return json(res,200,{preview:previewStoreContent(record),receipt:result});
        }
        if(url.pathname==='/api/shipping-estimate' && req.method==='POST') {
          const command=await body(req,8192);keys(command,['revision','scenario']);
          const record=await store.read(session.projectId,session.ownerId),task=record.tasks.operations;
          if(command.revision!==task.revision)throw new IntakeError('DRAFT_CONFLICT',409);
          const plan=(task.submission?.answers??task.draft).shippingPlan;
          if(!plan)throw new IntakeError('SHIPPING_PLAN_REQUIRED',422,{field:'shippingPlan'});
          return json(res,200,{estimate:estimateShipping(record.order,plan,command.scenario)});
        }
        if(url.pathname==='/api/task' && req.method==='POST') {
          const command=await body(req,262_144);keys(command,['action','taskId','answers','revision','acknowledged','resultHash']);
          if(!['save','skip','submit','approve'].includes(command.action))throw new IntakeError('INVALID_ACTION',400);
          if(command.action==='submit'&&command.taskId==='catalog')throw new IntakeError('PRODUCT_SUBMISSION_REQUIRED',409);
          const {record,result}=await store.transact(session.projectId,session.ownerId,record=>{
            if(command.action==='submit')return submitTask(record,command);
            if(command.action==='approve')return approveTask(record,command);
            return editTask(record,command);
          });
          json(res,200,{workspace:view(record),receipt:result??null});pump(session);return;
        }
        throw new IntakeError('NOT_FOUND',404);
      }
      if(!['GET','HEAD'].includes(req.method))throw new IntakeError('METHOD_NOT_ALLOWED',405);
      if(customerAccess&&url.pathname.startsWith('/customer-files/')){
        const token=String(req.headers.cookie??'').split(';').map(p=>p.trim()).find(p=>p.startsWith(boundary.cookieName+'='))?.slice(boundary.cookieName.length+1);
        const session=customerAccess.accounts.authenticate(token),match=url.pathname.match(/^\/customer-files\/([a-f0-9-]+)\/(.+)$/);
        if(!match||url.search)throw new IntakeError('NOT_FOUND',404);
        if(activeDownloads>=2){res.setHeader('Retry-After','5');throw new IntakeError('DOWNLOAD_BUSY',429);}activeDownloads++;
        let file;
        try{
          file=typeof customerAccess.deliveries.openForStream==='function'?await customerAccess.deliveries.openForStream(session,match[1],match[2]):await customerAccess.deliveries.read(session,match[1],match[2]);
          res.writeHead(200,{'Content-Type':file.type,'Content-Length':file.size??file.bytes.length,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; img-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",...(req.url.endsWith('.zip')?{'Content-Disposition':`attachment; filename="${file.name}"`}:{})});
          if(req.method==='HEAD'||file.size===0)res.end();
          else if(file.handle)await pipeline(file.handle.createReadStream({start:0,autoClose:false,highWaterMark:64*1024}),res);
          else res.end(file.bytes);
          return;
        }finally{await file?.handle?.close();activeDownloads--;}
      }
      const name=new Map([['/',customerAccess?'customer.html':'index.html'],['/customer/','customer.html'],['/customer.js','customer.js'],['/customer.css','customer.css'],['/workspace/','index.html'],['/workspace.js','workspace.js'],['/products.js','products.js'],['/catalog-editor.js','catalog-editor.js'],['/gallery.js','gallery.js'],['/shipping.js','shipping.js'],['/merchant-payments.js','merchant-payments.js'],['/store-content.js','store-content.js'],['/workspace.css','workspace.css']]).get(url.pathname);
      if(name?.startsWith('customer')&&!customerAccess)throw new IntakeError('NOT_FOUND',404);
      if(!name)throw new IntakeError('NOT_FOUND',404);
      const target=await fs.realpath(path.join(realSite,name));
      if(path.dirname(target)!==realSite)throw new IntakeError('NOT_FOUND',404);
      const data=await fs.readFile(target),type=name.endsWith('.html')?'text/html':name.endsWith('.js')?'text/javascript':'text/css';
      res.writeHead(200,{'Content-Type':`${type}; charset=utf-8`,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',
        'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'"});
      res.end(req.method==='HEAD'?undefined:data);
    }catch(error) {if(!res.headersSent)json(res,error instanceof IntakeError?error.status:500,{error:error instanceof IntakeError?error.code:'INTERNAL_ERROR',field:error.details?.field});else res.destroy();}
  });
  server.requestTimeout=10_000;server.headersTimeout=10_000;
  if(boundary.hosted){server.maxConnections=32;server.maxHeadersCount=50;server.setTimeout(30_000,socket=>socket.destroy());}
  server.on('listening',()=>{void photoQueue.start().catch(()=>{/* No unaudited provider fallback after a startup failure. */});});
  server.on('listening',()=>{void productQueue.start().catch(()=>{/* No paid API fallback. */});});
  server.on('listening',()=>{void serviceQueue.start().catch(()=>{/* Keep stored attempts; no provider fallback. */});});
  server.on('close',()=>{closing=true;sessions.clear();void photoQueue.stop().catch(()=>{});void productQueue.stop().catch(()=>{});void serviceQueue.stop().catch(()=>{});});
  server.drainWorkers=async()=>{closing=true;await Promise.allSettled([...pumps.values(),photoQueue.stop(),productQueue.stop(),serviceQueue.stop()]);};
  // Trusted local lifecycle handle; this is never exposed through HTTP.
  server.photoReviewQueue=photoQueue;
  server.productProductionQueue=productQueue;
  server.serviceProductionQueue=serviceQueue;
  // Trusted in-process operators share the exact same per-project lock as HTTP
  // customers and workers. This handle and result importers have no HTTP route.
  server.workspaceStore=store;
  server.servicePaymentBridge=paymentBridge;
  return server;
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const {values}=parseArgs({options:{port:{type:'string',default:'8877'},site:{type:'string'},storage:{type:'string'},'auto-photo-reviews':{type:'boolean',default:false},'auto-product-production':{type:'boolean',default:false},'product-attempt-limit':{type:'string',default:'12'}}});
  const port=Number(values.port);if(!Number.isInteger(port)||port<1||port>65535)throw new Error('INVALID_PORT');
  const dailyAttemptLimit=Number(values['product-attempt-limit']);if(!Number.isSafeInteger(dailyAttemptLimit)||dailyAttemptLimit<1||dailyAttemptLimit>1000)throw new Error('INVALID_PRODUCTION_QUEUE_CONFIG');
  let photoReviewer;
  if(values['auto-photo-reviews']){
    const {createCodexPhotoReviewer}=await import('./lib/codex-photo-reviewer.mjs');
    photoReviewer=createCodexPhotoReviewer();
    if(typeof photoReviewer.preflight==='function')await photoReviewer.preflight();
  }
  let productProvider;
  if(values['auto-product-production']){
    const {createCodexProductProvider}=await import('./lib/codex-product-provider.mjs');
    productProvider=createCodexProductProvider({storage:values.storage?path.join(values.storage,'product-provider'):path.join(PRIVATE_ROOT,'molyvi-task-preview','product-provider')});
    await productProvider.preflight();
  }
  const server=await createWorkspaceApp({...(values.site?{site:values.site}:{}),...(values.storage?{storage:values.storage}:{}),photoReviewer,productProvider,productionQueueOptions:{dailyAttemptLimit}});
  server.listen(port,'127.0.0.1',()=>process.stdout.write(`Molyvi task preview: http://127.0.0.1:${port}/ — simulated paid order; photo claims: ${photoReviewer?'automatic Codex ChatGPT reviews':'provider disabled'}; product source/text: ${productProvider?'automatic Codex ChatGPT':'provider disabled'}.\n`));
  const shutdown=async()=>{await server.drainWorkers();if(server.listening)await new Promise(resolve=>server.close(resolve));};
  process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
}
