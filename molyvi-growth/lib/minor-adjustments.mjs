import crypto from 'node:crypto';
import {IntakeError} from './intake-store.mjs';
import {SERVICE_OFFER} from './service-offer.mjs';
const fail=(code,status=409)=>{throw new IntakeError(code,status);};
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(v);
const hash=v=>crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
export const MINOR_ADJUSTMENT_LIMIT=SERVICE_OFFER.handoff.minorAdjustmentsPerRoundMax;
if(MINOR_ADJUSTMENT_LIMIT!==5||SERVICE_OFFER.handoff.finalMinorAdjustmentRounds!==1)fail('ADJUSTMENT_POLICY_UNSUPPORTED',500);
export const MINOR_ADJUSTMENT_SCHEMA=`
CREATE TABLE IF NOT EXISTS adjustment_proposals(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),delivery_id TEXT NOT NULL REFERENCES deliveries(id),feedback_id TEXT NOT NULL REFERENCES delivery_feedback(id),manifest_hash TEXT NOT NULL,reply_revision INTEGER NOT NULL,revision INTEGER NOT NULL,proposal_hash TEXT NOT NULL UNIQUE,scope TEXT NOT NULL,operator_account_id TEXT NOT NULL REFERENCES accounts(id),request_id TEXT NOT NULL,created INTEGER NOT NULL,UNIQUE(feedback_id,revision),UNIQUE(operator_account_id,request_id));
CREATE TABLE IF NOT EXISTS adjustment_approvals(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),proposal_id TEXT NOT NULL UNIQUE REFERENCES adjustment_proposals(id),feedback_id TEXT NOT NULL UNIQUE REFERENCES delivery_feedback(id),slot INTEGER NOT NULL CHECK(slot BETWEEN 1 AND 5),proposal_hash TEXT NOT NULL,account_id TEXT NOT NULL REFERENCES accounts(id),request_id TEXT NOT NULL,created INTEGER NOT NULL,UNIQUE(project_id,slot),UNIQUE(account_id,request_id));
CREATE INDEX IF NOT EXISTS adjustment_proposals_feedback ON adjustment_proposals(feedback_id,revision);
CREATE INDEX IF NOT EXISTS adjustment_approvals_project ON adjustment_approvals(project_id,slot);`;

