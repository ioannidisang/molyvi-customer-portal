import fs from 'node:fs/promises';
import path from 'node:path';
import {constants} from 'node:fs';
import crypto from 'node:crypto';
import {IntakeError,prepareStorage} from './intake-store.mjs';
import {ordinaryFile,safeRelative,sha256} from './service-handoff.mjs';
import {deliveryReviewStatus} from './delivery-review-status.mjs';
import {FeedbackManagement} from './feedback-management.mjs';
import {MinorAdjustments} from './minor-adjustments.mjs';
import {DeliveryRevision} from './delivery-revision.mjs';
import {DeliveryFinalRelease} from './delivery-final-release.mjs';

const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.txt':'text/plain; charset=utf-8','.md':'text/plain; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp','.pdf':'application/pdf','.zip':'application/zip'};
const fail=(code,status=409)=>{throw new IntakeError(code,status);};
export class CustomerDelivery {
  constructor({accounts,workspaces,storage,notifications}){this.accounts=accounts;this.workspaces=workspaces;this.storage=storage;this.notifications=notifications;}
  async ready(){this.storage=await prepareStorage(this.storage);return this;}
  async grantProject({accountId,projectId,ownerId,label}){
    const record=await this.workspaces.read(projectId,ownerId);
    if(record.order.status!=='verified_paid'&&record.order.paymentMode!=='local_simulation')fail('PAID_PROJECT_REQUIRED');
    this.accounts.grant({accountId,projectId,ownerId,label,orderId:record.order.id});
  }
  async importHandoff({accountId,projectId,sourceRun,manifestHash,zipHash}){
    const project=this.accounts.project(accountId,projectId),source=path.join(sourceRun,'delivery');
    const raw=await ordinaryFile(source,'delivery-manifest.json'),manifest=JSON.parse(raw);
    if(sha256(raw)!==manifestHash||manifest.projectId!==projectId||manifest.serviceOrderId!==project.order_id||manifest.customerAccepted!==false||manifest.published!==false)fail('DELIVERY_IDENTITY_MISMATCH');
    const receipt=JSON.parse(await ordinaryFile(sourceRun,'delivery-zip-receipt.json'));
    if(receipt.projectId!==projectId||receipt.serviceOrderId!==project.order_id||receipt.deliveryManifestSha256!==manifestHash||receipt.sha256!==zipHash)fail('DELIVERY_ZIP_MISMATCH');
    const entries=[],seen=new Set();
    for(const f of manifest.files){
      safeRelative(f.file);if(seen.has(f.file)||['delivery-manifest.json','Molyvi-Service-Delivery.zip'].includes(f.file))fail('DELIVERY_DUPLICATE_FILE');seen.add(f.file);
      const bytes=await ordinaryFile(source,f.file);if(bytes.length!==f.bytes||sha256(bytes)!==f.sha256)fail('DELIVERY_FILE_CHANGED');entries.push({...f,bytes});
    }
    const zip=await ordinaryFile(sourceRun,'Molyvi-Service-Delivery.zip');if(zip.length!==receipt.bytes||sha256(zip)!==receipt.sha256)fail('DELIVERY_ZIP_CHANGED');
    // Files are prepared first. Database visibility is registered only after every copy is durable.
    const existing=this.accounts.db.prepare('SELECT * FROM deliveries WHERE project_id=? AND manifest_hash=?').get(projectId,manifestHash);
    if(existing){await this.verify(existing);this.notifications?.deliveryPrepared({accountId,deliveryId:existing.id});return {id:existing.id,duplicate:true};}
    const folder=manifestHash;
    const dest=path.join(this.storage,folder);await fs.mkdir(dest,{recursive:false,mode:0o700});
    for(const e of [...entries,{file:'delivery-manifest.json',bytes:raw},{file:'Molyvi-Service-Delivery.zip',bytes:zip}]){
      const target=path.join(dest,safeRelative(e.file));await fs.mkdir(path.dirname(target),{recursive:true,mode:0o700});
      const handle=await fs.open(target,'wx',0o600);try{await handle.writeFile(e.bytes);await handle.sync();}finally{await handle.close();}
    }
    const delivery=this.accounts.registerDelivery({projectId,manifestHash,zipHash:receipt.sha256});this.accounts.audit('delivery_prepared',accountId,delivery.id);
    this.notifications?.deliveryPrepared({accountId,deliveryId:delivery.id});
    return {id:delivery.id,duplicate:false};
  }
  async manifest(delivery){const root=path.join(this.storage,delivery.manifest_hash),raw=await ordinaryFile(root,'delivery-manifest.json');if(sha256(raw)!==delivery.manifest_hash)fail('DELIVERY_FILE_CHANGED');return {root,raw,model:JSON.parse(raw)};}
  async verify(delivery){const m=await this.manifest(delivery);for(const f of m.model.files){const b=await ordinaryFile(m.root,f.file);if(b.length!==f.bytes||sha256(b)!==f.sha256)fail('DELIVERY_FILE_CHANGED');}const zip=await ordinaryFile(m.root,'Molyvi-Service-Delivery.zip');if(sha256(zip)!==delivery.zip_hash)fail('DELIVERY_FILE_CHANGED');return true;}
  async reviewStatus(session,id){
    const delivery=this.accounts.delivery(session.accountId,id),project=this.accounts.project(session.accountId,delivery.project_id),m=await this.manifest(delivery);
    const entry=m.model.files.find(f=>f.file==='catalogue.json');let catalogue=null;
    if(entry){const b=await ordinaryFile(m.root,'catalogue.json');if(b.length!==entry.bytes||sha256(b)!==entry.sha256)fail('DELIVERY_FILE_CHANGED');catalogue=JSON.parse(b);}
    const record=await this.workspaces.read(project.id,project.owner_id);
    return {deliveryId:id,manifestHash:delivery.manifest_hash,...deliveryReviewStatus(record,{manifest:m.model,catalogue})};
  }
  async recordFeedback(session,command){
    const delivery=this.accounts.delivery(session.accountId,command.deliveryId);
    if(delivery.manifest_hash!==command.manifestHash)fail('DELIVERY_VERSION_CHANGED');
    const m=await this.manifest(delivery),project=this.accounts.project(session.accountId,delivery.project_id);
    if(m.model.projectId!==project.id||m.model.serviceOrderId!==project.order_id)fail('DELIVERY_IDENTITY_MISMATCH');
    return this.accounts.recordFeedback(session,command);
  }
  async replyToFeedback(session,command){
    const manager=new FeedbackManagement(this.accounts),row=manager.binding(session,command),project=manager.assertAccess(session,command.projectId),delivery=this.accounts.db.prepare('SELECT * FROM deliveries WHERE id=?').get(row.delivery_id),m=await this.manifest(delivery);
    if(m.model.projectId!==project.id||m.model.serviceOrderId!==project.orderId)fail('DELIVERY_IDENTITY_MISMATCH');
    return manager.reply(session,command);
  }
  async proposeMinorAdjustment(session,command){
    const adjustments=new MinorAdjustments(this.accounts),row=adjustments.operatorBinding(session,command),delivery=this.accounts.db.prepare('SELECT * FROM deliveries WHERE id=?').get(row.delivery_id),project=new FeedbackManagement(this.accounts).assertAccess(session,command.projectId),m=await this.manifest(delivery);
    if(m.model.projectId!==project.id||m.model.serviceOrderId!==project.orderId)fail('DELIVERY_IDENTITY_MISMATCH');
    const receipt=adjustments.propose(session,command);return {...receipt,inbox:new FeedbackManagement(this.accounts).inbox(session,command.projectId)};
  }
  async approveMinorAdjustment(session,command){
    const adjustments=new MinorAdjustments(this.accounts),{delivery}=adjustments.customerBinding(session,command),project=this.accounts.project(session.accountId,delivery.project_id),m=await this.manifest(delivery);
    if(m.model.projectId!==project.id||m.model.serviceOrderId!==project.order_id)fail('DELIVERY_IDENTITY_MISMATCH');
    const receipt=adjustments.approve(session,command);return {...receipt,feedback:this.accounts.feedback(session,command.deliveryId)};
  }
  async planMinorAdjustment(session,command){const receipt=await new DeliveryRevision(this).stage(session,command);return {...receipt,inbox:new FeedbackManagement(this.accounts).inbox(session,command.projectId)};}
  async executeMinorAdjustment(session,command){const receipt=await new DeliveryRevision(this).execute(session,command);return {...receipt,inbox:new FeedbackManagement(this.accounts).inbox(session,command.projectId)};}
  async reviewAdjustmentRevision(session,command){const receipt=await new DeliveryFinalRelease(this).review(session,command);return {...receipt,inbox:new FeedbackManagement(this.accounts).inbox(session,command.projectId)};}
  async deliverAdjustmentRevision(session,command){const receipt=await new DeliveryFinalRelease(this).release(session,command);return {...receipt,inbox:new FeedbackManagement(this.accounts).inbox(session,command.projectId)};}
  async read(session,id,file){
    const delivery=this.accounts.delivery(session.accountId,id);let relative;
    try{relative=safeRelative(file);}catch{fail('NOT_FOUND',404);}
    const m=await this.manifest(delivery);
    let bytes,expected=m.model.files.find(f=>f.file===relative);
    if(relative==='delivery-manifest.json')bytes=m.raw;
    else if(relative==='Molyvi-Service-Delivery.zip'){bytes=await ordinaryFile(m.root,relative);if(sha256(bytes)!==delivery.zip_hash)fail('DELIVERY_FILE_CHANGED');}
    else if(expected){bytes=await ordinaryFile(m.root,relative);if(bytes.length!==expected.bytes||sha256(bytes)!==expected.sha256)fail('DELIVERY_FILE_CHANGED');}
    else fail('NOT_FOUND',404);
    this.accounts.audit('file_opened',session.accountId,id);
    return {bytes,type:types[path.extname(relative)]??'application/octet-stream',name:path.basename(relative)};
  }
  async openForStream(session,id,file){
    const delivery=this.accounts.delivery(session.accountId,id);let relative;
    try{relative=safeRelative(file);}catch{fail('NOT_FOUND',404);}
    const m=await this.manifest(delivery),entry=m.model.files.find(f=>f.file===relative);
    const expected=relative==='delivery-manifest.json'?{sha256:delivery.manifest_hash,bytes:m.raw.length}:
      relative==='Molyvi-Service-Delivery.zip'?{sha256:delivery.zip_hash}:entry;
    if(!expected)fail('NOT_FOUND',404);
    let target=m.root;
    for(const part of ['',...relative.split('/')]){if(part)target=path.join(target,part);if((await fs.lstat(target)).isSymbolicLink())fail('DELIVERY_FILE_CHANGED');}
    const handle=await fs.open(target,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
    try{
      const before=await handle.stat();if(!before.isFile()||expected.bytes!==undefined&&before.size!==expected.bytes)fail('DELIVERY_FILE_CHANGED');
      const hash=crypto.createHash('sha256');
      // Verify before sending headers, without loading a ZIP into memory.
      for await(const chunk of handle.createReadStream({start:0,autoClose:false,highWaterMark:64*1024}))hash.update(chunk);
      const after=await handle.stat();
      if(hash.digest('hex')!==expected.sha256||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ino!==after.ino)fail('DELIVERY_FILE_CHANGED');
      this.accounts.audit('file_opened',session.accountId,id);
      return {handle,size:before.size,type:types[path.extname(relative)]??'application/octet-stream',name:path.basename(relative)};
    }catch(e){await handle.close();throw e;}
  }
}
