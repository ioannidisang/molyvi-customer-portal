import crypto from 'node:crypto';
import {canonicalJson, IntakeError} from './intake-store.mjs';

// Trusted application operations only. Payment verification, quotes and claim
// decisions happen upstream; customers must never call these mutations directly.
// Amounts are integer Molyvi credits, with no implicit euro or provider-token rate.
const SCHEMA_VERSION = 1;
const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
const own = (value, key) => Object.hasOwn(value, key);
const identifier = value => typeof value === 'string' && /^[a-z\d][a-z\d:._-]{0,159}$/i.test(value) && !['constructor', 'prototype', '__proto__'].includes(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const fail = (code, status = 409) => { throw new IntakeError(code, status); };
const hash = value => crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
const clone = value => structuredClone(value);
const lookup = (records, id) => own(records, id) ? records[id] : undefined;
const total = values => values.reduce((sum, value) => {
  if (!nonnegative(value) || !Number.isSafeInteger(sum + value)) fail('CREDIT_ARITHMETIC_OVERFLOW');
  return sum + value;
}, 0);

function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) fail('INVALID_CREDIT_TIMESTAMP', 400);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) fail('INVALID_CREDIT_TIMESTAMP', 400);
  return value;
}

function clock(options) {
  if (options !== undefined && !exact(options, ['now'])) fail('INVALID_CREDIT_OPTIONS', 400);
  return timestamp(options?.now ?? new Date().toISOString());
}

function binding(value) {
  if (!exact(value, ['productId', 'slotId', 'sourceHash', 'workId']) || !identifier(value.productId) || !identifier(value.slotId) || !identifier(value.workId) || typeof value.sourceHash !== 'string' || !/^[a-f\d]{64}$/.test(value.sourceHash)) fail('INVALID_CREDIT_BINDING', 400);
  return clone(value);
}

function empty(project) {
  return {schemaVersion: SCHEMA_VERSION, projectId: project.id, grants: {}, issueEvents: {}, reservations: {}, debits: {}, restorations: {}, claimRestorations: {}, history: []};
}

function validate(ledger, project) {
  if (!identifier(project?.id) || !object(ledger) || ledger.schemaVersion !== SCHEMA_VERSION || ledger.projectId !== project.id || !['grants', 'issueEvents', 'reservations', 'debits', 'restorations', 'claimRestorations'].every(key => object(ledger[key])) || !Array.isArray(ledger.history)) fail('INVALID_CREDIT_LEDGER');
  for (const [id, grant] of Object.entries(ledger.grants)) {
    if (!identifier(id) || grant.id !== id || !positive(grant.amount) || !nonnegative(grant.remaining) || grant.remaining > grant.amount || !['monthly', 'purchased'].includes(grant.kind)) fail('INVALID_CREDIT_LEDGER');
    if (grant.kind === 'monthly') timestamp(grant.expiresAt);
    else if (grant.expiresAt !== null) fail('INVALID_CREDIT_LEDGER');
    timestamp(grant.createdAt);
  }
  total(Object.values(ledger.grants).map(grant => grant.amount));
  for (const [id, reservation] of Object.entries(ledger.reservations)) {
    if (!identifier(id) || reservation.id !== id || !positive(reservation.amount) || !['reserved', 'settled', 'released'].includes(reservation.status) || !Array.isArray(reservation.slices) || !reservation.slices.length) fail('INVALID_CREDIT_LEDGER');
    binding(reservation.binding);
    for (const slice of reservation.slices) if (!positive(slice.amount) || !lookup(ledger.grants, slice.grantId)) fail('INVALID_CREDIT_LEDGER');
    if (total(reservation.slices.map(slice => slice.amount)) !== reservation.amount) fail('INVALID_CREDIT_LEDGER');
  }
  for (const [id, debit] of Object.entries(ledger.debits)) {
    const reservation = lookup(ledger.reservations, debit.reservationId);
    if (!identifier(id) || debit.id !== id || debit.debitId !== id || !positive(debit.amount) || !nonnegative(debit.restoredAmount) || debit.restoredAmount > debit.amount || !Array.isArray(debit.slices) || !debit.slices.length || reservation?.status !== 'settled' || reservation.debitId !== id || canonicalJson(debit.binding) !== canonicalJson(reservation.binding)) fail('INVALID_CREDIT_LEDGER');
    for (const slice of debit.slices) {
      const grant = lookup(ledger.grants, slice.grantId);
      if (!grant || !positive(slice.amount) || slice.kind !== grant.kind || slice.expiresAt !== grant.expiresAt) fail('INVALID_CREDIT_LEDGER');
    }
    if (total(debit.slices.map(slice => slice.amount)) !== debit.amount) fail('INVALID_CREDIT_LEDGER');
  }
  // Conservation is checked per lot, including expired unused amounts. Restored
  // credits are new lots; historical debits continue consuming their old lots.
  for (const grant of Object.values(ledger.grants)) {
    const reserved = Object.values(ledger.reservations).filter(item => item.status === 'reserved').flatMap(item => item.slices).filter(slice => slice.grantId === grant.id).map(slice => slice.amount);
    const spent = Object.values(ledger.debits).flatMap(item => item.slices).filter(slice => slice.grantId === grant.id).map(slice => slice.amount);
    if (total([grant.remaining, ...reserved, ...spent]) !== grant.amount) fail('INVALID_CREDIT_LEDGER');
  }
  return ledger;
}

