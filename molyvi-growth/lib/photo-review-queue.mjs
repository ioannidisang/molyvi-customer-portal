import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {canonicalJson, IntakeError} from './intake-store.mjs';
import {preparePhotoClaimReview, importPhotoClaimReview} from './photo-review-worker.mjs';

const uuid = value => typeof value === 'string' && /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(value);
const hash = value => crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
const fail = code => { throw new IntakeError(code, 409); };
const stamp = value => { const d = value instanceof Date ? value : new Date(value); if (!Number.isFinite(d.getTime())) fail('INVALID_REVIEW_QUEUE_TIME'); return d.toISOString(); };
const jobsFor = (project, claimId) => Object.values(project.photoReviewQueue?.jobs ?? {}).filter(job => job.claimId === claimId).sort((a, b) => a.passIndex - b.passIndex);
const reviewable = claim => claim && (claim.status === 'awaiting_review' || (claim.status === 'needs_specialist' && claim.reviews?.length === 1 && claim.reviews[0].verdict === 'uncertain' && !claim.specialistDecisions?.length));

// Call inside the same owner-checked transaction that opens the claim. Customer
// payloads cannot choose a reviewer, a verdict, a quota, or a credit restoration.
export function enqueuePhotoClaimReview(project, {claimId, now = new Date()} = {}) {
  if (!uuid(claimId)) fail('INVALID_PHOTO_CLAIM');
  const claim = project.photoClaims?.[claimId];
  if (!claim || claim.projectId !== project.id || hash(claim.snapshot) !== claim.evidenceHash) fail('PHOTO_CLAIM_EVIDENCE_CHANGED');
  const existing = jobsFor(project, claimId);
  if (existing.length) {
    if (existing.length !== 2 || existing.some(job => job.evidenceHash !== claim.evidenceHash)) fail('PHOTO_REVIEW_QUEUE_CONFLICT');
    return {queued: true, duplicate: true, claimId};
  }
  if (!reviewable(claim)) return {queued: false, reason: 'claim_closed', claimId};
  const createdAt = stamp(now), jobs = [];
  for (let i = 0; i < 2; i++) {
    const previous = claim.reviews?.[i], id = previous?.id ?? crypto.randomUUID();
    jobs.push({id, claimId, evidenceHash: claim.evidenceHash, passIndex: i + 1,
      reviewerId: previous?.reviewerId ?? `automatic-independent-${i + 1}-${crypto.randomUUID()}`,
      runId: `queue-${crypto.randomUUID()}`, createdAt,
      status: previous ? 'completed' : 'queued', ...(previous ? {completedAt: previous.createdAt, importedExisting: true} : {})});
  }
  project.photoReviewQueue ??= {version: 1, jobs: {}};
  for (const job of jobs) project.photoReviewQueue.jobs[job.id] = job;
  return {queued: true, duplicate: false, claimId};
}

export function publicPhotoReviewQueue(project, claimId) {
  const ids = [...new Set(Object.values(project.photoReviewQueue?.jobs ?? {}).map(job => job.claimId))];
  const summaries = ids.map(id => {
    const jobs = jobsFor(project, id), completedPasses = jobs.filter(job => job.status === 'completed').length;
    const paused = jobs.find(job => job.status === 'paused'), running = jobs.some(job => ['running', 'result_ready'].includes(job.status));
    const status = completedPasses === 2 ? 'completed' : paused ? 'paused' : running ? 'running' : jobs.every(job => ['completed', 'cancelled'].includes(job.status)) ? 'cancelled' : 'queued';
    const reason = paused?.reason ?? jobs.find(job => job.reason)?.reason ?? null;
    return {claimId: id, status, completedPasses, totalPasses: 2, pendingPasses: jobs.filter(job => !['completed', 'cancelled'].includes(job.status)).length, reason, pauseReason: paused?.reason ?? null};
  });
  return claimId === undefined ? summaries : summaries.find(item => item.claimId === claimId) ?? null;
}

