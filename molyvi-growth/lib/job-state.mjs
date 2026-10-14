// Pure gates only. This module is not an active worker, scheduler, payment system, or AI client.
const budgetFields = ['maxToolSeconds', 'maxAiCostEur', 'maxHumanMinutes', 'maxProviderCostEur'];
const usageFields = ['toolSeconds', 'aiCostEur', 'humanMinutes', 'providerCostEur'];
const positiveOrZero = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;

export function validateBudget(budget) {
  return Boolean(budget && budget.approved === true && budgetFields.every(key => positiveOrZero(budget[key])) && budget.maxToolSeconds > 0);
}

export function checkBudget(budget, actualUsage) {
  if (!validateBudget(budget)) return {allowed: false, reason: 'BUDGET_UNVERIFIED'};
  if (!actualUsage || !usageFields.every(key => positiveOrZero(actualUsage[key]))) return {allowed: false, reason: 'USAGE_UNKNOWN'};
  const exceeded = budgetFields.filter((key, index) => actualUsage[usageFields[index]] > budget[key]);
  return {allowed: exceeded.length === 0, reason: exceeded.length ? 'BUDGET_EXCEEDED' : null, exceeded};
}

export function assessProductionGate(input = {}) {
  const blockingReasons = [];
  if (input.assessment?.status !== 'standard') blockingReasons.push('ASSESSMENT_REQUIRED');
  const required = {
    fullBriefVerified: 'BRIEF_UNVERIFIED', materialsVerified: 'MATERIALS_UNVERIFIED',
    scopeAccepted: 'SCOPE_NOT_ACCEPTED', agreementAccepted: 'AGREEMENT_NOT_ACCEPTED',
    paymentConfirmed: 'PAYMENT_UNVERIFIED', storeAuthorized: 'STORE_NOT_AUTHORIZED',
    testModeVerified: 'TEST_MODE_UNVERIFIED', capacityReserved: 'CAPACITY_UNAVAILABLE',
  };
  for (const [field, code] of Object.entries(required)) if (input[field] !== true) blockingReasons.push(code);
  if (!validateBudget(input.budget)) blockingReasons.push('BUDGET_UNVERIFIED');
  return {ready: blockingReasons.length === 0, blockingReasons};
}

const states = new Set(['queued', 'leased', 'running', 'succeeded', 'blocked', 'retry_wait', 'failed', 'cancelled']);
const transitions = {
  queued: {lease: 'leased', block: 'blocked', cancel: 'cancelled'},
  leased: {start: 'running', block: 'blocked', cancel: 'cancelled'},
  running: {succeed: 'succeeded', block: 'blocked', transient_failure: 'retry_wait', permanent_failure: 'failed', cancel: 'cancelled'},
  retry_wait: {retry: 'queued', block: 'blocked', cancel: 'cancelled'},
  blocked: {resume: 'queued', cancel: 'cancelled'},
  failed: {}, succeeded: {}, cancelled: {},
};

export function transitionJob(job, event, options = {}) {
  if (!job || !states.has(job.state)) throw new Error('INVALID_JOB_STATE');
  if (!Number.isInteger(job.attempt) || job.attempt < 0 || !Number.isInteger(job.maxAttempts) || job.maxAttempts < 1 || job.maxAttempts > 3 || job.attempt > job.maxAttempts) throw new Error('INVALID_JOB_ATTEMPTS');
  const next = transitions[job.state]?.[event];
  if (!next) throw new Error('INVALID_JOB_TRANSITION');
  const now = options.now ?? Date.now();
  if (!Number.isFinite(now)) throw new Error('INVALID_JOB_TIME');
  if (event === 'lease') {
    if (job.attempt >= job.maxAttempts) throw new Error('RETRY_LIMIT');
    if (typeof options.leaseOwner !== 'string' || !options.leaseOwner || !Number.isFinite(options.leaseMs) || options.leaseMs <= 0) throw new Error('INVALID_JOB_LEASE');
    return {...job, state: next, attempt: job.attempt + 1, leaseOwner: options.leaseOwner, leaseExpiresAt: now + options.leaseMs, heartbeatAt: now};
  }
  if (event === 'start' && (!(job.leaseExpiresAt > now) || options.leaseOwner !== job.leaseOwner)) throw new Error('LEASE_NOT_OWNED');
  if (event === 'succeed' && (options.resultVerified !== true || !job.artifacts?.buildId || !job.artifacts?.manifestSha256)) throw new Error('ARTIFACT_UNVERIFIED');
  if (event === 'resume' && options.resumeVerified !== true) throw new Error('RESUME_UNVERIFIED');
  if (event === 'transient_failure') {
    if (options.retryable !== true) throw new Error('ERROR_NOT_RETRYABLE');
    if (job.attempt >= job.maxAttempts) return {...job, state: 'failed', errorCode: 'RETRY_LIMIT', updatedAt: now};
    if (!Number.isFinite(options.retryAfterMs) || options.retryAfterMs < 0) throw new Error('INVALID_RETRY_DELAY');
    return {...job, state: next, nextAttemptAt: now + options.retryAfterMs, leaseOwner: null, leaseExpiresAt: null, updatedAt: now};
  }
  if (event === 'retry' && (!(job.nextAttemptAt <= now) || job.attempt >= job.maxAttempts)) throw new Error('RETRY_NOT_READY');
  return {...job, state: next, updatedAt: now, ...(next === 'queued' || next === 'blocked' || next === 'failed' || next === 'cancelled' || next === 'succeeded' ? {leaseOwner: null, leaseExpiresAt: null} : {})};
}