function read(project) {
  if (!identifier(project?.id)) fail('INVALID_CREDIT_PROJECT', 400);
  return validate(project.creditLedger ?? empty(project), project);
}

function mutate(project, operation) {
  const staged = clone(read(project));
  const result = operation(staged);
  validate(staged, project);
  project.creditLedger = staged;
  return clone(result);
}

function history(ledger, type, amount, createdAt, details = {}) {
  ledger.history.push({id: crypto.randomUUID(), type, amount, createdAt, ...details});
}

function reservationResult(record, duplicate) {
  return {reservationId: record.id, status: record.status, amount: record.amount, binding: clone(record.binding), duplicate};
}

export function issueCredits(project, command, options) {
  const now = clock(options);
  if (!exact(command, ['eventId', 'kind', 'amount', 'expiresAt']) || !identifier(command.eventId) || !['monthly', 'purchased'].includes(command.kind) || !positive(command.amount)) fail('INVALID_CREDIT_ISSUE', 400);
  const expiresAt = command.kind === 'monthly' ? timestamp(command.expiresAt) : null;
  if (command.kind === 'purchased' && command.expiresAt !== undefined && command.expiresAt !== null) fail('INVALID_CREDIT_ISSUE', 400);
  const signature = hash({eventId: command.eventId, kind: command.kind, amount: command.amount, expiresAt});
  return mutate(project, ledger => {
    const old = lookup(ledger.issueEvents, command.eventId);
    if (old) {
      if (old.signature !== signature) fail('CREDIT_ISSUE_CONFLICT');
      return {grantId: old.grantId, amount: ledger.grants[old.grantId].amount, duplicate: true};
    }
    if (expiresAt !== null && expiresAt <= now) fail('CREDIT_ISSUE_ALREADY_EXPIRED', 422);
    const grantId = crypto.randomUUID();
    ledger.grants[grantId] = {id: grantId, kind: command.kind, amount: command.amount, remaining: command.amount, expiresAt, createdAt: now, origin: {kind: 'verified_issue', eventId: command.eventId}};
    ledger.issueEvents[command.eventId] = {signature, grantId};
    history(ledger, 'issued', command.amount, now, {grantId, kind: command.kind});
    return {grantId, amount: command.amount, duplicate: false};
  });
}

