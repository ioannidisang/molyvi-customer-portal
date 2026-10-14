import crypto from 'node:crypto';
import {canonicalJson, IntakeError} from './intake-store.mjs';
import {getCreditDebit, restoreCredits} from './credit-ledger.mjs';
import {photoSourceForSlot} from './product-gallery.mjs';
import {packageForOrder} from './service-offer.mjs';

const hash = value => crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
const fail = (code, status = 409) => { throw new IntakeError(code, status); };
const uuid = value => typeof value === 'string' && /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(value);
const sha = value => typeof value === 'string' && /^[\da-f]{64}$/i.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
const text = (value, limit) => typeof value === 'string' && value.trim().length > 0 && value.length <= limit && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
const verdicts = ['material_difference', 'no_material_difference', 'uncertain'];
const now = () => new Date().toISOString();
const acknowledgement = (claim, duplicate = false) => ({id: claim.id, status: claim.status, duplicate});

function claimFor(project, id) {
  if (!uuid(id)) fail('INVALID_PHOTO_CLAIM', 400);
  const claim = project.photoClaims?.[id];
  if (!claim) fail('PHOTO_CLAIM_NOT_FOUND', 404);
  if (claim.projectId !== project.id || hash(claim.snapshot) !== claim.evidenceHash) fail('PHOTO_CLAIM_EVIDENCE_CHANGED');
  return claim;
}

function assetSnapshot(asset, productId, sourceHash) {
  if (!asset || asset.productId !== productId || (sourceHash !== undefined && asset.sourceHash !== sourceHash)) fail('PHOTO_CLAIM_ASSET_NOT_OWNED', 403);
  if (!uuid(asset.id) || !sha(asset.sha256) || !Number.isSafeInteger(asset.bytes) || asset.bytes <= 0 || !['image/png', 'image/jpeg', 'image/webp'].includes(asset.mime)) fail('PHOTO_CLAIM_ASSET_INVALID');
  // Paths, buffers and provider credentials are never part of the review snapshot.
  return {id: asset.id, productId, sha256: asset.sha256, mime: asset.mime, bytes: asset.bytes, name: typeof asset.name === 'string' ? asset.name : '', ...(sourceHash === undefined ? {} : {sourceHash})};
}

function evidence(project, {productId, slotId, candidateId, galleryHash}) {
  if (project.order.status !== 'verified_paid') fail('PAYMENT_REQUIRED', 402);
  const submission = project.productTasks?.[productId]?.submission;
  const work = submission && project.jobs?.[`${submission.hash}:work`];
  const gallery = project.productGalleries?.[productId];
  if (!gallery || work?.status !== 'succeeded' || !work.inputs) fail('GALLERY_NOT_READY');
  if (gallery.sourceHash !== galleryHash || hash(work.inputs) !== galleryHash || hash(gallery.source) !== galleryHash) fail('GALLERY_STALE');
  const slot = gallery.slots.find(item => item.id === slotId);
  if (!slot) fail('PHOTO_SLOT_NOT_FOUND', 404);
  const candidate = slot.candidates.find(item => item.id === candidateId);
  if (!candidate) fail('PHOTO_CANDIDATE_NOT_FOUND', 404);
  const scopedInputs=photoSourceForSlot(gallery,slotId);
  const product = scopedInputs.answers?.product;
  const refs = scopedInputs.photoEvidence;
  if (product?.id !== productId || !Array.isArray(refs) || !refs.length || !Array.isArray(product.photos) || refs.length !== product.photos.length || new Set(refs.map(ref => ref.id)).size !== refs.length || refs.some(ref => !product.photos.includes(ref.id))) fail('PHOTO_CLAIM_SOURCE_MISSING');
  const originals = refs.map(ref => {
    const asset = assetSnapshot(project.assets?.[ref.id], productId);
    if (asset.id !== ref.id || asset.sha256 !== ref.sha256) fail('PHOTO_CLAIM_SOURCE_CHANGED');
    return asset;
  });
  const output = assetSnapshot(project.generatedAssets?.[candidate.assetId], productId, galleryHash);
  if((project.generatedAssets[candidate.assetId].visualUnitId??null)!==(slot.visualUnitId??null))fail('PHOTO_CLAIM_ASSET_NOT_OWNED',403);
  if (output.id !== candidate.assetId) fail('PHOTO_CLAIM_ASSET_INVALID');
  const request = candidate.requestId && slot.requests.find(item => item.id === candidate.requestId);
  const ordinary = candidate.kind === 'initial' && slot.candidates[0].id === candidate.id || candidate.kind === 'regeneration' && request?.status === 'completed' && request.candidateId === candidate.id && request.assetId === candidate.assetId && request.sourceHash === galleryHash;
  const includedCount = packageForOrder(project.order).entitlements.photoSlotsPerUnit;
  const unitSlots=gallery.slots.filter(item=>(item.visualUnitId??null)===(slot.visualUnitId??null));
  const included = !candidate.billing && ordinary && unitSlots.indexOf(slot) < includedCount;
  // A paid/unknown charge cannot be inferred from an image or a customer complaint.
  const coverage = included ? 'included' : candidate.billing?.kind === 'paid_credits' ? 'paid_credits' : 'unknown';
  return {
    projectId: project.id, orderId: project.order.id, productId, slotId, sourceHash: galleryHash,
    inputs: scopedInputs, originalAssets: originals,...(slot.visualUnitId?{visualUnitId:slot.visualUnitId}:{}),
    candidate: {id: candidate.id, assetId: candidate.assetId, kind: candidate.kind, requestId: candidate.requestId ?? null},
    outputAsset: output,
    regeneration: request ? {id: request.id, mode: request.mode, change: request.change, sourceHash: request.sourceHash} : null,
    coverage, ...(coverage === 'paid_credits' && candidate.billing.debitId && candidate.billing.workId ? {billing: {debitId: candidate.billing.debitId, workId: candidate.billing.workId}} : {}),
  };
}

