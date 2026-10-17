import crypto from 'node:crypto';
import {IntakeError} from './intake-store.mjs';
import {MinorAdjustments} from './minor-adjustments.mjs';
import {AdjustmentExecution} from './adjustment-execution.mjs';

const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(v);
const fail=(code,status=403)=>{throw new IntakeError(code,status);};
export const FEEDBACK_STATUSES=['in_review','needs_information','answered'];
export const FEEDBACK_DISPOSITIONS=['small_adjustment','clarification','photo_regeneration','photo_claim','outside_scope','other'];
// Additive extension only; core customer schema and previous releases remain compatible.
export const FEEDBACK_MANAGEMENT_SCHEMA=`
CREATE TABLE IF NOT EXISTS feedback_operator_grants(account_id TEXT NOT NULL REFERENCES accounts(id),project_id TEXT NOT NULL REFERENCES projects(id),label TEXT NOT NULL,granted INTEGER NOT NULL,PRIMARY KEY(account_id,project_id));
CREATE TABLE IF NOT EXISTS feedback_replies(id TEXT PRIMARY KEY,feedback_id TEXT NOT NULL REFERENCES delivery_feedback(id),operator_account_id TEXT NOT NULL REFERENCES accounts(id),request_id TEXT NOT NULL,manifest_hash TEXT NOT NULL,expected_revision INTEGER NOT NULL,status TEXT NOT NULL,disposition TEXT NOT NULL,message TEXT NOT NULL,created INTEGER NOT NULL,UNIQUE(operator_account_id,request_id),UNIQUE(feedback_id,expected_revision));
CREATE INDEX IF NOT EXISTS feedback_replies_feedback ON feedback_replies(feedback_id,expected_revision);
CREATE INDEX IF NOT EXISTS feedback_replies_operator ON feedback_replies(operator_account_id,created);`;