export function reserveCredits(project, command, options) {
  const now = clock(options);
  if (!exact(command, ['reservationId', 'amount', 'binding']) || !identifier(command.reservationId) || !positive(command.amount)) fail('INVALID_CREDIT_RESERVATION', 400);
  const frozenBinding = binding(command.binding);
  const signature = hash({reservationId: command.reservationId, amount: command.amount, binding: frozenBinding});
  return mutate(project, ledger => {
    const old = lookup(ledger.reservations, command.reservationId);
    if (old) {
      if (old.signature !== signature) fail('CREDIT_RESERVATION_CONFLICT');
      return reservationResult(old, true);
    }
    const eligible = Object.values(ledger.grants).filter(grant => grant.remaining > 0 && (grant.expiresAt === null || grant.expiresAt > now)).sort((a, b) => {
      if (a.expiresAt === null && b.expiresAt !== null) return 1;
      if (a.expiresAt !== null && b.expiresAt === null) return -1;
      return (a.expiresAt ?? '').localeCompare(b.expiresAt ?? '') || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
    });
    if (total(eligible.map(grant => grant.remaining)) < command.amount) fail('INSUFFICIENT_CREDITS', 402);
    let remaining = command.amount;
    const slices = [];
    for (const grant of eligible) {
      if (!remaining) break;
      const amount = Math.min(grant.remaining, remaining);
      grant.remaining -= amount;
      remaining -= amount;
      slices.push({grantId: grant.id, amount});
    }
    const reservation = {id: command.reservationId, amount: command.amount, binding: frozenBinding, status: 'reserved', signature, slices, createdAt: now};
    ledger.reservations[reservation.id] = reservation;
    history(ledger, 'reserved', command.amount, now, {reservationId: reservation.id});
    return reservationResult(reservation, false);
  });
}

export function settleCredits(project, command, options) {
  const now = clock(options);
  if (!exact(command, ['reservationId', 'debitId', 'amount']) || !identifier(command.reservationId) || !identifier(command.debitId) || !positive(command.amount)) fail('INVALID_CREDIT_SETTLEMENT', 400);
  return mutate(project, ledger => {
    const reservation = lookup(ledger.reservations, command.reservationId);
    if (!reservation) fail('CREDIT_RESERVATION_NOT_FOUND', 404);
    if (reservation.status === 'settled') {
      const debit = ledger.debits[reservation.debitId];
      if (debit.id !== command.debitId || debit.amount !== command.amount) fail('CREDIT_SETTLEMENT_CONFLICT');
      return {debitId: debit.id, amount: debit.amount, releasedAmount: reservation.amount - debit.amount, duplicate: true};
    }
    if (reservation.status !== 'reserved') fail('CREDIT_RESERVATION_CLOSED');
    if (lookup(ledger.debits, command.debitId)) fail('CREDIT_DEBIT_CONFLICT');
    if (command.amount > reservation.amount) fail('CREDIT_SETTLEMENT_EXCEEDS_RESERVATION');
    let remaining = command.amount;
    const slices = [];
    for (const reservedSlice of reservation.slices) {
      const grant = ledger.grants[reservedSlice.grantId];
      const amount = Math.min(remaining, reservedSlice.amount);
      if (amount) slices.push({grantId: grant.id, amount, kind: grant.kind, expiresAt: grant.expiresAt, origin: clone(grant.origin)});
      // Released quantity retains its original lot and expiry, including when it
      // expired while the requested operation was running.
      grant.remaining += reservedSlice.amount - amount;
      remaining -= amount;
    }
    const debit = {id: command.debitId, debitId: command.debitId, reservationId: reservation.id, amount: command.amount, restoredAmount: 0, binding: clone(reservation.binding), slices, createdAt: now};
    ledger.debits[debit.id] = debit;
    reservation.status = 'settled';
    reservation.debitId = debit.id;
    reservation.settledAt = now;
    const releasedAmount = reservation.amount - debit.amount;
    history(ledger, 'settled', debit.amount, now, {debitId: debit.id, reservationId: reservation.id, releasedAmount});
    return {debitId: debit.id, amount: debit.amount, releasedAmount, duplicate: false};
  });
}

export function releaseCredits(project, command, options) {
  const now = clock(options);
  if (!exact(command, ['reservationId']) || !identifier(command.reservationId)) fail('INVALID_CREDIT_RELEASE', 400);
  return mutate(project, ledger => {
    const reservation = lookup(ledger.reservations, command.reservationId);
    if (!reservation) fail('CREDIT_RESERVATION_NOT_FOUND', 404);
    if (reservation.status === 'released') return {reservationId: reservation.id, status: 'released', releasedAmount: reservation.amount, duplicate: true};
    if (reservation.status !== 'reserved') fail('CREDIT_RESERVATION_CLOSED');
    for (const slice of reservation.slices) ledger.grants[slice.grantId].remaining += slice.amount;
    reservation.status = 'released';
    reservation.releasedAt = now;
    history(ledger, 'released', reservation.amount, now, {reservationId: reservation.id});
    return {reservationId: reservation.id, status: 'released', releasedAmount: reservation.amount, duplicate: false};
  });
}