function boundDebit(project, snapshot) {
  const billing = snapshot.billing;
  if (!billing || typeof billing.debitId !== 'string') return null;
  const debit = getCreditDebit(project, billing.debitId);
  const binding = debit?.binding;
  return binding && binding.productId === snapshot.productId && binding.slotId === snapshot.slotId && binding.sourceHash === snapshot.sourceHash && binding.workId === billing.workId ? debit : null;
}

// Trusted fulfillment boundary. A customer cannot attach a debit or select a refund amount.
export function bindPhotoCreditDebit(project, command) {
  if (!exact(command, ['productId', 'slotId', 'candidateId', 'galleryHash', 'debitId']) || !text(command.debitId, 160)) fail('INVALID_PHOTO_CREDIT_BINDING', 400);
  const snapshot = evidence(project, command);
  const debit = getCreditDebit(project, command.debitId);
  if (!debit || !boundDebit(project, {...snapshot, billing: {debitId: command.debitId, workId: debit.binding?.workId}})) fail('PHOTO_CREDIT_BINDING_MISMATCH');
  const candidate = project.productGalleries[command.productId].slots.find(slot => slot.id === command.slotId).candidates.find(item => item.id === command.candidateId);
  const billing = {kind: 'paid_credits', debitId: command.debitId, workId: debit.binding.workId};
  if (candidate.billing && canonicalJson(candidate.billing) !== canonicalJson(billing)) fail('PHOTO_CREDIT_BINDING_CONFLICT');
  if (Object.values(project.photoClaims ?? {}).some(claim => claim.candidateId === candidate.id)) fail('PHOTO_CREDIT_BINDING_LOCKED');
  candidate.billing = billing;
  return {candidateId: candidate.id, debitId: command.debitId};
}

