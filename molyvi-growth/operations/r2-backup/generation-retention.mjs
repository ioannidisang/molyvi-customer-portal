import crypto from 'node:crypto';
import {R2_LIMITS} from './r2-budget.mjs';
import {RETENTION_POLICY} from './retention.mjs';

// Pure planning only. Inputs and the separately pinned proof hash must come
// from a trusted operator. Hash consistency is not remote authenticity.
// Nothing here lists, uploads, deletes, reserves budget, or activates a worker.
const fail = message => { throw Error(message); };
const check = (value, message) => { if (!value) fail(message); };
const sha = /^[a-f0-9]{64}$/;
const STATUSES = new Set(['reserved', 'success', 'failed', 'unknown']);
const WINDOW_MS = R2_LIMITS.windowDays * 86_400_000;
const INVENTORY_MAX_AGE_MS = 300_000;
const MAX_OBJECT_BYTES = 512_000_000;
const RESERVE_BYTES = 12 * 1024 * 1024;

function exact(value, keys, label) {
  check(value && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype, label);
  check(Object.keys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key)), label);
}
function integer(value, label, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  check(Number.isSafeInteger(value) && value >= minimum && value <= maximum, label);
  return value;
}
function timestamp(value, label) {
  check(typeof value === 'string' && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value, label);
  return Date.parse(value);
}
function key(value) {
  check(typeof value === 'string' && value.length <= 1024
    && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)
    && value.split('/').every(part => part && part !== '.' && part !== '..'),
  'GENERATION_OBJECT_KEY');
  return value;
}
function id(value) {
  check(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value),
    'GENERATION_ID');
  return value;
}
function sum(values) {
  return values.reduce((total, value) => integer(total + value, 'GENERATION_SUM_OVERFLOW'), 0);
}
function canonical(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    check(Number.isSafeInteger(value), 'GENERATION_HASH_NUMBER'); return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  check(value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype,
    'GENERATION_HASH_VALUE');
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}
export function generationEvidenceHash(value) {
  return crypto.createHash('sha256').update(canonical(value)).digest('hex');
}
function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function objectRecord(value) {
  exact(value, ['key', 'bytes', 'sha256', 'kind'], 'GENERATION_OBJECT_RECORD');
  key(value.key); integer(value.bytes, 'GENERATION_OBJECT_BYTES', 44, MAX_OBJECT_BYTES);
  check(typeof value.sha256 === 'string' && sha.test(value.sha256)
    && ['base', 'overlay', 'legacy'].includes(value.kind),
    'GENERATION_OBJECT_RECORD');
  return {...value};
}
function inventoryRecord(value) {
  exact(value, ['key', 'bytes', 'sha256', 'etag'], 'GENERATION_INVENTORY_RECORD');
  key(value.key); integer(value.bytes, 'GENERATION_INVENTORY_BYTES');
  // LIST has no content digest. Unmanaged objects remain unverified (null),
  // preserved and charged in full; every managed object still needs its SHA.
  check((value.sha256 === null || typeof value.sha256 === 'string' && sha.test(value.sha256)) && typeof value.etag === 'string'
    && value.etag.length > 0 && value.etag.length <= 200
    && !/[\u0000-\u001f\u007f]/.test(value.etag), 'GENERATION_INVENTORY_RECORD');
  return {...value};
}
function generation(value, objects) {
  check(value?.kind === 'legacy' || value?.kind === 'base-overlay', 'GENERATION_RECORD');
  exact(value, value.kind === 'legacy'
    ? ['id', 'verifiedAt', 'kind', 'objectKey']
    : ['id', 'verifiedAt', 'kind', 'baseKey', 'overlayKey'], 'GENERATION_RECORD');
  id(value.id); timestamp(value.verifiedAt, 'GENERATION_TIMESTAMP');
  for (const [property, kind] of value.kind === 'legacy'
    ? [['objectKey', 'legacy']] : [['baseKey', 'base'], ['overlayKey', 'overlay']]) {
    key(value[property]);
    check(objects.get(value[property])?.kind === kind, 'GENERATION_DANGLING_REFERENCE');
  }
  return {...value};
}
const dependencies = value => value.kind === 'legacy'
  ? [value.objectKey] : [value.baseKey, value.overlayKey];
