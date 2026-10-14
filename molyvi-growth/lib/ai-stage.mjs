import {checkBudget, validateBudget} from './job-state.mjs';

// Provider injection only. No provider implementation, credentials, network client or scheduler.
export const AI_OUTPUT_LIMITS = Object.freeze({maxBytes: 16 * 1024, maxItems: 20, maxTextLength: 4000});
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const exactKeys = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
const id = value => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(value);
const nonnegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const usageKeys = ['aiCostEur', 'providerCostEur', 'toolSeconds'];
const verifiedUsage = value => exactKeys(value, usageKeys) && usageKeys.every(key => nonnegative(value[key]));
const reservedTopic = /price|pricing|legal|policy|terms|certif|tax|shipping_rate|credential/i;
const prohibitedText = /```|<\/?[a-z][^>]*>|\b(?:eval|require)\s*\(|\b(?:import|export)\s|javascript\s*:|[€$£]|\b(?:EUR|USD|GBP|VAT|GDPR|FDA)\b|ΦΠΑ|πιστοποί|νομικ|εγγυημέν|certif|terms\s+of|\bISO\s*\d+/i;
const plainText = value => typeof value === 'string' && value.length > 0 && value.length <= AI_OUTPUT_LIMITS.maxTextLength && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value) && !prohibitedText.test(value);

function boundedJson(value) {
  // Refuse executable/non-JSON properties before serializing injected provider data.
  const visited = new Set();
  let count = 0;
  const walk = (item, depth) => {
    if (++count > 2000 || depth > 8) throw new Error('JSON_LIMIT');
    if (item === null || typeof item === 'string' || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)) return;
    if (!Array.isArray(item) && !object(item) || visited.has(item)) throw new Error('JSON_INVALID');
    visited.add(item);
    for (const key of Object.keys(item)) {
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor || descriptor.get || descriptor.set) throw new Error('JSON_INVALID');
      walk(descriptor.value, depth + 1);
    }
    visited.delete(item);
  };
  walk(value, 0);
  const text = JSON.stringify(value);
  if (new TextEncoder().encode(text).length > AI_OUTPUT_LIMITS.maxBytes) throw new Error('JSON_LIMIT');
  return JSON.parse(text);
}

function validateInput(value) {
  const input = boundedJson(value);
  if (!exactKeys(input, ['approvedFacts', 'allowedIds', 'allowedLabels']) || !object(input.approvedFacts) || !Object.keys(input.approvedFacts).length) throw new Error('INPUT_INVALID');
  if (!Object.entries(input.approvedFacts).every(([key, text]) => id(key) && typeof text === 'string' && text.length > 0 && text.length <= 4000)) throw new Error('INPUT_INVALID');
  if (!Array.isArray(input.allowedIds) || !input.allowedIds.length || input.allowedIds.length > 20 || !input.allowedIds.every(value => id(value) && !reservedTopic.test(value))) throw new Error('INPUT_INVALID');
  if (!Array.isArray(input.allowedLabels) || input.allowedLabels.length > 20 || !input.allowedLabels.every(value => id(value) && !reservedTopic.test(value))) throw new Error('INPUT_INVALID');
  return input;
}

export function validateAiOutput(value, input) {
  let output;
  try {
    if (typeof value === 'string' && new TextEncoder().encode(value).length > AI_OUTPUT_LIMITS.maxBytes) throw new Error('JSON_LIMIT');
    output = boundedJson(typeof value === 'string' ? JSON.parse(value) : value);
  } catch {return {valid: false, errors: ['OUTPUT_JSON_INVALID']};}
  if (!exactKeys(output, ['texts', 'classifications'])) return {valid: false, errors: ['OUTPUT_SCHEMA_INVALID']};
  const texts = output.texts ?? [];
  const classifications = output.classifications ?? [];
  if (!Array.isArray(texts) || !Array.isArray(classifications) || !texts.length && !classifications.length || texts.length + classifications.length > AI_OUTPUT_LIMITS.maxItems) return {valid: false, errors: ['OUTPUT_SCHEMA_INVALID']};
  const ids = new Set();
  const common = item => {
    if (!id(item.id) || !input.allowedIds.includes(item.id) || ids.has(item.id)) return false;
    ids.add(item.id);
    return Array.isArray(item.sourceRefs) && item.sourceRefs.length > 0 && item.sourceRefs.length <= 20 && item.sourceRefs.every(ref => id(ref) && Object.hasOwn(input.approvedFacts, ref));
  };
  for (const item of texts) {
    if (!exactKeys(item, ['id', 'text', 'sourceRefs']) || !common(item) || !plainText(item.text)) return {valid: false, errors: ['OUTPUT_TEXT_UNSUPPORTED']};
  }
  for (const item of classifications) {
    if (!exactKeys(item, ['id', 'label', 'reason', 'sourceRefs']) || !common(item) || !input.allowedLabels.includes(item.label) || !plainText(item.reason)) return {valid: false, errors: ['OUTPUT_CLASSIFICATION_UNSUPPORTED']};
  }
  return {valid: true, output};
}

const sumUsage = (usage, addition) => ({
  ...usage,
  ...Object.fromEntries(usageKeys.map(key => [key, Math.round((usage[key] + addition[key]) * 1e9) / 1e9])),
});
const safeErrors = result => Array.isArray(result?.errors) && result.errors.length
  ? result.errors.slice(0, 10).map(code => typeof code === 'string' && /^[A-Z0-9_]{1,80}$/.test(code) ? code : 'CALLER_VALIDATION_FAILED') : ['CALLER_VALIDATION_FAILED'];

export async function executeAiStage({input, jobBudget, actualUsage, estimate, maxRepairAttempts = 2, provider, validator} = {}) {
  let usage = actualUsage && {...actualUsage};
  const ledger = [];
  const finish = (status, reason, output = null, unknown = false) => ({
    status, reason, output, attempts: ledger.length, ledger,
    actualUsage: unknown ? null : usage, knownUsageSubtotal: usage,
    costStatus: unknown ? 'unknown' : 'known',
  });
  if (!validateBudget(jobBudget)) return finish('blocked', 'BUDGET_UNVERIFIED');
  const initialGate = checkBudget(jobBudget, usage);
  if (!initialGate.allowed) return finish('blocked', initialGate.reason, null, initialGate.reason === 'USAGE_UNKNOWN');
  if (!verifiedUsage(estimate)) return finish('blocked', 'ESTIMATE_UNVERIFIED');
  if (!Number.isInteger(maxRepairAttempts) || maxRepairAttempts < 0 || maxRepairAttempts > 2) return finish('blocked', 'REPAIR_LIMIT_INVALID');
  if (typeof provider !== 'function' || typeof validator !== 'function') return finish('blocked', 'ADAPTER_NOT_CONFIGURED');
  let prepared;
  try {prepared = validateInput(input);} catch {return finish('blocked', 'INPUT_INVALID');}
  // Clone inputs so a provider/validator cannot alter the cost caps or next attempt's facts.
  const budget = {...jobBudget};
  const expected = {...estimate};
  let repair = null;
  for (let attempt = 0; attempt <= maxRepairAttempts; attempt++) {
    const forecast = checkBudget(budget, sumUsage(usage, expected));
    if (!forecast.allowed) return finish('paused', 'FORECAST_BUDGET_EXCEEDED');
    let result;
    try {
      result = await provider({input: boundedJson(prepared), attempt, repair, limits: AI_OUTPUT_LIMITS});
    } catch {
      ledger.push({attempt, status: 'usage_unknown', usage: null, errors: ['PROVIDER_RESULT_UNKNOWN']});
      return finish('paused', 'PROVIDER_RESULT_UNKNOWN', null, true);
    }
    if (!result || !verifiedUsage(result.usage)) {
      const partial = Object.fromEntries(usageKeys.map(key => [key, nonnegative(result?.usage?.[key]) ? result.usage[key] : null]));
      usage = sumUsage(usage, Object.fromEntries(usageKeys.map(key => [key, partial[key] ?? 0])));
      ledger.push({attempt, status: 'usage_unknown', usage: partial, errors: ['USAGE_UNKNOWN']});
      return finish('paused', 'USAGE_UNKNOWN', null, true);
    }
    const charged = {...result.usage};
    usage = sumUsage(usage, charged);
    const entry = {attempt, status: 'received', usage: charged, errors: []};
    ledger.push(entry);
    if (!checkBudget(budget, usage).allowed) {
      entry.status = 'budget_exceeded'; entry.errors = ['BUDGET_EXCEEDED'];
      return finish('paused', 'BUDGET_EXCEEDED');
    }
    if (usageKeys.some(key => charged[key] > expected[key])) {
      entry.status = 'estimate_exceeded'; entry.errors = ['USAGE_EXCEEDS_ESTIMATE'];
      return finish('paused', 'USAGE_EXCEEDS_ESTIMATE');
    }
    const bounded = validateAiOutput(result.output, prepared);
    let validation;
    if (bounded.valid) {
      try {validation = await validator(boundedJson(bounded.output), boundedJson(prepared));}
      catch {validation = {valid: false, errors: ['CALLER_VALIDATOR_FAILED']};}
    } else validation = bounded;
    if (bounded.valid && (validation === true || validation?.valid === true)) {
      entry.status = 'validated';
      return finish('succeeded', null, bounded.output);
    }
    entry.status = 'validation_failed'; entry.errors = safeErrors(validation);
    repair = {errors: [...entry.errors]};
  }
  return finish('failed', 'OUTPUT_VALIDATION_FAILED');
}
