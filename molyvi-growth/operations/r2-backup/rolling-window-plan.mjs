import {R2_LIMITS} from './r2-budget.mjs';

// Pure advisory transfer/request forecast. No SDK, filesystem, database,
// scheduler changes, reservations or deletion credits. A plan is not admission.
const fields = ['requests', 'uploadBytes', 'downloadBytes'];
const windowMs = R2_LIMITS.windowDays * 86_400_000;
const check = (value, code) => { if (!value) throw Error(code); };
function at(value) {
  check(typeof value === 'string' && Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value, 'WINDOW_PLAN_TIME');
  return Date.parse(value);
}
function amount(row) {
  check(row && fields.every(f => Number.isSafeInteger(row[f]) && row[f] >= 0), 'WINDOW_PLAN_AMOUNT');
  check(fields.some(f => row[f] > 0), 'WINDOW_PLAN_EMPTY');
  return Object.fromEntries(fields.map(f => [f, row[f]]));
}
function usage(rows, time) {
  const active = rows.filter(r => r.at > time - windowMs && r.at <= time);
  return Object.fromEntries(fields.map(f => {
    const total = active.reduce((n, r) => n + r[f], 0);
    check(Number.isSafeInteger(total), 'WINDOW_PLAN_OVERFLOW'); return [f, total];
  }));
}
function add(a, b) {
  return Object.fromEntries(fields.map(f => {
    const total = a[f] + b[f]; check(Number.isSafeInteger(total), 'WINDOW_PLAN_OVERFLOW'); return [f, total];
  }));
}
const blockers = projected => fields.filter(f => projected[f] > R2_LIMITS[f]);

export function planRollingWindow({ observedAt, reservations, attempts }) {
  const observed = at(observedAt);
  check(Array.isArray(reservations) && reservations.length <= 10000 &&
    Array.isArray(attempts) && attempts.length > 0 && attempts.length <= 104, 'WINDOW_PLAN_BOUNDS');
  const ids = new Set();
  const rows = reservations.map(r => {
    check(typeof r.id === 'string' && r.id.length > 0 && !ids.has(r.id), 'WINDOW_PLAN_ID'); ids.add(r.id);
    const time = at(r.at); check(time <= observed, 'WINDOW_PLAN_FUTURE_RESERVATION');
    // All prior reservations count, including failures and uncertain responses.
    return {id:r.id, at:time, ...amount(r)};
  });
  let previous = observed;
  const planned = attempts.map(r => {
    check(typeof r.id === 'string' && r.id.length > 0 && !ids.has(r.id), 'WINDOW_PLAN_ID'); ids.add(r.id);
    const time = at(r.at); check(time >= previous, 'WINDOW_PLAN_ORDER'); previous = time;
    return {id:r.id, at:time, ...amount(r)};
  });
  const results = [];
  let stopped = false;
  for (const attempt of planned) {
    if (stopped) {
      results.push({id:attempt.id, at:new Date(attempt.at).toISOString(), status:'NOT_EVALUATED_AFTER_STOP'}); continue;
    }
    const consumed = usage(rows, attempt.at), demand = amount(attempt), projected = add(consumed, demand);
    const blockedBy = blockers(projected);
    let earliestRecheckAt = null;
    if (blockedBy.length) {
      // Informational date only: no retries, future charges or future deletion
      // are assumed. A real run still needs fresh inventory and actual sizes.
      const expiries = [...new Set(rows.map(r => r.at + windowMs).filter(t => t > attempt.at))].sort((a,b) => a-b);
      const first = expiries.find(time => blockers(add(usage(rows,time),demand)).length === 0);
      if (first !== undefined) earliestRecheckAt = new Date(first).toISOString();
      stopped = true;
    } else {
      // Hypothetical successful run, conservatively charged in full at its date.
      rows.push(attempt);
    }
    results.push({id:attempt.id,at:new Date(attempt.at).toISOString(),
      status:blockedBy.length?'STOP':'WITHIN_TRANSFER_WINDOW',consumed,demand,projected,blockedBy,earliestRecheckAt});
  }
  return {schemaVersion:1,scope:'TRANSFER_REQUEST_FORECAST_ONLY',observedAt,
    limits:R2_LIMITS,initialUsage:usage(rows.filter(r => !planned.includes(r)),observed),
    results,canCompletePlannedSequence:!stopped,activationReady:false,
    actualReservationPerformed:false,providerCalls:0,deletionCreditBytes:0,
    remoteInventoryVerified:false,storageCapacityEvaluated:false,automaticReschedule:false};
}
