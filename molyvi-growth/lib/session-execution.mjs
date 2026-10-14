import {IntakeError} from './intake-store.mjs';

// Local trusted-operator attestation, not provider billing verification. Customer
// routes never accept these fields. Unknown subscription allocation stays null.
export function validateSessionExecution(evidence, expectedHash) {
  const valid = evidence && typeof evidence === 'object' && !Array.isArray(evidence)
    && evidence.billingMode === 'chatgpt_session'
    && /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(evidence.executionId ?? '')
    && ['assistant_session', 'image_gen'].includes(evidence.tool)
    && /^[\da-f]{64}$/.test(evidence.inputHash ?? '')
    && (expectedHash === undefined || evidence.inputHash === expectedHash)
    && evidence.apiCalls === 0 && evidence.incrementalApiCostEur === 0
    && evidence.allocatedCostEur === null
    && (evidence.model === null || typeof evidence.model === 'string' && evidence.model.length > 0 && evidence.model.length <= 120);
  if (!valid) throw new IntakeError('INVALID_SESSION_EXECUTION', 422);
  return {billingMode: evidence.billingMode, executionId: evidence.executionId, tool: evidence.tool,
    inputHash: evidence.inputHash, model: evidence.model, apiCalls: 0, incrementalApiCostEur: 0, allocatedCostEur: null};
}