// The app/TaskStore remains single-process. An exclusive local directory also
// refuses another reviewer process for this storage. A crash leaves this lock
// for operator recovery only after confirming the old process has stopped;
// production requires database leases/outbox.
const owners = new Map();
export function createPhotoReviewQueue({store, provider, enabled = false, dailyAttemptLimit = 12, timeoutMs = 120000, pollMs = 1000, now = () => new Date()} = {}) {
  if (!store || !Number.isSafeInteger(dailyAttemptLimit) || dailyAttemptLimit < 1 || dailyAttemptLimit > 1000 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000 || !Number.isSafeInteger(pollMs) || pollMs < 1) fail('INVALID_REVIEW_QUEUE_CONFIG');
  const review = typeof provider === 'function' ? provider : provider?.review?.bind(provider);
  const owner = Symbol('photo-review-worker'), key = path.resolve(store.storage);
  const lockDirectory = path.join(key, '.photo-review-worker.lock'), lockToken = crypto.randomUUID();
  let lockHeld = false, releasing;
  let initialized = false, initializing, inflight, timer, stopped = false, controller, outstanding = false, providerPending, suspensions = 0, lastError = null;
  const date = () => stamp(now());

  async function acquireLock() {
    try {await fs.mkdir(lockDirectory, {mode: 0o700});}
    catch (error) {if (error.code === 'EEXIST') fail('PHOTO_REVIEW_WORKER_LOCKED'); throw error;}
    try {
      await fs.writeFile(path.join(lockDirectory, 'owner.json'), JSON.stringify({token: lockToken, pid: process.pid, createdAt: date()}) + '\n', {flag: 'wx', mode: 0o600});
      lockHeld = true;
    } catch (error) {await fs.rmdir(lockDirectory).catch(() => {}); throw error;}
  }
  function releaseLock() {
    if (releasing) return releasing;
    if (!lockHeld) return Promise.resolve();
    releasing = (async () => {
      const info = await fs.lstat(lockDirectory);
      if (info.isSymbolicLink() || !info.isDirectory()) fail('PHOTO_REVIEW_UNSAFE_LOCK');
      const filename = path.join(lockDirectory, 'owner.json');
      if ((await fs.lstat(filename)).isSymbolicLink()) fail('PHOTO_REVIEW_UNSAFE_LOCK');
      const record = JSON.parse(await fs.readFile(filename, 'utf8'));
      if (record.token !== lockToken) fail('PHOTO_REVIEW_LOCK_OWNERSHIP_CHANGED');
      await fs.unlink(filename); await fs.rmdir(lockDirectory); lockHeld = false;
      if (owners.get(key) === owner) owners.delete(key);
    })().finally(() => {releasing = null;});
    return releasing;
  }

  async function projects() {
    const found = [];
    for (const entry of await fs.readdir(store.storage, {withFileTypes: true})) {
      if (!uuid(entry.name)) continue;
      // Never traverse symlinks or accept an owner from the browser/session of
      // another tenant. Owner IDs are read only from protected local records.
      if (entry.isSymbolicLink() || !entry.isDirectory()) fail('PHOTO_REVIEW_UNSAFE_PROJECT');
      try {
        const directory = await store.directory(entry.name), filename = path.join(directory, 'workspace.json');
        const info = await fs.lstat(filename);
        if (info.isSymbolicLink() || !info.isFile()) fail('PHOTO_REVIEW_UNSAFE_PROJECT');
        const candidate = JSON.parse(await fs.readFile(filename, 'utf8'));
        if (candidate.id !== entry.name || !uuid(candidate.ownerId)) fail('PHOTO_REVIEW_UNSAFE_PROJECT');
        const session = {projectId: candidate.id, ownerId: candidate.ownerId};
        const record = await store.read(session.projectId, session.ownerId);
        found.push({session, record});
      } catch (error) {
        // TaskStore.create creates its UUID directory before atomically naming
        // workspace.json. That brief absence is not a malformed tenant record.
        // Invalid JSON, unsafe links and ownership mismatches still fail closed.
        if (error.code === 'ENOENT' || error.code === 'PROJECT_NOT_FOUND') continue;
        throw error;
      }
    }
    return found;
  }

  async function initialize() {
    if (initialized) return;
    if (initializing) return initializing;
    initializing = (async () => {
      if (owners.has(key) && owners.get(key) !== owner) fail('PHOTO_REVIEW_WORKER_ALREADY_ACTIVE');
      owners.set(key, owner);
      try {
        await acquireLock();
        for (const {session, record} of await projects()) {
          const recover = project => {
          for (const claim of Object.values(project.photoClaims ?? {})) if (reviewable(claim)) enqueuePhotoClaimReview(project, {claimId: claim.id, now: date()});
          for (const job of Object.values(project.photoReviewQueue?.jobs ?? {})) if (job.status === 'running') {
            job.status = job.savedResult ? 'result_ready' : 'paused';
            if (!job.savedResult) {job.reason = 'interrupted_attempt'; job.pausedAt = date();}
          }
          };
          // The installer holds the immutable customer source across restart.
          // Validate recovery on a detached record first; unchanged projects
          // need no write lease. Real recovery still uses the guarded transaction.
          const preview = structuredClone(record); recover(preview);
          if (canonicalJson(preview) !== canonicalJson(record)) await store.transact(session.projectId, session.ownerId, recover);
        }
        initialized = true;
      } catch (error) {await releaseLock().catch(() => {}); if (owners.get(key) === owner) owners.delete(key); throw error;}
    })();
    try {await initializing;} finally {initializing = null;}
  }

  async function update(session, id, operation) {
    return store.transact(session.projectId, session.ownerId, project => {
      const job = project.photoReviewQueue?.jobs?.[id];
      if (!job) fail('PHOTO_REVIEW_JOB_MISSING');
      return operation(job, project);
    });
  }
  async function pause(session, id, reason) {
    await update(session, id, job => {job.status = 'paused'; job.reason = reason; job.pausedAt = date();});
  }
  async function importSaved(session, job) {
    try {
      await importPhotoClaimReview(store, session, job.savedResult);
      await update(session, job.id, current => {current.status = 'completed'; current.completedAt = date(); delete current.reason;});
      return {processed: true, imported: true, claimId: job.claimId};
    } catch (error) {
      if (error.code === 'PHOTO_CLAIM_REVIEW_CLOSED') {
        // A customer escalation or trusted specialist decision can supersede
        // an in-flight second pass. Preserve its receipt but do not reopen the
        // claim, override the specialist, or issue another credit restoration.
        await update(session, job.id, current => {current.status = 'cancelled'; current.reason = 'claim_closed_or_changed'; current.cancelledAt = date();});
        return {processed: true, cancelled: true, reason: 'claim_closed_or_changed'};
      }
      await pause(session, job.id, 'invalid_or_stale_result');
      return {processed: true, paused: true, reason: 'invalid_or_stale_result'};
    }
  }
  async function one() {
    await initialize();
    if (stopped || suspensions || !enabled || !review || outstanding) return {processed: false, reason: stopped ? 'stopped' : suspensions ? 'suspended' : outstanding ? 'provider_busy' : 'provider_unavailable'};
    const current = date(), all = await projects();
    const attemptsToday = all.reduce((total, item) => total + Object.values(item.record.photoReviewQueue?.jobs ?? {}).filter(job => job.attemptStartedAt?.slice(0, 10) === current.slice(0, 10)).length, 0);
    // Persisted successful results are replayed before consuming any fresh quota.
    for (const {session, record} of all) {
      const saved = Object.values(record.photoReviewQueue?.jobs ?? {}).find(job => job.status === 'result_ready' && job.savedResult);
      if (saved) return importSaved(session, saved);
    }
    for (const {session, record} of all) {
      const jobs = Object.values(record.photoReviewQueue?.jobs ?? {}).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.passIndex - b.passIndex);
      for (const job of jobs) {
        if (job.status !== 'queued') continue;
        const claim = record.photoClaims?.[job.claimId];
        if (!reviewable(claim) || claim.evidenceHash !== job.evidenceHash) {
          await update(session, job.id, j => {j.status = 'cancelled'; j.reason = 'claim_closed_or_changed';});
          continue;
        }
        const previous = jobsFor(record, job.claimId).find(j => j.passIndex === job.passIndex - 1);
        if (previous && previous.status !== 'completed') continue;
        if (attemptsToday >= dailyAttemptLimit) {
          await update(session, job.id, j => {j.reason = 'daily_attempt_limit';});
          return {processed: false, reason: 'daily_attempt_limit'};
        }
        let prepared;
        try {prepared = await preparePhotoClaimReview(store, session, job.claimId);}
        catch (error) {await pause(session, job.id, 'invalid_evidence'); return {processed: true, paused: true, reason: 'invalid_evidence'};}
        if (stopped) return {processed: false, reason: 'stopped'};
        const started = await update(session, job.id, (j, project) => {
          const fresh = project.photoClaims?.[job.claimId];
          if (j.status !== 'queued' || j.attemptStartedAt || !reviewable(fresh) || fresh.evidenceHash !== job.evidenceHash || prepared.packet.evidenceHash !== j.evidenceHash) fail('PHOTO_REVIEW_JOB_STALE');
          j.status = 'running'; j.attemptStartedAt = current; j.packetHash = prepared.packetHash; delete j.reason;
          return structuredClone(j);
        });
        const active = started.result;
        if (stopped) {await pause(session, active.id, 'worker_stopped'); return {processed: true, paused: true, reason: 'worker_stopped'};}
        controller = new AbortController();
        const signal = controller.signal;
        let timeout, abortListener;
        const interrupted = new Promise((_, reject) => {
          abortListener = () => reject(Object.assign(new Error('review interrupted'), {code: signal.reason === 'timeout' ? 'PHOTO_REVIEW_TIMEOUT' : 'PHOTO_REVIEW_STOPPED'}));
          signal.addEventListener('abort', abortListener, {once: true});
          timeout = setTimeout(() => controller?.abort('timeout'), timeoutMs);
        });
        outstanding = true;
        const execution = providerPending = Promise.resolve().then(() => review({...prepared, reviewerId: active.reviewerId, runId: active.runId, signal}));
        const releaseProvider = () => {outstanding = false; providerPending = null;};
        execution.then(releaseProvider, releaseProvider);
        try {
          const result = await Promise.race([execution, interrupted]);
          if (signal.aborted) fail('PHOTO_REVIEW_STOPPED');
          if (!result || result.execution?.runId !== active.runId || result.execution?.route !== 'codex_cli_chatgpt') fail('PHOTO_REVIEW_RESULT_INVALID');
          const savedResult = {...prepared, reviewId: active.id, reviewerId: active.reviewerId, verdict: result.verdict, explanation: result.explanation, inspectedSha256: result.inspectedSha256, execution: result.execution};
          await update(session, active.id, j => {j.savedResult = structuredClone(savedResult); j.status = 'result_ready'; j.resultReadyAt = date();});
          return importSaved(session, {...active, savedResult});
        } catch (error) {
          const reason = error.code === 'PHOTO_REVIEW_TIMEOUT' ? 'timeout' : error.code === 'PHOTO_REVIEW_STOPPED' ? 'worker_stopped' : 'provider_failed';
          await pause(session, active.id, reason);
          return {processed: true, paused: true, reason};
        } finally {clearTimeout(timeout); signal.removeEventListener('abort', abortListener); controller = null;}
      }
    }
    return {processed: false, reason: 'idle'};
  }

  function tick() {
    if (suspensions) return Promise.resolve({processed:false,reason:'suspended'});
    if (inflight) return inflight;
    inflight = one().then(result => {lastError = null; return result;}).catch(error => {lastError = error.code ?? 'PHOTO_REVIEW_QUEUE_ERROR'; throw error;}).finally(() => {inflight = null;});
    return inflight;
  }
  async function waitForIdle() {
    while(initializing||inflight||providerPending)await Promise.allSettled([initializing,inflight,providerPending].filter(Boolean));
  }
  async function waitForCurrentWork() {
    // Initialization has no provider deadline: leave it to the bounded residual
    // drain. A suspension recheck after initialize prevents a late dispatch.
    if(!initializing&&inflight)await Promise.allSettled([inflight]);
  }
  return {
    async start() {
      if (stopped) return this.status();
      try {await initialize();}
      catch (error) {lastError = error.code ?? 'PHOTO_REVIEW_QUEUE_ERROR'; throw error;}
      lastError = null;
      if (stopped) return this.status();
      if (!timer) {timer = setInterval(() => {void tick().catch(() => {});}, pollMs); timer.unref?.();}
      void tick().catch(() => {});
      return this.status();
    },
    tick,
    suspend(){suspensions++;let released=false;return ()=>{if(!released){released=true;suspensions--;}};},
    waitForIdle,
    waitForCurrentWork,
    async drain({maxPasses = dailyAttemptLimit} = {}) {
      if (!Number.isSafeInteger(maxPasses) || maxPasses < 1 || maxPasses > 1000) fail('INVALID_REVIEW_QUEUE_CONFIG');
      const results = [];
      for (let i = 0; i < maxPasses; i++) {const result = await tick(); results.push(result); if (!result.processed) break;}
      return results;
    },
    async stop() {
      stopped = true; clearInterval(timer); timer = null; controller?.abort('stopped');
      await waitForIdle();
      // Do not let another local worker overlap an adapter that ignored abort.
      // Its unresolved invocation still owns the single provider slot.
      if (!outstanding) await releaseLock();
    },
    status() {return {enabled: Boolean(enabled && review), initialized, initializing:Boolean(initializing), running: Boolean(initializing || inflight || outstanding), outstanding:Boolean(outstanding), suspended:suspensions>0, stopped, lastError};},
  };
}
