import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {evaluateQualification, QUALIFICATION_FIELDS, SCOPE_VERSION} from './qualification.mjs';

export const WORKSPACE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const PRIVATE_ROOT = path.join(WORKSPACE_ROOT, 'briefs');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const inside = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
const exactKeys = (value, allowed) => object(value) && Object.keys(value).every(key => allowed.includes(key));
export class IntakeError extends Error {
  constructor(code, status = 400, details) {super(code); this.code = code; this.status = status; this.details = details;}
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function validateIntake(payload) {
  if (!exactKeys(payload, ['requestId', 'scopeVersion', 'qualification', 'contact', 'consent'])) throw new IntakeError('INVALID_REQUEST');
  if (typeof payload.requestId !== 'string' || !uuid.test(payload.requestId)) throw new IntakeError('INVALID_REQUEST_ID');
  if (payload.scopeVersion !== SCOPE_VERSION) throw new IntakeError('SCOPE_VERSION_STALE', 409);
  if (!exactKeys(payload.qualification, QUALIFICATION_FIELDS)) throw new IntakeError('INVALID_QUALIFICATION');
  const assessment = evaluateQualification(payload.qualification);
  if (assessment.status === 'incomplete') throw new IntakeError('QUALIFICATION_INCOMPLETE', 422, {missing: assessment.missing});
  if (Number.isInteger(payload.qualification.sellableSkuCount) && Number.isInteger(payload.qualification.productCount) && payload.qualification.sellableSkuCount < payload.qualification.productCount) throw new IntakeError('INVALID_SKU_COUNT', 422);
  if (!exactKeys(payload.contact, ['business', 'name', 'email'])) throw new IntakeError('INVALID_CONTACT');
  const contact = {};
  for (const [field, limit] of [['business', 120], ['name', 120], ['email', 254]]) {
    const value = payload.contact[field];
    if (typeof value !== 'string' || !value.trim() || value.length > limit || /[\x00-\x1f\x7f]/.test(value)) throw new IntakeError('INVALID_CONTACT');
    contact[field] = value.trim();
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email)) throw new IntakeError('INVALID_EMAIL');
  if (!exactKeys(payload.consent, ['serviceRequest']) || payload.consent.serviceRequest !== true) throw new IntakeError('SERVICE_REQUEST_REQUIRED');
  const clean = {
    requestId: payload.requestId.toLowerCase(), scopeVersion: SCOPE_VERSION,
    qualification: Object.fromEntries(QUALIFICATION_FIELDS.map(key => [key, payload.qualification[key]])),
    contact, consent: {serviceRequest: true},
  };
  return {clean, assessment};
}

async function rejectSymlinkAncestors(target, floor) {
  let current = target;
  while (inside(floor, current)) {
    try {if ((await fs.lstat(current)).isSymbolicLink()) throw new IntakeError('UNSAFE_STORAGE_PATH', 500);} catch (error) {if (error.code !== 'ENOENT') throw error;}
    if (current === floor) break;
    current = path.dirname(current);
  }
}

export async function prepareStorage(storage) {
  const target = path.resolve(storage);
  if (!inside(PRIVATE_ROOT, target)) throw new IntakeError('STORAGE_OUTSIDE_PRIVATE_ROOT', 500);
  await rejectSymlinkAncestors(target, PRIVATE_ROOT);
  await fs.mkdir(target, {recursive: true, mode: 0o700});
  const realRoot = await fs.realpath(PRIVATE_ROOT);
  const realTarget = await fs.realpath(target);
  if (!inside(realRoot, realTarget)) throw new IntakeError('UNSAFE_STORAGE_PATH', 500);
  return realTarget;
}

function receipt(record) {
  return {
    requestId: record.payload.requestId, status: 'received_local', assessment: record.assessment,
    nextStep: record.assessment.status === 'review' ? 'review_before_quote' : record.assessment.gates.some(g => ['catalog_ready', 'brand_assets_ready'].includes(g.code) && g.status === 'pending') ? 'complete_materials_and_brief' : 'complete_brief_before_quote',
  };
}

async function readExisting(recordPath) {
  // Another request can arrive while the exclusive owner is syncing the receipt.
  for (let attempt = 0; attempt < 40; attempt++) {
    try {return JSON.parse(await fs.readFile(recordPath, 'utf8'));}
    catch (error) {
      if (error.code !== 'ENOENT') throw new IntakeError('STORAGE_RECORD_INVALID', 500);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  throw new IntakeError('SUBMISSION_RECONCILIATION_REQUIRED', 503);
}

export async function saveIntake(storage, payload) {
  const {clean, assessment} = validateIntake(payload);
  const hash = createHash('sha256').update(canonicalJson(clean)).digest('hex');
  const dir = path.join(storage, clean.requestId);
  const recordPath = path.join(dir, 'record.json');
  try {await fs.mkdir(dir, {mode: 0o700});}
  catch (error) {
    if (error.code !== 'EEXIST') throw new IntakeError('STORAGE_UNAVAILABLE', 503);
    if ((await fs.lstat(dir)).isSymbolicLink()) throw new IntakeError('UNSAFE_STORAGE_PATH', 500);
    const existing = await readExisting(recordPath);
    if (existing.payloadHash !== hash) throw new IntakeError('IDEMPOTENCY_CONFLICT', 409);
    return {httpStatus: 200, body: receipt(existing)};
  }
  const record = {
    serviceSchemaVersion: '1.0', createdAt: new Date().toISOString(), payloadHash: hash,
    payload: clean, assessment, state: 'received_local', stateVersion: 1,
    notifications: {emailConfirmation: 'not_configured'},
  };
  try {
    const temp = path.join(dir, 'record.pending');
    const handle = await fs.open(temp, 'wx', 0o600);
    try {await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, 'utf8'); await handle.sync();}
    finally {await handle.close();}
    await fs.rename(temp, recordPath);
    // fsync directories where supported. Windows fs.open(directory) is not available.
    if (process.platform !== 'win32') {
      const directory = await fs.open(dir, 'r');
      try {await directory.sync();} finally {await directory.close();}
    }
    return {httpStatus: 201, body: receipt(record)};
  } catch {throw new IntakeError('STORAGE_UNAVAILABLE', 503);}
}
