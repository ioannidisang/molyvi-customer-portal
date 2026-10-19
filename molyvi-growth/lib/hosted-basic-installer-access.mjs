import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

// Operator-only token provisioning. No HTTP route, OAuth, network, logging,
// automatic refresh, credential adoption, or arbitrary storage-root option.
const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const privateRoot = path.join(workspace, 'briefs');
export const HOSTED_BASIC_INSTALLER_ACCESS_ROOT = path.join(privateRoot, 'molyvi-basic-installer-access');
export const HOSTED_BASIC_INSTALLER_IDENTITY = Object.freeze({
  serviceId: 'srv-db7othjrjlhs73cg7lf0', targetStore: 'molyvi-still-dev.myshopify.com',
  shopId: '108668748113', appId: '436878311425', installId: '1195450433873', liveThemeId: '207379235153',
});
export const HOSTED_BASIC_INSTALLER_ACCESS_LIMITS = Object.freeze({
  receiverLifetimeMs: 600_000, admissionTokenRemainingMs: 1_200_000,
  readTokenRemainingMs: 120_000, maximumTokenLifetimeMs: 86_400_000,
  maximumTokenBytes: 8192, maximumEnvelopeBytes: 16_384,
});
const identity = HOSTED_BASIC_INSTALLER_IDENTITY, limits = HOSTED_BASIC_INSTALLER_ACCESS_LIMITS;
const algorithm = 'RSA-OAEP-SHA256+A256GCM';
const requiredScopes = ['read_inventory', 'read_locations', 'read_publications', 'write_files', 'write_online_store_pages', 'write_products', 'write_themes'];
const allowedScopes = [...requiredScopes, 'read_themes', 'read_products', 'read_files', 'read_online_store_pages'];
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const generateKeyPair = promisify(crypto.generateKeyPair);
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
  : value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}' : JSON.stringify(value);
const fail = code => { const error = new Error('HOSTED_INSTALLER_ACCESS_' + code); error.code = error.message; throw error; };
const need = (condition, code) => { if (!condition) fail(code); };
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const samePath = (a, b) => process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
const time = clock => { need(typeof clock === 'function', 'CLOCK_INVALID'); const now = clock(); need(Number.isSafeInteger(now) && now > 0, 'CLOCK_INVALID'); return now; };
function isoTime(value) { const parsed = Date.parse(value); need(typeof value === 'string' && Number.isFinite(parsed) && new Date(parsed).toISOString() === value, 'TIME_INVALID'); return parsed; }
const serviceGuard = () => need(process.env.RENDER_SERVICE_ID === identity.serviceId, 'SERVICE_MISMATCH');
async function guarded(callback) { try { return await callback(); } catch (error) { if (typeof error?.code === 'string' && error.code.startsWith('HOSTED_INSTALLER_ACCESS_')) throw error; fail('OPERATION_STOPPED'); } }