export function restoreCredits(project, command, options) {
  const now = clock(options);
  if (!exact(command, ['debitId', 'claimId']) || !identifier(command.debitId) || !identifier(command.claimId)) fail('INVALID_CREDIT_RESTORATION', 400);
  return mutate(project, ledger => {
    const debit = lookup(ledger.debits, command.debitId);
    if (!debit) fail('CREDIT_DEBIT_NOT_FOUND', 404);
    const previousClaim = lookup(ledger.claimRestorations, command.claimId);
    if (previousClaim && previousClaim !== debit.id) fail('CREDIT_RESTORATION_CLAIM_CONFLICT');
    const old = lookup(ledger.restorations, debit.id);
    if (old) return {...old, duplicate: true};
    // All supported restorations are exact, whole net-debit refunds. There is no
    // amount in this command for a caller to inflate or refund twice.
    if (debit.restoredAmount !== 0) fail('CREDIT_RESTORATION_STATE_INVALID');
    const minimumExpiry = new Date(Date.parse(now) + THIRTY_DAYS).toISOString();
    timestamp(minimumExpiry);
    const grantIds = [];
    for (const slice of debit.slices) {
      const grantId = crypto.randomUUID();
      const expiresAt = slice.kind === 'purchased' ? null : slice.expiresAt > minimumExpiry ? slice.expiresAt : minimumExpiry;
      ledger.grants[grantId] = {id: grantId, kind: slice.kind, amount: slice.amount, remaining: slice.amount, expiresAt, createdAt: now, origin: {kind: 'confirmed_fault_restoration', debitId: debit.id, claimId: command.claimId, sourceGrantId: slice.grantId, sourceOrigin: clone(slice.origin)}};
      grantIds.push(grantId);
    }
    debit.restoredAmount = debit.amount;
    const restored = {debitId: debit.id, claimId: command.claimId, amount: debit.amount, grantIds, createdAt: now};
    ledger.restorations[debit.id] = restored;
    ledger.claimRestorations[command.claimId] = debit.id;
    history(ledger, 'restored', debit.amount, now, {debitId: debit.id, claimId: command.claimId, grantIds});
    return {...restored, duplicate: false};
  });
}

export function getCreditDebit(project, debitId) {
  if (!identifier(debitId)) fail('INVALID_CREDIT_DEBIT', 400);
  return clone(lookup(read(project).debits, debitId) ?? null);
}

export function publicCreditWallet(project, options) {
  const now = clock(options);
  const ledger = read(project);
  const grants = Object.values(ledger.grants).map(grant => {
    const reserved = total(Object.values(ledger.reservations).filter(item => item.status === 'reserved').flatMap(item => item.slices).filter(slice => slice.grantId === grant.id).map(slice => slice.amount));
    const expired = grant.expiresAt !== null && grant.expiresAt <= now ? grant.remaining : 0;
    return {id: grant.id, kind: grant.kind, available: grant.remaining - expired, reserved, expired, expiresAt: grant.expiresAt, restored: grant.origin.kind === 'confirmed_fault_restoration'};
  });
  const amounts = kind => {
    const chosen = grants.filter(grant => !kind || grant.kind === kind);
    return {available: total(chosen.map(grant => grant.available)), reserved: total(chosen.map(grant => grant.reserved)), expired: total(chosen.map(grant => grant.expired))};
  };
  return {
    schemaVersion: SCHEMA_VERSION, unit: 'credits', ...amounts(), monthly: amounts('monthly'), purchased: amounts('purchased'), grants,
    debited: total(Object.values(ledger.debits).map(debit => debit.amount)),
    restored: total(Object.values(ledger.debits).map(debit => debit.restoredAmount)),
    history: ledger.history.map(event => ({id: event.id, type: event.type, amount: event.amount, createdAt: event.createdAt, ...(event.kind ? {kind: event.kind} : {}), ...(event.releasedAmount !== undefined ? {releasedAmount: event.releasedAmount} : {})})),
  };
}
