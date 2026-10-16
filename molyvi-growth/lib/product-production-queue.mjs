import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {canonicalJson, IntakeError} from './intake-store.mjs';
import {prepareProductPilot, importProductPilot} from './product-pilot-import.mjs';
import {productFor, photoSetHash} from './product-materials.mjs';
import {requestTextVariant} from './product-text.mjs';
import {serviceProductionEligible} from './service-production-queue.mjs';

const uuid = value => typeof value === 'string' && /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(value);
const hash = value => crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
const fail = code => {throw new IntakeError(code, 409);};
const stamp = value => {const d = value instanceof Date ? value : new Date(value); if (!Number.isFinite(d.getTime())) fail('INVALID_PRODUCTION_TIME'); return d.toISOString();};
const jobs = project => Object.values(project.productProductionQueue?.jobs ?? {});

// Only requests already saved by explicit customer actions are eligible. Saving
// a product, opening a page or viewing status creates no generation allowance.
function pendingRequests(project) {
  if (project.order.status !== 'verified_paid') return [];
  const requests = [];
  for (const review of Object.values(project.photoReviews ?? {})) if (review.status === 'awaiting_review') {
    requests.push({kind: 'materials', productId: review.productId, ...(review.visualUnitId ? {visualUnitId: review.visualUnitId} : {}),
      requestId: review.id, sourceHash: review.fingerprint, requestedAt: review.requestedAt});
  }
  for (const [productId, fields] of Object.entries(project.productTexts ?? {})) for (const [field, state] of Object.entries(fields)) {
    for (const request of state.requests ?? []) if (request.status === 'awaiting_provider') requests.push({kind: 'text', productId, field,
      requestId: request.id, sourceHash: request.inputHash, requestedAt: request.requestedAt});
  }
  return requests;
}
const requestKey = value => hash({kind: value.kind, productId: value.productId, visualUnitId: value.visualUnitId ?? null, field: value.field ?? null, requestId: value.requestId});
export function enqueuePendingProductProduction(project, {now = new Date()} = {}) {
  let added = 0;
  for (const request of pendingRequests(project)) {
    if (!uuid(request.productId) || !uuid(request.requestId) || !['materials', 'text'].includes(request.kind)) fail('INVALID_PRODUCTION_REQUEST');
    const key = requestKey(request), existing = jobs(project).find(job => job.requestKey === key);
    if (existing) {if (existing.sourceHash !== request.sourceHash) fail('PRODUCTION_REQUEST_CONFLICT'); continue;}
    const id = crypto.randomUUID(); project.productProductionQueue ??= {version: 1, jobs: {}};
    project.productProductionQueue.jobs[id] = {id, ...request, requestKey: key, runId: `production-${crypto.randomUUID()}`,
      status: 'queued', createdAt: stamp(now)};
    added++;
  }
  return {added, queued: jobs(project).filter(job => job.status === 'queued').length};
}
export function publicProductProductionQueue(project) {
  return jobs(project).map(({id, kind, productId, visualUnitId, field, status, reason}) => ({id, kind, productId,
    ...(visualUnitId ? {visualUnitId} : {}), ...(field ? {field} : {}), status, reason: reason ?? null}));
}
const currentRequest = (project, job) => {
  const request = pendingRequests(project).find(request => requestKey(request) === job.requestKey && request.sourceHash === job.sourceHash);
  if (!request) return null;
  if (job.kind === 'materials') {
    try {if (photoSetHash(project, productFor(project, job.productId), job.visualUnitId) !== job.sourceHash) return null;}
    catch {return null;}
  }
  return request;
};