function bindingFor(runId, packageSha256) {
  need(typeof runId === 'string' && uuid.test(runId), 'RUN_INVALID');
  need(typeof packageSha256 === 'string' && hashPattern.test(packageSha256), 'PACKAGE_INVALID');
  return { ...identity, runId, packageSha256 };
}
function directoryFor(runId) { need(typeof runId === 'string' && uuid.test(runId), 'RUN_INVALID'); return path.join(HOSTED_BASIC_INSTALLER_ACCESS_ROOT, runId); }
function privateMode(stat, directory = false) {
  need(directory ? stat.isDirectory() : stat.isFile(), 'PATH_INVALID');
  need(!stat.isSymbolicLink(), 'PATH_INVALID');
  if (!directory) need(stat.nlink === 1, 'HARDLINK_REJECTED');
  if (process.platform !== 'win32') {
    need((stat.mode & 0o777) === (directory ? 0o700 : 0o600), 'PERMISSIONS_INVALID');
    need(stat.uid === process.getuid(), 'OWNER_INVALID');
  }
}
async function ordinaryPath(target, directory = false, privatePermissions = true) {
  let current = path.parse(target).root;
  const parts = target.slice(current.length).split(path.sep).filter(Boolean);
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]); const stat = await fs.lstat(current);
    need(!stat.isSymbolicLink() && (index < parts.length - 1 || directory ? stat.isDirectory() : stat.isFile()), 'PATH_INVALID');
    need(samePath(await fs.realpath(current), current), 'PATH_INVALID');
    if (samePath(current, HOSTED_BASIC_INSTALLER_ACCESS_ROOT) || current.startsWith(HOSTED_BASIC_INSTALLER_ACCESS_ROOT + path.sep)) {
      if (index < parts.length - 1 || privatePermissions) privateMode(stat, index < parts.length - 1 || directory);
    }
  }
}
async function readPrivate(file, maximum = 16_384) {
  await ordinaryPath(file);
  const initial = await fs.lstat(file);
  privateMode(initial); need(initial.size > 0 && initial.size <= maximum, 'FILE_SIZE_INVALID');
  const handle = await fs.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat(); privateMode(before);
    need(before.dev === initial.dev && before.ino === initial.ino && before.size === initial.size, 'FILE_CHANGED');
    const bytes = await handle.readFile(), after = await handle.stat(), final = await fs.lstat(file);
    privateMode(final);
    need(bytes.length === before.size && after.size === before.size && after.mtimeMs === before.mtimeMs && final.dev === before.dev && final.ino === before.ino && final.size === before.size && final.mtimeMs === before.mtimeMs, 'FILE_CHANGED');
    return bytes;
  } finally { await handle.close(); }
}
async function newPrivate(file, bytes) {
  await ordinaryPath(path.dirname(file), true);
  const handle = await fs.open(file, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); privateMode(await handle.stat()); } finally { await handle.close(); }
  if (process.platform !== 'win32') { const parent = await fs.open(path.dirname(file), 'r'); try { await parent.sync(); } finally { await parent.close(); } }
}
const jsonBytes = value => Buffer.from(canonical(value) + '\n');
const readJson = async (file, maximum) => JSON.parse((await readPrivate(file, maximum)).toString('utf8'));
function publicKeyInfo(pem) {
  need(typeof pem === 'string' && pem.length < 2048, 'PUBLIC_KEY_INVALID');
  const key = crypto.createPublicKey(pem);
  need(key.asymmetricKeyType === 'rsa' && key.asymmetricKeyDetails?.modulusLength === 3072 && key.asymmetricKeyDetails?.publicExponent === 65537n, 'PUBLIC_KEY_INVALID');
  const normalized = key.export({ type: 'spki', format: 'pem' }).toString(); need(normalized === pem, 'PUBLIC_KEY_INVALID');
  return { key, fingerprint: sha(key.export({ type: 'spki', format: 'der' })) };
}
function receiverRecord(receiver, now, allowExpired = false) {
  need(exactKeys(receiver, ['schemaVersion', 'kind', 'algorithm', 'binding', 'nonce', 'createdAt', 'deadlineAt', 'publicKeyPem', 'publicKeySha256', 'receiverSha256']), 'RECEIVER_INVALID');
  need(receiver.schemaVersion === 1 && receiver.kind === 'molyvi_basic_installer_receiver_v1' && receiver.algorithm === algorithm, 'RECEIVER_INVALID');
  need(exactKeys(receiver.binding, [...Object.keys(identity), 'runId', 'packageSha256']), 'BINDING_INVALID');
  need(canonical(receiver.binding) === canonical(bindingFor(receiver.binding.runId, receiver.binding.packageSha256)), 'BINDING_MISMATCH');
  need(hashPattern.test(receiver.nonce) && hashPattern.test(receiver.publicKeySha256) && hashPattern.test(receiver.receiverSha256), 'RECEIVER_INVALID');
  need(typeof receiver.publicKeyPem === 'string' && receiver.publicKeyPem.length < 2048, 'PUBLIC_KEY_INVALID');
  const created = isoTime(receiver.createdAt), deadline = isoTime(receiver.deadlineAt);
  need(deadline - created === limits.receiverLifetimeMs && now >= created && (allowExpired || now < deadline), 'RECEIVER_EXPIRED_OR_CLOCK_ROLLBACK');
  const { receiverSha256, ...body } = receiver;
  need(sha(canonical(body)) === receiverSha256, 'RECEIVER_HASH_MISMATCH');
  const publicKey = publicKeyInfo(receiver.publicKeyPem); need(publicKey.fingerprint === receiver.publicKeySha256, 'PUBLIC_KEY_MISMATCH');
  return publicKey.key;
}
function tokenRecord(token, now, remaining = limits.admissionTokenRemainingMs) {
  need(exactKeys(token, ['kind', 'targetStore', 'appId', 'accessToken', 'issuedAt', 'expiresAt', 'scopes', 'authorizationSha256']), 'TOKEN_INVALID');
  need(token.kind === 'molyvi_shopify_basic_installer_credential' && token.targetStore === identity.targetStore && token.appId === identity.appId, 'TOKEN_BINDING_MISMATCH');
  need(typeof token.accessToken === 'string' && /^[\x21-\x7e]{16,2048}$/.test(token.accessToken) && hashPattern.test(token.authorizationSha256), 'TOKEN_INVALID');
  const issued = isoTime(token.issuedAt), expires = isoTime(token.expiresAt);
  need(issued <= now && expires > issued && expires - issued <= limits.maximumTokenLifetimeMs && expires - now >= remaining, 'TOKEN_EXPIRED_OR_CLOCK_INVALID');
  need(Array.isArray(token.scopes) && token.scopes.length <= allowedScopes.length && new Set(token.scopes).size === token.scopes.length
    && requiredScopes.every(scope => token.scopes.includes(scope)) && token.scopes.every(scope => allowedScopes.includes(scope)), 'TOKEN_SCOPES_MISMATCH');
  need(jsonBytes(token).length <= limits.maximumTokenBytes, 'TOKEN_SIZE_INVALID');
  return { ...token, scopes: [...token.scopes].sort() };
}
function aad(receiver) { return Buffer.from(canonical({ binding: receiver.binding, receiverSha256: receiver.receiverSha256, nonce: receiver.nonce, createdAt: receiver.createdAt, deadlineAt: receiver.deadlineAt })); }
function fromBase64(value, maximum, exact) {
  need(typeof value === 'string' && value.length > 0 && value.length <= Math.ceil(maximum / 3) * 4 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value), 'ENVELOPE_ENCODING_INVALID');
  const bytes = Buffer.from(value, 'base64');
  need(bytes.toString('base64') === value && bytes.length <= maximum && (exact === undefined || bytes.length === exact), 'ENVELOPE_ENCODING_INVALID');
  return bytes;
}
function envelopeParts(envelope, receiverSha256) {
  need(exactKeys(envelope, ['schemaVersion', 'kind', 'algorithm', 'receiverSha256', 'wrappedKey', 'iv', 'ciphertext', 'tag']), 'ENVELOPE_INVALID');
  need(envelope.schemaVersion === 1 && envelope.kind === 'molyvi_basic_installer_token_envelope_v1' && envelope.algorithm === algorithm && envelope.receiverSha256 === receiverSha256, 'ENVELOPE_BINDING_MISMATCH');
  need(['wrappedKey', 'iv', 'ciphertext', 'tag'].every(key => typeof envelope[key] === 'string' && envelope[key].length <= limits.maximumEnvelopeBytes), 'ENVELOPE_SIZE_INVALID');
  need(jsonBytes(envelope).length <= limits.maximumEnvelopeBytes, 'ENVELOPE_SIZE_INVALID');
  return { wrappedKey: fromBase64(envelope.wrappedKey, 384, 384), iv: fromBase64(envelope.iv, 12, 12), ciphertext: fromBase64(envelope.ciphertext, limits.maximumTokenBytes), tag: fromBase64(envelope.tag, 16, 16) };
}
async function loadReceiver({ runId, packageSha256, receiverSha256 }, now, allowExpired = false) {
  const directory = directoryFor(runId); await ordinaryPath(directory, true);
  const receiver = await readJson(path.join(directory, 'receiver.json'));
  receiverRecord(receiver, now, allowExpired);
  need(canonical(receiver.binding) === canonical(bindingFor(runId, packageSha256)) && receiver.receiverSha256 === receiverSha256, 'BINDING_MISMATCH');
  return { directory, receiver };
}

