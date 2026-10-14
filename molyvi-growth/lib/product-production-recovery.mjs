import crypto from 'node:crypto';
import {canonicalJson,IntakeError} from './intake-store.mjs';
import {importProductPilot} from './product-pilot-import.mjs';
const sha=value=>crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
const fail=code=>{throw new IntakeError(code,409);};

// Trusted, explicit operator resolution after an actual session vision review.
// No public endpoint and no automated retry of an ambiguous provider failure.
export async function resolveMaterialProduction(store,session,{jobId,packet,result,evidence,inspectedSha256,explanation}){
  const record=await store.read(session.projectId,session.ownerId),job=record.productProductionQueue?.jobs[jobId];
  const input={jobId,packet,result,evidence,inspectedSha256,explanation},resolutionHash=sha(input);
  if(job?.sessionResolution){if(job.sessionResolution.resolutionHash!==resolutionHash)fail('RECOVERY_RESULT_CONFLICT');return {duplicate:true};}
  if(!job||job.kind!=='materials'||job.status!=='paused'||job.reason!=='provider_failed'||job.savedResult||job.payloadHash!==packet?.payloadHash
    ||packet.kind!=='materials'||packet.productId!==job.productId||packet.reviewId!==job.requestId
    ||canonicalJson(inspectedSha256)!==canonicalJson(packet.assetEvidence.map(asset=>asset.sha256))
    ||evidence?.tool!=='assistant_session'||typeof explanation!=='string'||!explanation.trim()||explanation.length>2500)fail('RECOVERY_NOT_ELIGIBLE');
  // The normal import rechecks immutable bytes, owner, packet and current request.
  // Import is idempotent if the process stops before the job is marked resolved.
  const imported=await importProductPilot(store,session,{packet,result,evidence});
  await store.transact(session.projectId,session.ownerId,current=>{
    const saved=current.productProductionQueue.jobs[jobId];
    if(saved.status!=='paused'||saved.reason!=='provider_failed')fail('RECOVERY_JOB_CHANGED');
    saved.sessionResolution={resolutionHash,route:'assistant_session',executionId:evidence.executionId,inspectedSha256:[...inspectedSha256],explanation,
      failedProviderAttempt:{runId:saved.runId,status:saved.status,reason:saved.reason,usageUnknown:true},receiptHash:sha(imported.result.receipt),resolvedAt:new Date().toISOString()};
    saved.status='completed';saved.completedAt=saved.sessionResolution.resolvedAt;delete saved.reason;
  });
  return {duplicate:false};
}