const anchorKey = value => value.kind === 'legacy' ? value.objectKey : value.overlayKey;
function unique(rows, property, label) {
  const map = new Map(rows.map(value => [value[property], value]));
  check(map.size === rows.length, label);
  return map;
}
function reservation(value, now) {
  exact(value, ['id', 'generationId', 'at', 'requests', 'uploadBytes', 'downloadBytes', 'status'],
    'GENERATION_RESERVATION');
  id(value.id); if (value.generationId !== null) id(value.generationId);
  const at = timestamp(value.at, 'GENERATION_RESERVATION_TIME');
  check(at <= now && STATUSES.has(value.status), 'GENERATION_RESERVATION');
  for (const field of ['requests', 'uploadBytes', 'downloadBytes']) integer(value[field], 'GENERATION_RESERVATION');
  check(value.requests + value.uploadBytes + value.downloadBytes > 0, 'GENERATION_RESERVATION');
  return {...value};
}
function usage(rows) {
  return Object.fromEntries(['requests', 'uploadBytes', 'downloadBytes']
    .map(field => [field, sum(rows.map(row => row[field]))]));
}
function transferRows(rows, objects, allowed, exactKeys, label) {
  check(Array.isArray(rows) && rows.length > 0 && rows.length <= 2, label);
  const map = unique(rows, 'key', label);
  for (const value of rows) {
    exact(value, ['key', 'bytes', 'sha256', 'status'], label);
    const expected = objects.get(value.key);
    check(allowed.has(value.key) && expected && value.status === 'PASS'
      && value.bytes === expected.bytes && value.sha256 === expected.sha256, label);
  }
  if (exactKeys) check(map.size === exactKeys.length && exactKeys.every(k => map.has(k)), label);
  return map;
}
function verifyProof({proof, trustedProofHash, candidate, inventory, objects, reservations, now}) {
  exact(proof, ['schemaVersion', 'status', 'generationId', 'generationHash', 'inventoryHash',
    'verifiedAt', 'uploads', 'downloads', 'fullRestore', 'reservationIds'], 'GENERATION_RESTORE_PROOF');
  check(typeof trustedProofHash === 'string' && sha.test(trustedProofHash)
    && generationEvidenceHash(proof) === trustedProofHash,
    'GENERATION_PROOF_PIN_MISMATCH');
  check(proof.schemaVersion === 1 && proof.status === 'PASS' && proof.generationId === candidate.id
    && proof.generationHash === generationEvidenceHash(candidate)
    && proof.inventoryHash === generationEvidenceHash(inventory), 'GENERATION_PROOF_BINDING');
  const verified = timestamp(proof.verifiedAt, 'GENERATION_PROOF_TIME');
  check(verified >= Date.parse(candidate.verifiedAt) && verified <= Date.parse(inventory.capturedAt)
    && verified <= now && now - verified <= INVENTORY_MAX_AGE_MS, 'GENERATION_PROOF_TIME');
  const keys = dependencies(candidate), allowed = new Set(keys);
  const uploads = transferRows(proof.uploads, objects, allowed, null, 'GENERATION_UPLOAD_PROOF');
  check(uploads.has(candidate.overlayKey), 'GENERATION_OVERLAY_UPLOAD_REQUIRED');
  transferRows(proof.downloads, objects, allowed, keys, 'GENERATION_DOWNLOAD_PROOF');
  exact(proof.fullRestore, ['status', 'logicalFiles', 'logicalBytes', 'databaseIntegrity',
    'mailSent', 'liveStorageOverwritten'], 'GENERATION_FULL_RESTORE');
  check(proof.fullRestore.status === 'PASS' && proof.fullRestore.databaseIntegrity === 'ok'
    && proof.fullRestore.mailSent === false && proof.fullRestore.liveStorageOverwritten === false,
  'GENERATION_FULL_RESTORE');
  integer(proof.fullRestore.logicalFiles, 'GENERATION_FULL_RESTORE', 1, 100_000);
  integer(proof.fullRestore.logicalBytes, 'GENERATION_FULL_RESTORE', 1, MAX_OBJECT_BYTES - RESERVE_BYTES);
  check(Array.isArray(proof.reservationIds) && proof.reservationIds.length > 0
    && proof.reservationIds.length <= 200
    && new Set(proof.reservationIds).size === proof.reservationIds.length, 'GENERATION_PROOF_ACCOUNTING');
  const charges = proof.reservationIds.map(reservationId => {
    const row = reservations.get(reservationId);
    check(row && row.generationId === candidate.id && Date.parse(row.at) <= verified
      && Date.parse(row.at) > now - WINDOW_MS, 'GENERATION_PROOF_ACCOUNTING');
    return row;
  });
  const accounted = usage(charges);
  // Existing transport protocol: upload = HEAD(404), LIST, PUT, HEAD;
  // download = GET with hash/metadata verification. No retry/cache credit.
  check(accounted.requests >= 1 + 4 * uploads.size + keys.length
    && accounted.uploadBytes >= sum([...uploads.values()].map(row => row.bytes))
    && accounted.downloadBytes >= sum(keys.map(k => objects.get(k).bytes)), 'GENERATION_PROOF_ACCOUNTING');
}