export async function createReceiver({ runId, packageSha256, clock = Date.now } = {}) {
  return guarded(async () => {
    serviceGuard(); const now = time(clock), binding = bindingFor(runId, packageSha256);
    await ordinaryPath(privateRoot, true, false);
    try { await fs.mkdir(HOSTED_BASIC_INSTALLER_ACCESS_ROOT, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    await ordinaryPath(HOSTED_BASIC_INSTALLER_ACCESS_ROOT, true);
    const directory = directoryFor(runId);
    try { await fs.mkdir(directory, { mode: 0o700 }); } catch (error) { if (error.code === 'EEXIST') fail('RECEIVER_ALREADY_EXISTS'); throw error; }
    await ordinaryPath(directory, true);
    const { publicKey, privateKey } = await generateKeyPair('rsa', { modulusLength: 3072, publicExponent: 0x10001 });
    const body = { schemaVersion: 1, kind: 'molyvi_basic_installer_receiver_v1', algorithm, binding,
      nonce: crypto.randomBytes(32).toString('hex'), createdAt: new Date(now).toISOString(), deadlineAt: new Date(now + limits.receiverLifetimeMs).toISOString(),
      publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(), publicKeySha256: sha(publicKey.export({ type: 'spki', format: 'der' })) };
    const receiver = { ...body, receiverSha256: sha(canonical(body)) };
    const privateBytes = Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' }));
    try { await newPrivate(path.join(directory, 'private-key.pem'), privateBytes); } finally { privateBytes.fill(0); }
    await newPrivate(path.join(directory, 'receiver.json'), jsonBytes(receiver));
    return receiver; // Public key and fixed metadata only; safe for operator transfer.
  });
}

export async function encryptEnvelope({ receiver, token, clock = Date.now } = {}) {
  return guarded(async () => {
    const now = time(clock), publicKey = receiverRecord(receiver, now), validToken = tokenRecord(token, now);
    const key = crypto.randomBytes(32), iv = crypto.randomBytes(12), plaintext = jsonBytes(validToken);
    try {
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(aad(receiver));
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const wrappedKey = crypto.publicEncrypt({ key: publicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256', oaepLabel: Buffer.from(receiver.receiverSha256, 'hex') }, key);
      return { schemaVersion: 1, kind: 'molyvi_basic_installer_token_envelope_v1', algorithm, receiverSha256: receiver.receiverSha256,
        wrappedKey: wrappedKey.toString('base64'), iv: iv.toString('base64'), ciphertext: ciphertext.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
    } finally { key.fill(0); plaintext.fill(0); }
  });
}

export async function acceptEnvelope({ runId, packageSha256, receiverSha256, envelope, clock = Date.now } = {}) {
  return guarded(async () => {
    serviceGuard(); const now = time(clock), { directory, receiver } = await loadReceiver({ runId, packageSha256, receiverSha256 }, now);
    const parts = envelopeParts(envelope, receiverSha256), envelopeSha256 = sha(canonical(envelope));
    try { await newPrivate(path.join(directory, 'accept-attempt.json'), jsonBytes({ schemaVersion: 1, receiverSha256, envelopeSha256, attemptedAt: new Date(now).toISOString() })); }
    catch (error) { if (error.code === 'EEXIST') fail('ACCEPT_ALREADY_ATTEMPTED'); throw error; }
    let key, plaintext, privateBytes;
    try {
      privateBytes = await readPrivate(path.join(directory, 'private-key.pem'), 8192);
      const privateKey = crypto.createPrivateKey(privateBytes);
      need(sha(crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' })) === receiver.publicKeySha256, 'PRIVATE_KEY_MISMATCH');
      key = crypto.privateDecrypt({ key: privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256', oaepLabel: Buffer.from(receiverSha256, 'hex') }, parts.wrappedKey);
      need(key.length === 32, 'ENVELOPE_KEY_INVALID');
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, parts.iv); decipher.setAAD(aad(receiver)); decipher.setAuthTag(parts.tag);
      plaintext = Buffer.concat([decipher.update(parts.ciphertext), decipher.final()]);
      need(plaintext.length <= limits.maximumTokenBytes, 'TOKEN_SIZE_INVALID');
      const acceptedNow = time(clock); need(acceptedNow >= now, 'CLOCK_ROLLBACK'); receiverRecord(receiver, acceptedNow);
      const token = tokenRecord(JSON.parse(plaintext.toString('utf8')), acceptedNow);
      const tokenBytes = jsonBytes(token);
      try {
        await newPrivate(path.join(directory, 'credential.json'), tokenBytes);
        const accepted = { schemaVersion: 1, status: 'TOKEN_ACCEPTED_PRIVATELY', binding: receiver.binding, receiverSha256, envelopeSha256,
          acceptedAt: new Date(acceptedNow).toISOString(), tokenExpiresAt: token.expiresAt, tokenSha256: sha(tokenBytes) };
        await newPrivate(path.join(directory, 'accepted.json'), jsonBytes(accepted));
        return { status: accepted.status, binding: accepted.binding, receiverSha256, envelopeSha256, acceptedAt: accepted.acceptedAt,
          tokenExpiresAt: accepted.tokenExpiresAt, scopes: token.scopes, credentialsReturned: false, appSecretTransferred: false, oauthRequests: 0 };
      } finally { tokenBytes.fill(0); }
    } finally { key?.fill(0); plaintext?.fill(0); privateBytes?.fill(0); }
  });
}

// SECRET return value: only an in-process adapter/captured pipe may consume it.
// Never print/serialize this result into logs, terminal commands or evidence.
export async function readExactToken({ runId, packageSha256, receiverSha256, clock = Date.now } = {}) {
  return guarded(async () => {
    serviceGuard(); const now = time(clock), { directory, receiver } = await loadReceiver({ runId, packageSha256, receiverSha256 }, now, true);
    const attempt = await readJson(path.join(directory, 'accept-attempt.json'), 2048);
    const accepted = await readJson(path.join(directory, 'accepted.json'), 4096);
    need(exactKeys(attempt, ['schemaVersion', 'receiverSha256', 'envelopeSha256', 'attemptedAt']) && attempt.schemaVersion === 1 && attempt.receiverSha256 === receiverSha256 && hashPattern.test(attempt.envelopeSha256), 'ACCEPTANCE_INVALID');
    need(exactKeys(accepted, ['schemaVersion', 'status', 'binding', 'receiverSha256', 'envelopeSha256', 'acceptedAt', 'tokenExpiresAt', 'tokenSha256'])
      && accepted.schemaVersion === 1 && accepted.status === 'TOKEN_ACCEPTED_PRIVATELY' && accepted.receiverSha256 === receiverSha256
      && accepted.envelopeSha256 === attempt.envelopeSha256 && canonical(accepted.binding) === canonical(receiver.binding) && hashPattern.test(accepted.tokenSha256), 'ACCEPTANCE_INVALID');
    const acceptedAt = isoTime(accepted.acceptedAt), attemptedAt = isoTime(attempt.attemptedAt);
    need(attemptedAt <= acceptedAt && attemptedAt >= isoTime(receiver.createdAt) && acceptedAt < isoTime(receiver.deadlineAt) && now >= acceptedAt, 'ACCEPTANCE_TIME_INVALID');
    const bytes = await readPrivate(path.join(directory, 'credential.json'), limits.maximumTokenBytes);
    try {
      need(sha(bytes) === accepted.tokenSha256, 'TOKEN_FILE_CHANGED');
      const readNow = time(clock); need(readNow >= now, 'CLOCK_ROLLBACK');
      const token = tokenRecord(JSON.parse(bytes.toString('utf8')), readNow, limits.readTokenRemainingMs);
      need(token.expiresAt === accepted.tokenExpiresAt, 'TOKEN_EXPIRY_MISMATCH');
      return token;
    } finally { bytes.fill(0); }
  });
}