// Customer operation. The store must serialize and persist this mutation under the authenticated owner.
export function openPhotoClaim(project, command) {
  if (object(command) && typeof command.description === 'string' && !command.description.trim()) fail('PHOTO_CLAIM_DESCRIPTION_REQUIRED', 422);
  if (!exact(command, ['productId', 'slotId', 'candidateId', 'galleryHash', 'requestId', 'description', 'kind']) || !uuid(command.productId) || !uuid(command.candidateId) || !uuid(command.requestId) || !sha(command.galleryHash) || !text(command.slotId, 80) || !text(command.description, 2000) || command.kind !== 'product_difference') fail('INVALID_PHOTO_CLAIM', 400);
  const clean = {...command, description: command.description.trim()};
  const signature = hash(clean);
  const claims = Object.values(project.photoClaims ?? {});
  const receipt = project.photoClaimRequests?.[clean.requestId];
  const old = claims.find(claim => claim.requestId === clean.requestId);
  if (receipt || old) {
    if ((receipt?.requestHash ?? old.requestHash) !== signature) fail('PHOTO_CLAIM_REQUEST_CONFLICT');
    return acknowledgement(claimFor(project, receipt?.claimId ?? old.id), true);
  }
  const existing = claims.find(claim => claim.productId === clean.productId && claim.slotId === clean.slotId && claim.candidateId === clean.candidateId && claim.sourceHash === clean.galleryHash);
  if (existing) {
    const verified = claimFor(project, existing.id);
    project.photoClaimRequests ??= {};
    project.photoClaimRequests[clean.requestId] = {claimId: existing.id, requestHash: signature};
    return acknowledgement(verified, true);
  }
  const snapshot = evidence(project, clean);
  const claim = {
    id: crypto.randomUUID(), projectId: project.id, productId: clean.productId, slotId: clean.slotId,
    candidateId: clean.candidateId, sourceHash: clean.galleryHash, requestId: clean.requestId,
    requestHash: signature, kind: clean.kind, description: clean.description, snapshot,
    evidenceHash: hash(snapshot), status: 'awaiting_review', createdAt: now(), reviews: [], specialistDecisions: [],
    explanation: 'Η αναφορά καταγράφηκε και αναμένει σύγκριση με το αρχικό υλικό και τις οδηγίες σου.',
    remediation: {status: 'not_applicable', kind: null},
  };
  project.photoClaims ??= {};
  project.photoClaims[claim.id] = claim;
  project.photoClaimRequests ??= {};
  project.photoClaimRequests[clean.requestId] = {claimId: claim.id, requestHash: signature};
  return acknowledgement(claim);
}

function restoreIncludedEntitlement(project, claim) {
  if (claim.remediation.status !== 'not_applicable') return;
  if (claim.snapshot.coverage === 'paid_credits' && boundDebit(project, claim.snapshot)) {
    const restored = restoreCredits(project, {debitId: claim.snapshot.billing.debitId, claimId: claim.id});
    claim.remediation = {status: 'credits_restored', kind: 'credits', amount: restored.amount, createdAt: restored.createdAt, alreadyRestored: restored.duplicate};
    return;
  }
  if (claim.snapshot.coverage !== 'included') {
    claim.remediation = {status: 'remediation_pending', kind: claim.snapshot.coverage === 'paid_credits' ? 'credits' : null};
    return;
  }
  project.photoReplacementEntitlements ??= {};
  let entitlement = Object.values(project.photoReplacementEntitlements).find(item => item.productId === claim.productId && item.slotId === claim.slotId && item.sourceHash === claim.sourceHash);
  if (!entitlement) {
    entitlement = {id: crypto.randomUUID(), productId: claim.productId, slotId: claim.slotId, sourceHash: claim.sourceHash, status: 'available', claimId: claim.id, createdAt: now()};
    project.photoReplacementEntitlements[entitlement.id] = entitlement;
  }
  claim.remediation = {status: 'entitlement_restored', kind: 'included_replacement', entitlementId: entitlement.id, createdAt: entitlement.createdAt};
}

function decide(project, claim, verdict, explanation) {
  claim.status = verdict === 'material_difference' ? 'confirmed' : verdict === 'no_material_difference' ? 'not_confirmed' : 'needs_specialist';
  claim.explanation = explanation;
  claim.decidedAt = now();
  if (claim.status === 'confirmed') restoreIncludedEntitlement(project, claim);
}