/**
 * Produces an immutable advisory plan. An admitted result is not an atomic
 * budget reservation, provider authorization, durable catalog, or delete token.
 * Existing failed/unknown reservations remain charged through the 31-day window.
 */
export function planGenerationRetention(input) {
  check(input && typeof input === 'object', 'GENERATION_INPUT');
  const {phase, now: nowText, inventory, objects: sourceObjects, generations: sourceGenerations,
    candidate: sourceCandidate, reservations: sourceReservations, restoreProof, trustedProofHash} = input;
  const now = timestamp(nowText, 'GENERATION_NOW');
  check(phase === 'preflight' || phase === 'restored', 'GENERATION_PHASE');
  exact(inventory, ['complete', 'capturedAt', 'objects'], 'GENERATION_INVENTORY');
  const capturedAt = timestamp(inventory.capturedAt, 'GENERATION_INVENTORY_TIME');
  check(inventory.complete === true && capturedAt <= now && now - capturedAt <= INVENTORY_MAX_AGE_MS,
    'GENERATION_INVENTORY_FRESH_COMPLETE_REQUIRED');
  check(Array.isArray(inventory.objects) && inventory.objects.length <= 1000, 'GENERATION_INVENTORY');
  const remote = unique(inventory.objects.map(inventoryRecord), 'key', 'GENERATION_DUPLICATE_REMOTE_KEY');
  check(Array.isArray(sourceObjects) && sourceObjects.length > 0 && sourceObjects.length <= 1000,
    'GENERATION_OBJECTS');
  const objects = unique(sourceObjects.map(objectRecord), 'key', 'GENERATION_DUPLICATE_OBJECT_KEY');
  check(Array.isArray(sourceGenerations) && sourceGenerations.length <= 1000, 'GENERATION_HISTORY');
  const generations = sourceGenerations.map(value => generation(value, objects));
  const candidate = generation(sourceCandidate, objects);
  check(candidate.kind === 'base-overlay' && Date.parse(candidate.verifiedAt) <= now, 'GENERATION_CANDIDATE');
  const all = [...generations, candidate];
  unique(all, 'id', 'GENERATION_DUPLICATE_ID');
  const nonbase = all.map(value => anchorKey(value));
  check(new Set(nonbase).size === nonbase.length, 'GENERATION_SHARED_OVERLAY_OR_LEGACY');
  check(all.every(value => Date.parse(value.verifiedAt) <= now), 'GENERATION_FUTURE_RECORD');
  const ordered = [...all].sort((a, b) => Date.parse(b.verifiedAt) - Date.parse(a.verifiedAt)
    || anchorKey(b).localeCompare(anchorKey(a)));
  check(ordered[0].id === candidate.id, 'GENERATION_NEWEST_REQUIRED');
  const candidateKeys = new Set(dependencies(candidate));
  for (const value of generations) {
    check(dependencies(value).every(k => remote.has(k)), 'GENERATION_HISTORICAL_OBJECT_MISSING');
  }
  for (const value of objects.values()) {
    const observed = remote.get(value.key);
    if (observed) check(observed.bytes === value.bytes && observed.sha256 === value.sha256,
      'GENERATION_REMOTE_OBJECT_CHANGED');
    else check(phase === 'preflight' && candidateKeys.has(value.key), 'GENERATION_OBJECT_MISSING');
  }
  // A fresh overlay is mandatory. Reusing a prior attempted key needs an
  // operator reconciliation path, which this pure module deliberately lacks.
  if (phase === 'preflight') check(!remote.has(candidate.overlayKey), 'GENERATION_OVERLAY_ALREADY_EXISTS');
  const weekly = ordered.slice(0, 4).map(value => value.id), monthly = [], months = new Set();
  for (const value of ordered) {
    const month = value.verifiedAt.slice(0, 7);
    if (months.has(month)) continue;
    months.add(month); monthly.push(value.id);
    if (monthly.length === 3) break;
  }
  const retained = new Set([...weekly, ...monthly]);
  const keepObjectKeys = [...new Set(ordered.filter(value => retained.has(value.id))
    .flatMap(dependencies))].sort();
  const retainedObjects = new Set(keepObjectKeys);
  const retired = ordered.filter(value => !retained.has(value.id));
  const eligibleKeys = [...new Set(retired.flatMap(dependencies))]
    .filter(k => !retainedObjects.has(k)).sort();
  const uploaded = [...candidateKeys].filter(k => !remote.has(k)).map(k => objects.get(k));
  const peakBytes = sum([...remote.values()].map(value => value.bytes).concat(uploaded.map(value => value.bytes)));
  const peakObjects = remote.size + uploaded.length;
  check(Array.isArray(sourceReservations) && sourceReservations.length <= 10000, 'GENERATION_RESERVATIONS');
  const reservations = unique(sourceReservations.map(value => reservation(value, now)),
    'id', 'GENERATION_DUPLICATE_RESERVATION');
  const windowReservations = [...reservations.values()].filter(value => Date.parse(value.at) > now - WINDOW_MS);
  const consumed = usage(windowReservations);
  if (phase === 'restored') verifyProof({proof: restoreProof, trustedProofHash, candidate,
    inventory, objects, reservations, now});
  else check(restoreProof === undefined && trustedProofHash === undefined, 'GENERATION_PREFLIGHT_PROOF_FORBIDDEN');
  // Initial/final LIST, four requests per new upload, one full GET per
  // dependency, retained HEADs, and HEAD+DELETE+absence HEAD per candidate.
  const required = phase === 'preflight'
    ? {requests: 2 + 4 * uploaded.length + candidateKeys.size + keepObjectKeys.length + 3 * eligibleKeys.length,
      uploadBytes: sum(uploaded.map(value => value.bytes)),
      downloadBytes: sum([...candidateKeys].map(k => objects.get(k).bytes))}
    : {requests: 1 + keepObjectKeys.length + 3 * eligibleKeys.length, uploadBytes: 0, downloadBytes: 0};
  const projectedUsage = Object.fromEntries(Object.keys(required)
    .map(field => [field, sum([consumed[field], required[field]])]));
  const blockers = [];
  if (peakBytes > R2_LIMITS.storedBytes) blockers.push('R2_BUDGET_STOP_STORAGE_BYTES');
  if (peakObjects > R2_LIMITS.objects) blockers.push('R2_BUDGET_STOP_STORAGE_OBJECTS');
  for (const field of Object.keys(required)) {
    if (projectedUsage[field] > R2_LIMITS[field]) blockers.push(`R2_BUDGET_STOP_${field.toUpperCase()}`);
  }
  const admitted = blockers.length === 0;
  const deletionCandidates = phase === 'restored' && admitted
    ? eligibleKeys.map(k => ({...objects.get(k), etag: remote.get(k).etag})) : [];
  const candidateSavings = sum(eligibleKeys.map(k => objects.get(k).bytes));
  const plannedKeep = new Set(keepObjectKeys);
  const unmanagedPreserved = [...remote.keys()].filter(k => !objects.has(k)).sort();
  const unreferencedManagedPreserved = [...objects.keys()].filter(k => remote.has(k)
    && !plannedKeep.has(k) && !eligibleKeys.includes(k)).sort();
  return freeze({
    schemaVersion: 1, planningOnly: true, phase, policy: RETENTION_POLICY, anchor: candidate.id,
    inventoryHash: generationEvidenceHash(inventory), candidateHash: generationEvidenceHash(candidate),
    admitted, blockers, weekly, monthly, keepGenerationIds: [...retained],
    retireGenerationIds: retired.map(value => value.id), keepObjectKeys, unmanagedPreserved,
    unreferencedManagedPreserved, candidateUploads: uploaded.map(value => ({...value})),
    capacity: {currentBytes: sum([...remote.values()].map(value => value.bytes)),
      currentObjects: remote.size, peakBeforeDeletionBytes: peakBytes, peakBeforeDeletionObjects: peakObjects,
      candidateSavingsBytes: candidateSavings,
      projectedAfterVerifiedDeletionBytes: peakBytes - candidateSavings,
      projectedAfterVerifiedDeletionObjects: peakObjects - eligibleKeys.length,
      appliedDeletionCreditBytes: 0, storageLimit: R2_LIMITS.storedBytes, objectLimit: R2_LIMITS.objects},
    budget: {windowDays: R2_LIMITS.windowDays, consumed, required, projected: projectedUsage,
      limits: {requests: R2_LIMITS.requests, uploadBytes: R2_LIMITS.uploadBytes, downloadBytes: R2_LIMITS.downloadBytes},
      failedOrUnknownReservationsCharged: windowReservations.filter(value => ['failed', 'unknown'].includes(value.status)).length,
      reservationPerformed: false},
    verification: {fullRestoreVerified: phase === 'restored',
      proofHash: phase === 'restored' ? trustedProofHash : null,
      remoteAuthenticityVerifiedByThisModule: false},
    deletionCandidates, providerCalls: 0, deletedObjects: 0
  });
}