export class MinorAdjustments {
  constructor(accounts){this.accounts=accounts;}
  get db(){return this.accounts.db;}
  allowance(projectId){const approved=this.db.prepare('SELECT count(*) n FROM adjustment_approvals WHERE project_id=?').get(projectId).n;if(approved>MINOR_ADJUSTMENT_LIMIT)fail('ADJUSTMENT_ALLOWANCE_INVALID',500);const started=this.db.prepare('SELECT count(*) n FROM adjustment_executions WHERE project_id=? AND started IS NOT NULL').get(projectId).n;return {round:1,limit:MINOR_ADJUSTMENT_LIMIT,approved,remaining:MINOR_ADJUSTMENT_LIMIT-approved,workStarted:started>0,creditsCharged:false};}
  verifyProposal(r){if(hash({id:r.id,projectId:r.project_id,deliveryId:r.delivery_id,feedbackId:r.feedback_id,manifestHash:r.manifest_hash,replyRevision:r.reply_revision,revision:r.revision,scope:r.scope})!==r.proposal_hash)fail('ADJUSTMENT_PROPOSAL_CHANGED');return r;}
  proposals(feedbackId){
    const rows=this.db.prepare('SELECT p.*,a.slot,a.created AS approved_at FROM adjustment_proposals p LEFT JOIN adjustment_approvals a ON a.proposal_id=p.id WHERE p.feedback_id=? ORDER BY p.revision').all(feedbackId),replyRevision=this.db.prepare('SELECT count(*) n FROM feedback_replies WHERE feedback_id=?').get(feedbackId).n,last=rows.at(-1)?.revision;
    return rows.map(r=>{this.verifyProposal(r);const execution=this.db.prepare('SELECT e.state,e.started,m.review_id,f.delivery_id FROM adjustment_executions e JOIN adjustment_approvals a ON a.id=e.approval_id LEFT JOIN adjustment_release_members m ON m.execution_id=e.id LEFT JOIN adjustment_final_reviews f ON f.id=m.review_id WHERE a.proposal_id=?').get(r.id);return {id:r.id,projectId:r.project_id,deliveryId:r.delivery_id,feedbackId:r.feedback_id,manifestHash:r.manifest_hash,proposalHash:r.proposal_hash,scope:r.scope,revision:r.revision,replyRevision:r.reply_revision,createdAt:new Date(r.created).toISOString(),status:r.slot?'approved':r.revision!==last?'superseded':r.reply_revision!==replyRevision?'stale':'awaiting_customer',slot:r.slot??null,approvedAt:r.approved_at?new Date(r.approved_at).toISOString():null,workStarted:Boolean(execution?.started),execution:execution?{state:execution.state,customerReleased:Boolean(execution.review_id),deliveryId:execution.delivery_id??null,shopifyApplied:false}:null};});
  }
  propose(session,command){
    const {projectId,deliveryId,feedbackId,manifestHash,requestId,expectedReplyRevision,expectedProposalRevision,singleAdjustmentAcknowledged}=command;
    if(!uuid(requestId)||!Number.isSafeInteger(expectedReplyRevision)||expectedReplyRevision<1||!Number.isSafeInteger(expectedProposalRevision)||expectedProposalRevision<0||singleAdjustmentAcknowledged!==true||typeof command.scope!=='string'||!command.scope.trim()||command.scope.length>1000||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(command.scope))fail('INVALID_ADJUSTMENT_PROPOSAL',422);
    const scope=command.scope.trim();
    return this.accounts.transaction(()=>{
      // Operator access/binding is checked again inside the write transaction.
      this.operatorBinding(session,command);
      const old=this.db.prepare('SELECT * FROM adjustment_proposals WHERE operator_account_id=? AND request_id=?').get(session.accountId,requestId);
      if(old){if(old.feedback_id!==feedbackId||old.delivery_id!==deliveryId||old.project_id!==projectId||old.manifest_hash!==manifestHash||old.reply_revision!==expectedReplyRevision||old.revision!==expectedProposalRevision+1||old.scope!==scope)fail('ADJUSTMENT_REQUEST_CONFLICT');return {duplicate:true,id:old.id};}
      if(this.db.prepare('SELECT id FROM adjustment_approvals WHERE feedback_id=?').get(feedbackId))fail('ADJUSTMENT_ALREADY_APPROVED');
      const latest=this.db.prepare('SELECT expected_revision,disposition FROM feedback_replies WHERE feedback_id=? ORDER BY expected_revision DESC LIMIT 1').get(feedbackId);if(!latest||latest.expected_revision+1!==expectedReplyRevision)fail('FEEDBACK_REPLY_STALE');if(latest.disposition!=='small_adjustment')fail('ADJUSTMENT_NOT_ELIGIBLE');
      const count=this.db.prepare('SELECT count(*) n FROM adjustment_proposals WHERE feedback_id=?').get(feedbackId).n;if(count!==expectedProposalRevision)fail('ADJUSTMENT_PROPOSAL_STALE');if(count>=20)fail('ADJUSTMENT_PROPOSAL_LIMIT',429);if(!this.allowance(projectId).remaining)fail('ADJUSTMENT_LIMIT_REACHED');
      const id=crypto.randomUUID(),revision=count+1,proposalHash=hash({id,projectId,deliveryId,feedbackId,manifestHash,replyRevision:expectedReplyRevision,revision,scope});this.db.prepare('INSERT INTO adjustment_proposals VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,projectId,deliveryId,feedbackId,manifestHash,expectedReplyRevision,revision,proposalHash,scope,session.accountId,requestId,this.accounts.now());this.accounts.audit('minor_adjustment_proposed',session.accountId,id);return {duplicate:false,id};
    });
  }
  operatorBinding(session,{projectId,deliveryId,feedbackId,manifestHash}){
    if(!uuid(projectId)||!uuid(deliveryId)||!uuid(feedbackId))fail('NOT_FOUND',404);
    if(!this.db.prepare('SELECT account_id FROM feedback_operator_grants WHERE account_id=? AND project_id=?').get(session.accountId,projectId))fail('OPERATOR_ACCESS_REQUIRED',403);
    const row=this.db.prepare('SELECT f.*,d.project_id,d.manifest_hash AS delivery_manifest_hash FROM delivery_feedback f JOIN deliveries d ON d.id=f.delivery_id WHERE f.id=? AND f.delivery_id=? AND d.project_id=?').get(feedbackId,deliveryId,projectId);if(!row)fail('NOT_FOUND',404);if(row.manifest_hash!==manifestHash||row.manifest_hash!==row.delivery_manifest_hash)fail('DELIVERY_VERSION_CHANGED');return row;
  }
  customerBinding(session,{deliveryId,proposalId,proposalHash}){
    const delivery=this.accounts.delivery(session.accountId,deliveryId);if(!uuid(proposalId))fail('NOT_FOUND',404);const proposal=this.db.prepare('SELECT p.* FROM adjustment_proposals p JOIN delivery_feedback f ON f.id=p.feedback_id WHERE p.id=? AND p.delivery_id=? AND p.project_id=? AND f.account_id=? AND f.delivery_id=p.delivery_id AND f.manifest_hash=p.manifest_hash').get(proposalId,deliveryId,delivery.project_id,session.accountId);if(!proposal)fail('NOT_FOUND',404);this.verifyProposal(proposal);if(proposal.proposal_hash!==proposalHash||proposal.manifest_hash!==delivery.manifest_hash)fail('ADJUSTMENT_PROPOSAL_STALE');return {delivery,proposal};
  }
  approve(session,command){
    const {requestId,acknowledged}=command;if(!uuid(requestId)||acknowledged!==true)fail('ADJUSTMENT_ACKNOWLEDGEMENT_REQUIRED',422);
    return this.accounts.transaction(()=>{
      const {proposal:p}=this.customerBinding(session,command),old=this.db.prepare('SELECT * FROM adjustment_approvals WHERE account_id=? AND request_id=?').get(session.accountId,requestId);
      if(old){if(old.proposal_id!==p.id||old.proposal_hash!==command.proposalHash)fail('ADJUSTMENT_REQUEST_CONFLICT');return {duplicate:true,id:old.id,slot:old.slot};}
      const approved=this.db.prepare('SELECT * FROM adjustment_approvals WHERE feedback_id=?').get(p.feedback_id);if(approved){if(approved.proposal_id!==p.id)fail('ADJUSTMENT_ALREADY_APPROVED');return {duplicate:true,id:approved.id,slot:approved.slot};}
      const current=this.proposals(p.feedback_id).find(x=>x.id===p.id);if(current?.status!=='awaiting_customer')fail('ADJUSTMENT_PROPOSAL_STALE');const allowance=this.allowance(p.project_id);if(!allowance.remaining)fail('ADJUSTMENT_LIMIT_REACHED');
      const id=crypto.randomUUID(),slot=allowance.approved+1;this.db.prepare('INSERT INTO adjustment_approvals VALUES(?,?,?,?,?,?,?,?,?)').run(id,p.project_id,p.id,p.feedback_id,slot,p.proposal_hash,session.accountId,requestId,this.accounts.now());this.accounts.audit('minor_adjustment_approved',session.accountId,id);return {duplicate:false,id,slot};
    });
  }
}