// Trusted worker completion ONLY. There is deliberately no customer endpoint for verdicts.
// This records a trusted review. AI execution and byte verification happen in the operator worker.
export function recordPhotoClaimReview(project, command) {
  if (!exact(command, ['claimId', 'reviewId', 'reviewerId', 'verdict', 'explanation', 'evidenceHash']) || !uuid(command.reviewId) || !text(command.reviewerId, 120) || !verdicts.includes(command.verdict) || !text(command.explanation, 4000) || !sha(command.evidenceHash)) fail('INVALID_PHOTO_CLAIM_REVIEW', 400);
  const claim = claimFor(project, command.claimId);
  if (claim.evidenceHash !== command.evidenceHash) fail('PHOTO_CLAIM_REVIEW_STALE');
  const clean = {...command, reviewerId: command.reviewerId.trim(), explanation: command.explanation.trim()};
  const signature = hash(clean);
  const duplicate = Object.values(project.photoClaims).flatMap(item => item.reviews).find(review => review.id === command.reviewId);
  if (duplicate) {
    if (duplicate.requestHash !== signature) fail('PHOTO_CLAIM_REVIEW_CONFLICT');
    return acknowledgement(claim, true);
  }
  const secondAfterUncertainty = claim.status === 'needs_specialist' && claim.reviews.length === 1 && claim.reviews[0].verdict === 'uncertain' && !claim.specialistDecisions.length;
  if (claim.status !== 'awaiting_review' && !secondAfterUncertainty) fail('PHOTO_CLAIM_REVIEW_CLOSED');
  if (claim.reviews.some(review => review.reviewerId === clean.reviewerId)) fail('PHOTO_CLAIM_INDEPENDENT_REVIEW_REQUIRED');
  claim.reviews.push({id: clean.reviewId, reviewerId: clean.reviewerId, verdict: clean.verdict, explanation: clean.explanation, evidenceHash: clean.evidenceHash, requestHash: signature, createdAt: now()});
  if (clean.verdict === 'uncertain') decide(project, claim, 'uncertain', clean.explanation);
  else if (claim.reviews.length === 2) {
    const agree = claim.reviews.every(review => review.verdict === clean.verdict);
    decide(project, claim, agree ? clean.verdict : 'uncertain', agree ? claim.reviews.map(review => review.explanation).join('\n\n') : 'Οι δύο έλεγχοι δεν κατέληξαν στο ίδιο συμπέρασμα. Χρειάζεται επανεξέταση από ειδικό.');
  }
  return acknowledgement(claim);
}

export function requestClaimEscalation(project, command) {
  if (!exact(command, ['claimId'])) fail('INVALID_PHOTO_CLAIM', 400);
  const claim = claimFor(project, command.claimId);
  if (claim.status === 'escalated') return acknowledgement(claim, true);
  if (!['not_confirmed', 'needs_specialist'].includes(claim.status)) fail('PHOTO_CLAIM_ESCALATION_NOT_AVAILABLE');
  claim.statusBeforeEscalation = claim.status;
  claim.status = 'escalated';
  claim.escalatedAt = now();
  return acknowledgement(claim);
}

// Trusted specialist boundary ONLY, separate from the customer request to escalate.
export function recordPhotoClaimSpecialistDecision(project, command) {
  if (!exact(command, ['claimId', 'decisionId', 'specialistId', 'verdict', 'explanation', 'evidenceHash']) || !uuid(command.decisionId) || !text(command.specialistId, 120) || !verdicts.includes(command.verdict) || !text(command.explanation, 4000) || !sha(command.evidenceHash)) fail('INVALID_PHOTO_CLAIM_DECISION', 400);
  const claim = claimFor(project, command.claimId);
  if (claim.evidenceHash !== command.evidenceHash) fail('PHOTO_CLAIM_REVIEW_STALE');
  const clean = {...command, specialistId: command.specialistId.trim(), explanation: command.explanation.trim()};
  const signature = hash(clean);
  const duplicate = Object.values(project.photoClaims).flatMap(item => item.specialistDecisions).find(decision => decision.id === command.decisionId);
  if (duplicate) {
    if (duplicate.requestHash !== signature) fail('PHOTO_CLAIM_DECISION_CONFLICT');
    return acknowledgement(claim, true);
  }
  if (!['escalated', 'needs_specialist'].includes(claim.status)) fail('PHOTO_CLAIM_SPECIALIST_NOT_READY');
  claim.specialistDecisions.push({id: clean.decisionId, specialistId: clean.specialistId, verdict: clean.verdict, explanation: clean.explanation, evidenceHash: clean.evidenceHash, requestHash: signature, createdAt: now()});
  decide(project, claim, clean.verdict, clean.explanation);
  return acknowledgement(claim);
}

export function publicPhotoClaims(project) {
  return Object.values(project.photoClaims ?? {}).map(claim => ({
    id: claim.id, productId: claim.productId, slotId: claim.slotId, candidateId: claim.candidateId,
    status: claim.status, description: claim.description, explanation: claim.explanation,
    createdAt: claim.createdAt, reviewCount: claim.reviews.length,
    canEscalate: ['not_confirmed', 'needs_specialist'].includes(claim.status),
    remediation: {...claim.remediation, ...(claim.remediation.entitlementId ? {entitlementStatus: project.photoReplacementEntitlements?.[claim.remediation.entitlementId]?.status ?? 'unavailable'} : {})},
  }));
}