// Single-process TaskStore plus a persistent exclusive lock. A dead process's
// lock must be inspected and removed by an operator, never guessed from age.
const owners = new Map();
export function createProductProductionQueue({store, provider, enabled = false, dailyAttemptLimit = 12, timeoutMs = 180000,
  pollMs = 1000, now = () => new Date(), projectIds=null, requireServiceTestPayment=false, requestIds=null, lifetimeAttemptLimit=null} = {}) {
  if (!store || !Number.isSafeInteger(dailyAttemptLimit) || dailyAttemptLimit < 1 || dailyAttemptLimit > 1000
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000 || !Number.isSafeInteger(pollMs) || pollMs < 1
      ||typeof requireServiceTestPayment!=='boolean'||projectIds!==null&&(!Array.isArray(projectIds)||!projectIds.length||projectIds.some(id=>!uuid(id))||new Set(projectIds).size!==projectIds.length)
      ||requireServiceTestPayment&&projectIds===null
      ||requestIds!==null&&(!Array.isArray(requestIds)||!requestIds.length||requestIds.some(id=>!uuid(id))||new Set(requestIds).size!==requestIds.length)
      ||lifetimeAttemptLimit!==null&&(!Number.isSafeInteger(lifetimeAttemptLimit)||lifetimeAttemptLimit<1||lifetimeAttemptLimit>5||requestIds===null)) fail('INVALID_PRODUCTION_QUEUE_CONFIG');
  const produce = typeof provider === 'function' ? provider : provider?.produce?.bind(provider);
  const key = path.resolve(store.storage), owner = Symbol('product-production'), lockToken = crypto.randomUUID(), lockDirectory = path.join(key, '.product-production-worker.lock');
  let lockHeld = false, releasing, initialized = false, initializing, inflight, timer, stopped = false, suspended=false, controller, outstanding = false, lastError = null;
  const scopedJobs=record=>jobs(record).filter(job=>requestIds===null||requestIds.includes(job.requestId));
  const date = () => stamp(now());
  async function acquireLock() {
    try {await fs.mkdir(lockDirectory, {mode: 0o700});} catch (error) {if (error.code === 'EEXIST') fail('PRODUCTION_WORKER_LOCKED'); throw error;}
    try {await fs.writeFile(path.join(lockDirectory, 'owner.json'), JSON.stringify({token: lockToken, pid: process.pid, createdAt: date()}), {flag: 'wx'}); lockHeld = true;}
    catch (error) {await fs.rmdir(lockDirectory).catch(() => {}); throw error;}
  }
  async function releaseLock() {
    if (releasing) return releasing;
    if (!lockHeld) return;
    releasing = (async () => {
      const filename = path.join(lockDirectory, 'owner.json'), record = JSON.parse(await fs.readFile(filename, 'utf8'));
      if (record.token !== lockToken) fail('PRODUCTION_LOCK_OWNERSHIP_CHANGED');
      await fs.unlink(filename); await fs.rmdir(lockDirectory); lockHeld = false;
      if (owners.get(key) === owner) owners.delete(key);
    })().finally(() => {releasing = null;});
    return releasing;
  }
  async function projects() {
    const found = [];
    for (const entry of await fs.readdir(store.storage, {withFileTypes: true})) {
      if (!uuid(entry.name)) continue;
      if(projectIds!==null&&!projectIds.includes(entry.name))continue;
      if (entry.isSymbolicLink() || !entry.isDirectory()) fail('PRODUCTION_UNSAFE_PROJECT');
      try {
        const directory = await store.directory(entry.name), filename = path.join(directory, 'workspace.json'), info = await fs.lstat(filename);
        if (info.isSymbolicLink() || !info.isFile()) fail('PRODUCTION_UNSAFE_PROJECT');
        const candidate = JSON.parse(await fs.readFile(filename, 'utf8'));
        if (candidate.id !== entry.name || !uuid(candidate.ownerId)) fail('PRODUCTION_UNSAFE_PROJECT');
        const session = {projectId: candidate.id, ownerId: candidate.ownerId};
        const record=await store.read(session.projectId, session.ownerId);
        if(requireServiceTestPayment&&!serviceProductionEligible(record))continue;
        found.push({session, record});
      } catch (error) {if (error.code === 'ENOENT' || error.code === 'PROJECT_NOT_FOUND') continue; throw error;}
    }
    return found;
  }
  async function initialize() {
    if (initialized) return;
    if (initializing) return initializing;
    initializing = (async () => {
      if (owners.has(key) && owners.get(key) !== owner) fail('PRODUCTION_WORKER_ALREADY_ACTIVE');
      owners.set(key, owner);
      try {
        await acquireLock();
        for (const {session} of await projects()) await store.transact(session.projectId, session.ownerId, project => {
          // Restart recovers only saved customer requests; it does not request
          // more texts or images. Ambiguous attempts are never blindly retried.
          enqueuePendingProductProduction(project, {now: date()});
          for (const job of scopedJobs(project)) if (job.status === 'running') {
            job.status = job.savedResult ? 'result_ready' : 'paused';
            if (!job.savedResult) {job.reason = 'interrupted_attempt'; job.pausedAt = date();}
          }
        });
        initialized = true;
      } catch (error) {await releaseLock().catch(() => {}); if (owners.get(key) === owner) owners.delete(key); throw error;}
    })();
    try {await initializing;} finally {initializing = null;}
  }
  async function update(session, id, operation) {
    return store.transact(session.projectId, session.ownerId, project => {
      const job = project.productProductionQueue?.jobs?.[id]; if (!job) fail('PRODUCTION_JOB_MISSING'); return operation(job, project);
    });
  }
  const pause = (session, id, reason) => update(session, id, job => {job.status = 'paused'; job.reason = reason; job.pausedAt = date();});
  async function importSaved(session, job) {
    try {
      const imported = await importProductPilot(store, session, job.savedResult);
      await update(session, job.id, current => {current.status = 'completed'; current.completedAt = date(); current.receiptHash = hash(imported.result.receipt); delete current.reason;});
      return {processed: true, imported: true, kind: job.kind, productId: job.productId};
    } catch {await pause(session, job.id, 'invalid_or_stale_result'); return {processed: true, paused: true, reason: 'invalid_or_stale_result'};}
  }
  async function one() {
    if (stopped || !enabled || !produce || outstanding) return {processed: false, reason: stopped ? 'stopped' : outstanding ? 'provider_busy' : 'provider_unavailable'};
    await initialize();
    if (stopped) return {processed: false, reason: 'stopped'};
    const all = await projects(), current = date();
    const attempts = all.reduce((sum, {record}) => sum + jobs(record).filter(job => job.attemptStartedAt?.slice(0, 10) === current.slice(0, 10)).length, 0);
    for (const {session, record} of all) {
      const saved = scopedJobs(record).find(job => job.status === 'result_ready' && job.savedResult);
      if (saved) return importSaved(session, saved);
    }
    const lifetimeAttempts=all.reduce((n,{record})=>n+scopedJobs(record).filter(job=>job.attemptStartedAt).length,0);
    for (const {session, record} of all) for (const job of scopedJobs(record).sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      if (job.status !== 'queued') continue;
      if(lifetimeAttemptLimit!==null&&lifetimeAttempts>=lifetimeAttemptLimit)return {processed:false,reason:'lifetime_attempt_limit'};
      if (!currentRequest(record, job)) {await update(session, job.id, j => {j.status = 'cancelled'; j.reason = 'source_or_request_changed';}); continue;}
      if (attempts >= dailyAttemptLimit) {await update(session, job.id, j => {j.reason = 'daily_attempt_limit';}); return {processed: false, reason: 'daily_attempt_limit'};}
      let packet;
      try {
        ({result: packet} = await prepareProductPilot(store, session, {kind: job.kind, productId: job.productId,
          ...(job.visualUnitId ? {visualUnitId: job.visualUnitId} : {}), ...(job.field ? {field: job.field} : {}), requestId: job.requestId}));
        if (packet.kind !== job.kind || packet.productId !== job.productId || (job.kind === 'materials' ? packet.reviewId !== job.requestId || packet.fingerprint !== job.sourceHash : packet.requestId !== job.requestId || packet.inputHash !== job.sourceHash)) fail('PRODUCTION_PACKET_STALE');
      } catch {await pause(session, job.id, 'invalid_or_stale_input'); return {processed: true, paused: true, reason: 'invalid_or_stale_input'};}
      if (stopped) return {processed: false, reason: 'stopped'};
      let active;
      try {
        ({result: active} = await update(session, job.id, (j, project) => {
          if (j.status !== 'queued' || j.attemptStartedAt || !currentRequest(project, j)||requireServiceTestPayment&&!serviceProductionEligible(project)) fail('PRODUCTION_JOB_STALE');
          // Existing request ID performs a current-source check without creating
          // another candidate; it closes the prepare -> attempt reservation race.
          if (j.kind === 'text') {
            const request = requestTextVariant(project, {productId: j.productId, field: j.field, requestId: j.requestId});
            if (request.id !== j.requestId || request.inputHash !== packet.inputHash || request.status !== 'awaiting_provider') fail('PRODUCTION_JOB_STALE');
          }
          j.status = 'running'; j.attemptStartedAt = current; j.payloadHash = packet.payloadHash; delete j.reason; return structuredClone(j);
        }));
      } catch {await pause(session, job.id, 'invalid_or_stale_input'); return {processed: true, paused: true, reason: 'invalid_or_stale_input'};}
      if (stopped) {await pause(session, active.id, 'worker_stopped'); return {processed: true, paused: true, reason: 'worker_stopped'};}
      controller = new AbortController(); const signal = controller.signal;
      let timeout, abortListener;
      const interrupted = new Promise((_, reject) => {
        abortListener = () => reject(Object.assign(new Error('production interrupted'), {code: signal.reason === 'timeout' ? 'PRODUCTION_TIMEOUT' : 'PRODUCTION_STOPPED'}));
        signal.addEventListener('abort', abortListener, {once: true}); timeout = setTimeout(() => controller?.abort('timeout'), timeoutMs);
      });
      outstanding = true;
      const execution = Promise.resolve().then(() => produce({packet, runId: active.runId, signal}));
      const releaseProvider = () => {outstanding = false; if (stopped && !inflight) void releaseLock().catch(error => {lastError = error.code ?? 'PRODUCTION_LOCK_ERROR';});};
      execution.then(releaseProvider, releaseProvider);
      try {
        const output = await Promise.race([execution, interrupted]);
        if (signal.aborted) fail('PRODUCTION_STOPPED');
        if (!output || output.execution?.runId !== active.runId || output.execution?.route !== 'codex_cli_chatgpt'
            || output.evidence?.inputHash !== packet.payloadHash || canonicalJson(output.execution.inspectedSha256) !== canonicalJson(packet.assetEvidence.map(asset => asset.sha256))) fail('PRODUCTION_RESULT_INVALID');
        const savedResult = {packet, result: output.result, evidence: output.evidence};
        await update(session, active.id, j => {j.savedResult = structuredClone(savedResult); j.execution = structuredClone(output.execution); j.status = 'result_ready'; j.resultReadyAt = date();});
        return importSaved(session, {...active, savedResult});
      } catch (error) {
        const reason = error.code === 'PRODUCTION_TIMEOUT' ? 'timeout' : error.code === 'PRODUCTION_STOPPED' ? 'worker_stopped' : error.code === 'PRODUCT_PROVIDER_USAGE_LIMIT' ? 'subscription_limit' : 'provider_failed';
        await pause(session, active.id, reason); return {processed: true, paused: true, reason};
      } finally {clearTimeout(timeout); signal.removeEventListener('abort', abortListener); controller = null;}
    }
    return {processed: false, reason: 'idle'};
  }
  function tick() {
    if(suspended)return Promise.resolve({processed:false,reason:'suspended'});
    if (inflight) return inflight;
    inflight = one().then(result => {lastError = null; return result;}).catch(error => {lastError = error.code ?? 'PRODUCTION_QUEUE_ERROR'; throw error;}).finally(() => {inflight = null;});
    return inflight;
  }
  return {
    async start() {
      if (stopped || !enabled || !produce) return this.status();
      await initialize(); if (stopped) return this.status();
      if (!timer) {timer = setInterval(() => {void tick().catch(() => {});}, pollMs); timer.unref?.();}
      void tick().catch(() => {}); return this.status();
    },
    tick,
    suspend(){suspended=true;return ()=>{suspended=false;};},
    async drain({maxPasses = dailyAttemptLimit} = {}) {
      if (!Number.isSafeInteger(maxPasses) || maxPasses < 1 || maxPasses > 1000) fail('INVALID_PRODUCTION_QUEUE_CONFIG');
      const results = []; for (let i = 0; i < maxPasses; i++) {const result = await tick(); results.push(result); if (!result.processed) break;} return results;
    },
    async stop() {stopped = true; clearInterval(timer); timer = null; controller?.abort('stopped'); if (inflight) await inflight.catch(() => {}); if (initializing) await initializing.catch(() => {}); if (!outstanding) await releaseLock();},
    status() {return {enabled: Boolean(enabled && produce), initialized, running: Boolean(inflight || outstanding), stopped, lastError};},
  };
}
