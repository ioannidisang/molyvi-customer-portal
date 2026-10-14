import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import {canonicalJson,IntakeError} from './intake-store.mjs';
import {recordPhotoClaimReview} from './photo-claims.mjs';

const hash=value=>crypto.createHash('sha256').update(typeof value==='string'||Buffer.isBuffer(value)?value:canonicalJson(value)).digest('hex');
const fail=code=>{throw new IntakeError(code,409);};
const uuid=value=>typeof value==='string'&&/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(value);

// Trusted evidence bridge for manual session reviews and the local automatic queue.
// This module verifies bytes/receipts; only the separate adapter invokes Codex.
async function buildPacket(record,directory,claimId){
  if(!uuid(claimId))fail('INVALID_PHOTO_CLAIM');
    const claim=record.photoClaims?.[claimId];
    if(!claim||claim.projectId!==record.id||hash(claim.snapshot)!==claim.evidenceHash)fail('PHOTO_CLAIM_EVIDENCE_CHANGED');
    const verify=async(asset,prefix)=>{
      if(!uuid(asset.id))fail('PHOTO_REVIEW_ASSET_INVALID');
      const file=path.join(directory,`${prefix}-${asset.id}.bin`),info=await fs.lstat(file);
      if(!info.isFile()||info.isSymbolicLink())fail('PHOTO_REVIEW_UNSAFE_ASSET');
      const bytes=await fs.readFile(file);
      if(bytes.length!==asset.bytes||hash(bytes)!==asset.sha256)fail('PHOTO_REVIEW_BYTES_CHANGED');
      return {...structuredClone(asset),path:file};
    };
    const originals=[];for(const asset of claim.snapshot.originalAssets)originals.push(await verify(asset,'photo'));
    const delivered=await verify(claim.snapshot.outputAsset,'generated');
    const packet={version:1,projectId:record.id,claimId,evidenceHash:claim.evidenceHash,description:claim.description,inputs:structuredClone(claim.snapshot.inputs),regeneration:structuredClone(claim.snapshot.regeneration),originals,delivered};
    return {packet,packetHash:hash(packet)};
}
export async function preparePhotoClaimReview(store,session,claimId){
  return store.serial(session.projectId,async()=>{
    const {record,directory}=await store.load(session.projectId,session.ownerId);
    return buildPacket(record,directory,claimId);
  });
}

// Only a trusted operator or local worker imports a completed review. The
// execution receipt is an audit record, not a cryptographic provider signature.
export async function importPhotoClaimReview(store,session,{packet,packetHash,reviewId,reviewerId,verdict,explanation,inspectedSha256,execution}){
  if(!packet||packet.projectId!==session.projectId||hash(packet)!==packetHash)fail('PHOTO_REVIEW_PACKET_CHANGED');
  if(!execution||!['current_session','codex_cli_chatgpt'].includes(execution.route)||typeof execution.runId!=='string'||!/^[-a-z\d]{1,100}$/i.test(execution.runId)||typeof execution.resultSha256!=='string'||!(/^[a-f\d]{64}$/).test(execution.resultSha256))fail('PHOTO_REVIEW_EXECUTION_REQUIRED');
  const expected=[...packet.originals.map(asset=>asset.sha256),packet.delivered.sha256];
  if(canonicalJson(inspectedSha256)!==canonicalJson(expected))fail('PHOTO_REVIEW_INCOMPLETE_INSPECTION');
  const command={claimId:packet.claimId,reviewId,reviewerId,verdict,explanation,evidenceHash:packet.evidenceHash};
  const receiptHash=hash({command,packetHash,execution});
  return store.transact(session.projectId,session.ownerId,async project=>{
    const fresh=await buildPacket(project,await store.directory(session.projectId),packet.claimId);
    if(fresh.packetHash!==packetHash)fail('PHOTO_REVIEW_PACKET_STALE');
    if(project.photoClaims?.[packet.claimId]?.evidenceHash!==packet.evidenceHash)fail('PHOTO_REVIEW_PACKET_STALE');
    const previous=project.photoReviewExecutions?.[reviewId];
    if(previous&&previous.receiptHash!==receiptHash)fail('PHOTO_REVIEW_EXECUTION_CONFLICT');
    const result=recordPhotoClaimReview(project,command);
    project.photoReviewExecutions??={};
    project.photoReviewExecutions[reviewId]??={receiptHash,packetHash,claimId:packet.claimId,reviewerId,...structuredClone(execution),recordedAt:new Date().toISOString()};
    return result;
  });
}