export class FeedbackManagement {
  constructor(accounts){this.accounts=accounts;}
  get db(){return this.accounts.db;}
  // Trusted operator provisioning only: never exposed through HTTP or customer input.
  grant({accountId,projectId,label}){
    if(!uuid(accountId)||!uuid(projectId)||typeof label!=='string'||!label.trim()||label.length>160||/[\x00-\x1f\x7f]/.test(label))fail('INVALID_OPERATOR_GRANT',400);
    return this.accounts.transaction(()=>{
      if(!this.db.prepare('SELECT id FROM accounts WHERE id=?').get(accountId)||!this.db.prepare('SELECT id FROM projects WHERE id=?').get(projectId))fail('NOT_FOUND',404);
      const old=this.db.prepare('SELECT label FROM feedback_operator_grants WHERE account_id=? AND project_id=?').get(accountId,projectId);if(old){if(old.label!==label.trim())fail('OPERATOR_GRANT_CONFLICT',409);return {duplicate:true};}
      this.db.prepare('INSERT INTO feedback_operator_grants VALUES(?,?,?,?)').run(accountId,projectId,label.trim(),this.accounts.now());this.accounts.audit('feedback_operator_granted',accountId,projectId);return {duplicate:false};
    });
  }
  revoke({accountId,projectId}){return this.accounts.transaction(()=>{const result=this.db.prepare('DELETE FROM feedback_operator_grants WHERE account_id=? AND project_id=?').run(accountId,projectId);if(result.changes)this.accounts.audit('feedback_operator_revoked',accountId,projectId);return {revoked:Boolean(result.changes)};});}
  projects(session){return this.db.prepare('SELECT p.id,g.label,p.order_id FROM feedback_operator_grants g JOIN projects p ON p.id=g.project_id WHERE g.account_id=? ORDER BY g.granted,g.rowid').all(session.accountId).map(p=>({id:p.id,label:p.label,orderId:p.order_id}));}
  assertAccess(session,projectId){if(!uuid(projectId))fail('NOT_FOUND',404);const p=this.db.prepare('SELECT p.id,g.label,p.order_id FROM feedback_operator_grants g JOIN projects p ON p.id=g.project_id WHERE g.account_id=? AND g.project_id=?').get(session.accountId,projectId);if(!p)fail('OPERATOR_ACCESS_REQUIRED');return {id:p.id,label:p.label,orderId:p.order_id};}
  history(feedbackId){return this.db.prepare('SELECT id,status,disposition,message,created,expected_revision FROM feedback_replies WHERE feedback_id=? ORDER BY expected_revision').all(feedbackId).map(r=>({id:r.id,status:r.status,disposition:r.disposition,message:r.message,createdAt:new Date(r.created).toISOString(),revision:r.expected_revision+1}));}
  inbox(session,projectId){
    const project=this.assertAccess(session,projectId),deliveries=this.db.prepare('SELECT id,manifest_hash,created FROM deliveries WHERE project_id=? ORDER BY created,rowid').all(projectId).map((d,i)=>({id:d.id,manifestHash:d.manifest_hash,version:i+1,preparedAt:new Date(d.created).toISOString()}));
    const total=this.db.prepare('SELECT count(*) n FROM delivery_feedback f JOIN deliveries d ON d.id=f.delivery_id WHERE d.project_id=?').get(projectId).n;
    const adjustments=new MinorAdjustments(this.accounts),items=this.db.prepare('SELECT f.* FROM delivery_feedback f JOIN deliveries d ON d.id=f.delivery_id WHERE d.project_id=? ORDER BY f.created DESC,f.rowid DESC LIMIT 200').all(projectId).map(r=>{const replies=this.history(r.id);return {id:r.id,deliveryId:r.delivery_id,manifestHash:r.manifest_hash,category:r.category,message:r.message,createdAt:new Date(r.created).toISOString(),revision:replies.length,status:replies.at(-1)?.status??'received',disposition:replies.at(-1)?.disposition??null,replies,adjustmentProposals:adjustments.proposals(r.id)};});
    const executions=new AdjustmentExecution(this.accounts).list(projectId);return {project,deliveries,items,total,truncated:total>items.length,adjustmentAllowance:adjustments.allowance(projectId),adjustmentExecutions:executions,workStarted:executions.some(e=>e.startedAt),creditsCharged:false,published:false};
  }
  binding(session,{projectId,deliveryId,feedbackId,manifestHash}){
    this.assertAccess(session,projectId);if(!uuid(deliveryId)||!uuid(feedbackId))fail('NOT_FOUND',404);
    const row=this.db.prepare('SELECT f.*,d.project_id,d.manifest_hash AS delivery_manifest_hash FROM delivery_feedback f JOIN deliveries d ON d.id=f.delivery_id WHERE f.id=? AND f.delivery_id=? AND d.project_id=?').get(feedbackId,deliveryId,projectId);if(!row)fail('NOT_FOUND',404);if(row.manifest_hash!==manifestHash||row.manifest_hash!==row.delivery_manifest_hash)fail('DELIVERY_VERSION_CHANGED',409);return row;
  }
  reply(session,command){
    const {projectId,deliveryId,feedbackId,manifestHash,requestId,expectedRevision,status,disposition}=command;
    if(!uuid(requestId)||!Number.isSafeInteger(expectedRevision)||expectedRevision<0||!FEEDBACK_STATUSES.includes(status)||!FEEDBACK_DISPOSITIONS.includes(disposition)||typeof command.message!=='string'||!command.message.trim()||command.message.length>2000||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(command.message))fail('INVALID_FEEDBACK_REPLY',422);
    const message=command.message.trim();
    return this.accounts.transaction(()=>{
      this.binding(session,command);
      const old=this.db.prepare('SELECT * FROM feedback_replies WHERE operator_account_id=? AND request_id=?').get(session.accountId,requestId);
      if(old){if(old.feedback_id!==feedbackId||old.manifest_hash!==manifestHash||old.expected_revision!==expectedRevision||old.status!==status||old.disposition!==disposition||old.message!==message)fail('FEEDBACK_REQUEST_CONFLICT',409);return {duplicate:true,id:old.id,inbox:this.inbox(session,projectId)};}
      const revision=this.db.prepare('SELECT count(*) n FROM feedback_replies WHERE feedback_id=?').get(feedbackId).n;if(revision!==expectedRevision)fail('FEEDBACK_REPLY_STALE',409);if(revision>=50)fail('FEEDBACK_REPLY_LIMIT',429);
      if(this.db.prepare('SELECT count(*) n FROM feedback_replies WHERE operator_account_id=? AND created>?').get(session.accountId,this.accounts.now()-60*60*1000).n>=100)fail('FEEDBACK_REPLY_LIMIT',429);
      const id=crypto.randomUUID();this.db.prepare('INSERT INTO feedback_replies VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,feedbackId,session.accountId,requestId,manifestHash,expectedRevision,status,disposition,message,this.accounts.now());this.accounts.audit('delivery_feedback_replied',session.accountId,id);
      return {duplicate:false,id,inbox:this.inbox(session,projectId)};
    });
  }
}
