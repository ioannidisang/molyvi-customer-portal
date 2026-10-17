import crypto from 'node:crypto';
import {IntakeError} from './intake-store.mjs';
import {MinorAdjustments} from './minor-adjustments.mjs';

const fail=(code,status=409)=>{throw new IntakeError(code,status);};
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(v);
export const executionHash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const ADJUSTMENT_EXECUTION_SCHEMA=`
CREATE TABLE IF NOT EXISTS adjustment_executions(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),approval_id TEXT NOT NULL UNIQUE REFERENCES adjustment_approvals(id),operator_account_id TEXT NOT NULL REFERENCES accounts(id),request_id TEXT NOT NULL,plan_hash TEXT NOT NULL UNIQUE,plan_json TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('planned','running','prepared','blocked')),started INTEGER,completed INTEGER,result_hash TEXT,error TEXT,created INTEGER NOT NULL,UNIQUE(operator_account_id,request_id));
CREATE UNIQUE INDEX IF NOT EXISTS adjustment_execution_active ON adjustment_executions(project_id) WHERE state IN ('planned','running','blocked');`;

// The durable journal owns permission and one-attempt execution. The adapter
// owns file preparation. Neither executes prose, AI calls, Shopify or a shell.
export class AdjustmentExecution {
  constructor(accounts){this.accounts=accounts;}
  get db(){return this.accounts.db;}
  binding(session,{projectId,proposalId,proposalHash}){
    if(!uuid(proposalId))fail('NOT_FOUND',404);
    const adjustments=new MinorAdjustments(this.accounts),p=this.db.prepare('SELECT * FROM adjustment_proposals WHERE id=?').get(proposalId);
    if(!p||p.project_id!==projectId)fail('NOT_FOUND',404);
    adjustments.operatorBinding(session,{projectId,deliveryId:p.delivery_id,feedbackId:p.feedback_id,manifestHash:p.manifest_hash});adjustments.verifyProposal(p);
    const a=this.db.prepare('SELECT * FROM adjustment_approvals WHERE proposal_id=?').get(p.id);
    if(!a||a.proposal_hash!==p.proposal_hash||a.project_id!==projectId||a.feedback_id!==p.feedback_id||proposalHash!==p.proposal_hash)fail('ADJUSTMENT_APPROVAL_REQUIRED');
    const owner=this.db.prepare('SELECT account_id FROM projects WHERE id=?').get(projectId);if(a.account_id!==owner.account_id)fail('ADJUSTMENT_APPROVAL_REQUIRED');
    return {proposal:p,approval:a};
  }
  checked(row){const plan=JSON.parse(row.plan_json);if(executionHash(plan)!==row.plan_hash||plan.projectId!==row.project_id||plan.approvalId!==row.approval_id)fail('ADJUSTMENT_PLAN_CHANGED');return plan;}
  view(row){const plan=this.checked(row),review=this.db.prepare('SELECT id,state,review_hash,receipt_json,delivery_id,checked,delivered FROM adjustment_final_reviews WHERE execution_id=?').get(row.id),released=this.db.prepare('SELECT r.id,r.delivery_id,r.delivered FROM adjustment_release_members m JOIN adjustment_final_reviews r ON r.id=m.review_id WHERE m.execution_id=?').get(row.id),receipt=review?.receipt_json?JSON.parse(review.receipt_json):null;if(receipt&&executionHash(receipt)!==review.review_hash)fail('FINAL_REVIEW_CHANGED');return {id:row.id,proposalId:plan.proposalId,planHash:row.plan_hash,state:row.state,scope:plan.scope,pageId:plan.edit.pageId,before:plan.edit.before,after:plan.edit.after,files:plan.changes.map(f=>({file:f.file,beforeSha256:f.beforeSha256,afterSha256:f.afterSha256})),parentExecutionId:plan.parentExecutionId,baseDeliveryId:plan.baseDeliveryId,startedAt:row.started?new Date(row.started).toISOString():null,preparedAt:row.completed?new Date(row.completed).toISOString():null,resultHash:row.result_hash,error:row.error,customerReleased:Boolean(released),deliveryId:released?.delivery_id??null,releaseReviewId:released?.id??null,finalReview:review?{id:review.id,state:review.state,reviewHash:review.review_hash,deliveryId:review.delivery_id,counts:receipt?.counts??null,checkedAt:review.checked?new Date(review.checked).toISOString():null,deliveredAt:review.delivered?new Date(review.delivered).toISOString():null}:null,shopifyApplied:false};}
  list(projectId){return this.db.prepare('SELECT * FROM adjustment_executions WHERE project_id=? ORDER BY created,rowid').all(projectId).map(r=>this.view(r));}
  latest(projectId){return this.db.prepare("SELECT * FROM adjustment_executions e WHERE project_id=? AND state='prepared' AND NOT EXISTS(SELECT 1 FROM adjustment_release_members m WHERE m.execution_id=e.id) ORDER BY created DESC,rowid DESC LIMIT 1").get(projectId);}
  row(session,{projectId,executionId,planHash}){if(!uuid(executionId))fail('NOT_FOUND',404);const r=this.db.prepare('SELECT * FROM adjustment_executions WHERE id=? AND project_id=?').get(executionId,projectId);if(!r)fail('NOT_FOUND',404);const plan=this.checked(r);this.binding(session,plan);if(planHash!==r.plan_hash)fail('ADJUSTMENT_PLAN_CHANGED');return r;}
  stage(session,command,plan){
    if(!uuid(command.requestId)||command.scopeVerified!==true)fail('ADJUSTMENT_EXECUTION_ACK_REQUIRED',422);
    return this.accounts.transaction(()=>{
      const {approval,proposal}=this.binding(session,command),old=this.db.prepare('SELECT * FROM adjustment_executions WHERE operator_account_id=? AND request_id=?').get(session.accountId,command.requestId);
      if(old){const p=this.checked(old);if(p.proposalId!==proposal.id||executionHash(p.edit)!==executionHash(command.edit))fail('ADJUSTMENT_REQUEST_CONFLICT');return {duplicate:true,execution:this.view(old)};}
      if(this.db.prepare('SELECT id FROM adjustment_executions WHERE approval_id=?').get(approval.id))fail('ADJUSTMENT_EXECUTION_EXISTS');
      if(this.db.prepare("SELECT id FROM adjustment_final_reviews WHERE project_id=? AND state IN ('checking','releasing')").get(command.projectId))fail('FINAL_DELIVERY_IN_PROGRESS');
      if(this.db.prepare("SELECT id FROM adjustment_executions WHERE project_id=? AND state IN ('planned','running','blocked')").get(command.projectId))fail('ADJUSTMENT_EXECUTION_PENDING');
      const parent=this.latest(command.projectId);if((parent?.id??null)!==plan.parentExecutionId||plan.approvalId!==approval.id||plan.proposalHash!==proposal.proposal_hash||plan.scope!==proposal.scope)fail('ADJUSTMENT_BASE_STALE');
      const id=crypto.randomUUID(),planHash=executionHash(plan);this.db.prepare('INSERT INTO adjustment_executions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,command.projectId,approval.id,session.accountId,command.requestId,planHash,JSON.stringify(plan),'planned',null,null,null,null,this.accounts.now());this.accounts.audit('minor_adjustment_planned',session.accountId,id);return {duplicate:false,execution:this.view(this.db.prepare('SELECT * FROM adjustment_executions WHERE id=?').get(id))};
    });
  }
  claim(session,command){
    if(command.executionReviewed!==true)fail('ADJUSTMENT_EXECUTION_ACK_REQUIRED',422);
    return this.accounts.transaction(()=>{const r=this.row(session,command);if(r.state==='prepared')return {duplicate:true,row:r};if(r.state!=='planned')fail('ADJUSTMENT_EXECUTION_REVIEW_REQUIRED');const plan=this.checked(r),parent=this.latest(r.project_id);if((parent?.id??null)!==plan.parentExecutionId)fail('ADJUSTMENT_BASE_STALE');this.db.prepare("UPDATE adjustment_executions SET state='running',started=? WHERE id=?").run(this.accounts.now(),r.id);this.accounts.audit('minor_adjustment_execution_started',session.accountId,r.id);return {duplicate:false,row:this.db.prepare('SELECT * FROM adjustment_executions WHERE id=?').get(r.id)};});
  }
  complete(session,row,resultHash){return this.accounts.transaction(()=>{this.row(session,{projectId:row.project_id,executionId:row.id,planHash:row.plan_hash});const r=this.db.prepare('SELECT state FROM adjustment_executions WHERE id=?').get(row.id);if(r.state!=='running')fail('ADJUSTMENT_EXECUTION_REVIEW_REQUIRED');this.db.prepare("UPDATE adjustment_executions SET state='prepared',completed=?,result_hash=? WHERE id=?").run(this.accounts.now(),resultHash,row.id);this.accounts.audit('minor_adjustment_revision_prepared',session.accountId,row.id);return this.view(this.db.prepare('SELECT * FROM adjustment_executions WHERE id=?').get(row.id));});}
  block(row){this.accounts.transaction(()=>{this.db.prepare("UPDATE adjustment_executions SET state='blocked',error='ADJUSTMENT_EXECUTION_REVIEW_REQUIRED' WHERE id=? AND state='running'").run(row.id);this.accounts.audit('minor_adjustment_execution_blocked',null,row.id);});}
}
