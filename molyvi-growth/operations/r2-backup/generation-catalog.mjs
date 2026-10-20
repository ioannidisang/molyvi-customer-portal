import fs from 'node:fs/promises';
import {lstatSync, readFileSync} from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {generationEvidenceHash as hash} from './generation-retention.mjs';
import {RETENTION_POLICY} from './retention.mjs';

// Private, trusted-operator catalog. No provider operations, recovery, retries,
// remote authenticity claims, or production activation are implemented here.
const check = (value, code) => { if (!value) throw Error(code); };
const SHA = /^[a-f0-9]{64}$/, MAX_DESCRIPTOR = 16 * 1024 * 1024;
const json = value => JSON.stringify(value);
const clone = value => JSON.parse(json(value));
const equal = (a, b) => hash(a) === hash(b);
const int = (v, code, min = 0, max = Number.MAX_SAFE_INTEGER) => {
  check(Number.isSafeInteger(v) && v >= min && v <= max, code); return v;
};
const sha = v => check(typeof v === 'string' && SHA.test(v), 'GENERATION_CATALOG_HASH');
const id = v => check(typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(v), 'GENERATION_CATALOG_ID');
function exact(value, fields, code = 'GENERATION_CATALOG_FIELDS') {
  check(value && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).sort().join(',') === [...fields].sort().join(','), code);
}
function iso(v) {
  check(typeof v === 'string' && Number.isFinite(Date.parse(v))
    && new Date(v).toISOString() === v, 'GENERATION_CATALOG_TIME'); return v;
}
function key(v) {
  check(typeof v === 'string' && v.length <= 1024 && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(v)
    && v.split('/').every(p => p && p !== '.' && p !== '..'), 'GENERATION_CATALOG_KEY'); return v;
}
function scope(v) {
  exact(v, ['serviceId', 'workspaceId']); id(v.serviceId); id(v.workspaceId); return clone(v);
}
function bounded(value, limit = 2 * 1024 * 1024) {
  const raw = json(value); check(typeof raw === 'string' && Buffer.byteLength(raw) <= limit, 'GENERATION_CATALOG_METADATA_LIMIT');
  return raw;
}
function object(v, expectedScope) {
  const fields = ['key', 'bytes', 'sha256', 'kind', 'etag'];
  exact(v, v.kind === 'legacy' ? fields : [...fields, 'descriptor']);
  key(v.key); int(v.bytes, 'GENERATION_CATALOG_BYTES', 44, 512_000_000); sha(v.sha256);
  check(['base', 'overlay', 'legacy'].includes(v.kind), 'GENERATION_CATALOG_OBJECT_KIND');
  check(typeof v.etag === 'string' && v.etag.length > 0 && v.etag.length <= 200
    && !/[\x00-\x1f\x7f]/.test(v.etag), 'GENERATION_CATALOG_ETAG');
  if (v.kind !== 'legacy') descriptor(v.descriptor, v.kind, expectedScope, v);
  return clone(v);
}
function descriptor(d, kind, expectedScope, record) {
  const fields = ['schemaVersion', 'format', 'kind', 'scope', 'manifest', 'manifestHash',
    'cipherHash', 'cipherBytes', 'logicalBytes'];
  exact(d, kind === 'base' ? fields : [...fields, 'base', 'changedFiles', 'deletedPaths']);
  check(d.schemaVersion === 1 && d.format === 'MOLYVI-GENERATION-1'
    && d.kind === (kind === 'base' ? 'base' : 'generation'), 'GENERATION_CATALOG_DESCRIPTOR');
  check(equal(scope(d.scope), expectedScope), 'GENERATION_CATALOG_SCOPE');
  sha(d.manifestHash); sha(d.cipherHash);
  check(d.cipherHash === record.sha256 && d.cipherBytes === record.bytes, 'GENERATION_CATALOG_DESCRIPTOR_OBJECT');
  check(d.manifest && d.manifest.schemaVersion === 1 && d.manifest.kind === 'molyvi_private_service_snapshot'
    && /^[a-f0-9]{40}$/.test(d.manifest.release) && d.manifest.database?.integrity === 'ok'
    && Array.isArray(d.manifest.files) && d.manifest.files.length > 0
    && d.manifest.files.length <= 100000, 'GENERATION_CATALOG_MANIFEST');
  check(crypto.createHash('sha256').update(json(d.manifest)).digest('hex') === d.manifestHash,
    'GENERATION_CATALOG_MANIFEST_HASH');
  let total = 0, previous = '';
  const names = new Set();
  for (const file of d.manifest.files) {
    exact(file, ['file', 'bytes', 'sha256']); key(file.file); sha(file.sha256);
    int(file.bytes, 'GENERATION_CATALOG_FILE_BYTES'); total += file.bytes;
    check(Number.isSafeInteger(total) && file.file > previous && !names.has(file.file.toLowerCase()),
      'GENERATION_CATALOG_MANIFEST_ORDER');
    names.add(file.file.toLowerCase()); previous = file.file;
  }
  check(names.has('accounts/customers.sqlite') && total === d.logicalBytes
    && total + 12 * 1024 * 1024 <= 512_000_000, 'GENERATION_CATALOG_LOGICAL_BYTES');
  bounded(d, MAX_DESCRIPTOR);
}
function generation(v) {
  check(v?.kind === 'base-overlay' || v?.kind === 'legacy', 'GENERATION_CATALOG_GENERATION');
  exact(v, v.kind === 'legacy' ? ['id', 'verifiedAt', 'kind', 'objectKey']
    : ['id', 'verifiedAt', 'kind', 'baseKey', 'overlayKey']);
  id(v.id); iso(v.verifiedAt);
  for (const k of dependencies(v)) key(k);
  return clone(v);
}
const dependencies = v => v.kind === 'legacy' ? [v.objectKey] : [v.baseKey, v.overlayKey];
const anchor = v => v.kind === 'legacy' ? v.objectKey : v.overlayKey;
function selection(rows, newest) {
  const ordered = [...rows].sort((a, b) => Date.parse(b.verifiedAt) - Date.parse(a.verifiedAt)
    || anchor(b).localeCompare(anchor(a)));
  check(ordered[0]?.id === newest, 'GENERATION_CATALOG_NEWEST');
  const weekly = ordered.slice(0, 4).map(r => r.id), monthly = [], months = new Set();
  for (const r of ordered) {
    const month = r.verifiedAt.slice(0, 7); if (months.has(month)) continue;
    months.add(month); monthly.push(r.id); if (monthly.length === 3) break;
  }
  const keep = [...new Set([...weekly, ...monthly])], kept = new Set(keep);
  return {weekly, monthly, keep, retire: ordered.filter(r => !kept.has(r.id)).map(r => r.id)};
}
function sortedKeys(values) {
  check(Array.isArray(values) && values.every(v => typeof v === 'string')
    && new Set(values).size === values.length, 'GENERATION_CATALOG_DUPLICATE');
  return [...values].sort();
}
function rawInventory(raw) {
  check(Array.isArray(raw) && raw.length <= 20, 'GENERATION_CATALOG_INVENTORY');
  const keys = new Set(); let bytes = 0;
  for (const row of raw) {
    exact(row, ['Key', 'Size', 'ETag']); key(row.Key); int(row.Size, 'GENERATION_CATALOG_INVENTORY');
    check(typeof row.ETag === 'string' && row.ETag.length > 0 && row.ETag.length <= 200
      && !keys.has(row.Key), 'GENERATION_CATALOG_INVENTORY');
    keys.add(row.Key); bytes += row.Size;
  }
  check(bytes <= 2_000_000_000, 'GENERATION_CATALOG_STORAGE');
  return [...raw].sort((a, b) => a.Key.localeCompare(b.Key));
}
function plannerInventory(inventory) {
  exact(inventory, ['complete', 'capturedAt', 'objects']); iso(inventory.capturedAt);
  check(inventory.complete === true && Array.isArray(inventory.objects), 'GENERATION_CATALOG_INVENTORY');
  const raw = inventory.objects.map(r => {
    exact(r, ['key', 'bytes', 'sha256', 'etag']);
    if (r.sha256 !== null) sha(r.sha256);
    return {Key: r.key, Size: r.bytes, ETag: r.etag};
  });
  rawInventory(raw); return rawInventory(raw);
}
async function parents(dir) {
  const absolute = path.resolve(dir), parsed = path.parse(absolute); let at = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    at = path.join(at, part);
    try { const s = await fs.lstat(at); check(s.isDirectory() && !s.isSymbolicLink(), 'GENERATION_CATALOG_PARENT'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; await fs.mkdir(at, {mode: 0o700}); }
  }
  check((await fs.realpath(absolute)).toLowerCase() === absolute.toLowerCase(), 'GENERATION_CATALOG_ALIAS');
}
async function exists(file) {
  try { const s = await fs.lstat(file); check(s.isFile() && !s.isSymbolicLink() && s.nlink === 1, 'GENERATION_CATALOG_UNSAFE_FILE'); return s; }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export class GenerationCatalog {
  constructor(file, {scope: value} = {}) {
    this.file = path.resolve(file); this.marker = `${this.file}.initialized.json`;
    Object.defineProperty(this, 'scope', {value: Object.freeze(scope(value)), enumerable: true});
    this.db = null; this.owned = new Set();
  }
  async ready() {
    check(!this.db, 'GENERATION_CATALOG_ALREADY_OPEN');
    await parents(path.dirname(this.file));
    const file = await exists(this.file), marker = await exists(this.marker);
    check(Boolean(file) === Boolean(marker), 'GENERATION_CATALOG_BOOTSTRAP_INCOMPLETE');
    let bootstrap;
    if (!file) {
      bootstrap = {schemaVersion: 1, scope: this.scope, database: this.file, epoch: crypto.randomUUID()};
      const handle = await fs.open(this.marker, 'wx', 0o600);
      try { await handle.writeFile(json(bootstrap)); await handle.sync(); } finally { await handle.close(); }
    } else {
      check(marker.size <= 4096, 'GENERATION_CATALOG_MARKER');
      bootstrap = JSON.parse(await fs.readFile(this.marker, 'utf8'));
      exact(bootstrap, ['schemaVersion', 'scope', 'database', 'epoch']);
      check(bootstrap.schemaVersion === 1 && bootstrap.database === this.file
        && equal(bootstrap.scope, this.scope) && /^[a-f0-9-]{36}$/.test(bootstrap.epoch), 'GENERATION_CATALOG_SCOPE');
    }
    this.markerRaw = await fs.readFile(this.marker);
    this.db = new DatabaseSync(this.file);
    try {
      await fs.chmod(this.file, 0o600);
      this.db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
      const pageSize = this.db.prepare('PRAGMA page_size').get().page_size;
      this.db.exec(`PRAGMA max_page_count=${Math.floor(64 * 1024 * 1024 / pageSize)}`);
      if (!file) {
        this.db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
          CREATE TABLE objects(key TEXT PRIMARY KEY,value TEXT NOT NULL,status TEXT NOT NULL);
          CREATE TABLE generations(id TEXT PRIMARY KEY,value TEXT NOT NULL,status TEXT NOT NULL,run_id TEXT);
          CREATE TABLE runs(id TEXT PRIMARY KEY,value TEXT NOT NULL,status TEXT NOT NULL,proof TEXT,proof_hash TEXT,base TEXT,plan TEXT,plan_hash TEXT,receipt TEXT,plan_operation_seq INTEGER);
          CREATE TABLE operations(seq INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT NOT NULL,id TEXT NOT NULL,intent TEXT NOT NULL,status TEXT NOT NULL,result TEXT,UNIQUE(run_id,id));
          CREATE TABLE reservations(id INTEGER PRIMARY KEY,run_id TEXT NOT NULL,operation_id TEXT,delete_key TEXT,value TEXT NOT NULL);
          CREATE TABLE deletions(run_id TEXT NOT NULL,key TEXT NOT NULL,value TEXT NOT NULL,status TEXT NOT NULL,receipt TEXT,operation_seq INTEGER,PRIMARY KEY(run_id,key));
          COMMIT;`);
        this.db.exec('BEGIN IMMEDIATE');
        try {
          this.db.prepare('INSERT INTO meta VALUES(?,?)').run('bootstrap', json(bootstrap));
          this.db.prepare('INSERT INTO meta VALUES(?,?)').run('legacy_imported', 'false');
          this.db.prepare('INSERT INTO meta VALUES(?,?)').run('active_base', 'null');
          this.db.exec('COMMIT');
        } catch (error) { this.db.exec('ROLLBACK'); throw error; }
      }
      check(this.db.prepare('PRAGMA integrity_check').get().integrity_check === 'ok', 'GENERATION_CATALOG_INTEGRITY');
      check(equal(JSON.parse(this.db.prepare("SELECT value FROM meta WHERE key='bootstrap'").get()?.value ?? 'null'), bootstrap),
        'GENERATION_CATALOG_BOOTSTRAP_INCOMPLETE');
      check(['true', 'false'].includes(this.db.prepare("SELECT value FROM meta WHERE key='legacy_imported'").get()?.value),
        'GENERATION_CATALOG_BOOTSTRAP_INCOMPLETE');
      this.identity = await fs.lstat(this.file); this.markerIdentity = await fs.lstat(this.marker);
      check(this.identity.nlink === 1 && this.markerIdentity.nlink === 1, 'GENERATION_CATALOG_UNSAFE_FILE');
      this.owned.clear(); return this;
    } catch (error) { this.close(); throw error; }
  }
  close() { this.db?.close(); this.db = null; this.owned.clear(); }
  #check() {
    check(this.db, 'GENERATION_CATALOG_CLOSED');
    for (const [file, expected] of [[this.file, this.identity], [this.marker, this.markerIdentity]]) {
      const stat = lstatSync(file);
      check(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1
        && stat.dev === expected.dev && stat.ino === expected.ino, 'GENERATION_CATALOG_CHANGED');
    }
    check(readFileSync(this.marker).equals(this.markerRaw), 'GENERATION_CATALOG_MARKER_CHANGED');
  }
  #transaction(fn) {
    this.#check(); this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  #run(runId, states = ['running', 'verified', 'pruning']) {
    id(runId); check(this.owned.has(runId), 'GENERATION_CATALOG_RUN_NOT_OWNED');
    const run = this.db.prepare('SELECT * FROM runs WHERE id=?').get(runId);
    check(run && states.includes(run.status), 'GENERATION_CATALOG_RUN_STATE'); return run;
  }
  #pending(runId) {
    const op = this.db.prepare("SELECT * FROM operations WHERE run_id=? AND status='pending'").all(runId);
    const deletion = this.db.prepare("SELECT * FROM deletions WHERE run_id=? AND status='attempting'").all(runId);
    check(op.length + deletion.length <= 1, 'GENERATION_CATALOG_PENDING_CORRUPT');
    return {op: op[0], deletion: deletion[0]};
  }
  #noPending(runId) {
    const pending = this.#pending(runId);
    check(!pending.op && !pending.deletion, 'GENERATION_CATALOG_OPERATION_UNSETTLED');
  }
  #object(keyValue) {
    const row = this.db.prepare('SELECT * FROM objects WHERE key=?').get(keyValue);
    return row ? {...row, value: JSON.parse(row.value)} : null;
  }
  #activeGenerations() {
    return this.db.prepare("SELECT value FROM generations WHERE status='active'").all().map(row => JSON.parse(row.value));
  }
  #completed(runId) {
    return this.db.prepare("SELECT * FROM operations WHERE run_id=? AND status='complete' ORDER BY seq").all(runId)
      .map(row => ({...row, intent: JSON.parse(row.intent), result: JSON.parse(row.result)}));
  }
  assertSettled() {
    this.#check();
    check(this.db.prepare("SELECT count(*) n FROM runs WHERE status!='complete'").get().n === 0
      && this.db.prepare("SELECT count(*) n FROM operations WHERE status!='complete'").get().n === 0
      && this.db.prepare("SELECT count(*) n FROM deletions WHERE status!='confirmed_absent'").get().n === 0,
    'GENERATION_CATALOG_RECONCILIATION_REQUIRED');
    return true;
  }
  snapshot() {
    this.#check();
    const objects = this.db.prepare("SELECT value FROM objects WHERE status='active' ORDER BY key").all().map(row => JSON.parse(row.value));
    const baseKey = JSON.parse(this.db.prepare("SELECT value FROM meta WHERE key='active_base'").get().value);
    const base = baseKey === null ? null : objects.find(row => row.key === baseKey);
    check(baseKey === null || base?.kind === 'base', 'GENERATION_CATALOG_BASE_MISSING');
    return {objects, generations: this.#activeGenerations(), base: base ? {key: base.key, descriptor: base.descriptor} : null,
      legacyImported: this.db.prepare("SELECT value FROM meta WHERE key='legacy_imported'").get().value === 'true'};
  }
  importLegacy(records) {
    this.#check(); this.assertSettled();
    check(Array.isArray(records) && records.length <= 20, 'GENERATION_CATALOG_LEGACY');
    const keys = new Set();
    const rows = records.map(r => {
      exact(r, Object.hasOwn(r, 'status')
        ? ['key', 'bytes', 'sha256', 'etag', 'verifiedAt', 'release', 'proofHash', 'status']
        : ['key', 'bytes', 'sha256', 'etag', 'verifiedAt', 'release', 'proofHash']);
      check(r.status === undefined || r.status === 'active', 'GENERATION_CATALOG_LEGACY');
      check(/^[a-f0-9]{40}$/.test(r.release) && !keys.has(r.key), 'GENERATION_CATALOG_LEGACY'); sha(r.proofHash); iso(r.verifiedAt);
      keys.add(r.key);
      return {object: object({key: r.key, bytes: r.bytes, sha256: r.sha256, etag: r.etag, kind: 'legacy'}, this.scope),
        generation: {id: `legacy-${hash({key: r.key}).slice(0, 48)}`, kind: 'legacy', verifiedAt: r.verifiedAt, objectKey: r.key}};
    });
    return this.#transaction(() => {
      check(this.db.prepare("SELECT value FROM meta WHERE key='legacy_imported'").get().value === 'false'
        && this.db.prepare('SELECT count(*) n FROM runs').get().n === 0, 'GENERATION_CATALOG_LEGACY_ALREADY_IMPORTED');
      for (const row of rows) {
        this.db.prepare("INSERT INTO objects VALUES(?,?,'active')").run(row.object.key, bounded(row.object));
        this.db.prepare("INSERT INTO generations VALUES(?,?,'active',NULL)").run(row.generation.id, bounded(row.generation));
      }
      this.db.prepare("UPDATE meta SET value='true' WHERE key='legacy_imported'").run();
      this.db.prepare('INSERT INTO meta VALUES(?,?)').run('legacy_import_hash', hash(records));
      this.db.prepare('INSERT INTO meta VALUES(?,?)').run('legacy_import_records', bounded(records));
      return rows.length;
    });
  }
  beginRun(value) {
    exact(value, ['id', 'release', 'at']); id(value.id); iso(value.at);
    check(/^[a-f0-9]{40}$/.test(value.release), 'GENERATION_CATALOG_RELEASE');
    return this.#transaction(() => {
      check(this.db.prepare("SELECT value FROM meta WHERE key='legacy_imported'").get().value === 'true',
        'GENERATION_CATALOG_LEGACY_IMPORT_REQUIRED');
      check(this.db.prepare("SELECT count(*) n FROM runs WHERE status!='complete'").get().n === 0,
        'GENERATION_CATALOG_RECONCILIATION_REQUIRED');
      check(!this.db.prepare('SELECT id FROM runs WHERE id=?').get(value.id), 'GENERATION_CATALOG_RUN_EXISTS');
      this.db.prepare("INSERT INTO runs(id,value,status) VALUES(?,?,'running')").run(value.id, bounded(value));
      this.owned.add(value.id); return clone(value);
    });
  }
  beginOperation(runId, value) {
    exact(value, ['id', 'kind', 'key', 'expected']); id(value.id);
    check(['list', 'head', 'upload', 'download'].includes(value.kind), 'GENERATION_CATALOG_OPERATION');
    if (value.kind === 'list') check(value.key === null && value.expected === null, 'GENERATION_CATALOG_OPERATION');
    else {
      key(value.key); exact(value.expected, ['bytes', 'sha256']); int(value.expected.bytes, 'GENERATION_CATALOG_BYTES', 44, 512_000_000); sha(value.expected.sha256);
    }
    return this.#transaction(() => {
      this.#run(runId); this.#noPending(runId);
      check(!this.db.prepare('SELECT id FROM operations WHERE run_id=? AND id=?').get(runId, value.id),
        'GENERATION_CATALOG_OPERATION_EXISTS');
      this.db.prepare("INSERT INTO operations(run_id,id,intent,status) VALUES(?,?,?,'pending')").run(runId, value.id, bounded(value));
      return clone(value);
    });
  }
  recordReservation(runId, value) {
    exact(value, ['id', 'at', 'requests', 'uploadBytes', 'downloadBytes']);
    int(value.id, 'GENERATION_CATALOG_RESERVATION', 1); int(value.at, 'GENERATION_CATALOG_RESERVATION', 1);
    for (const field of ['requests', 'uploadBytes', 'downloadBytes']) int(value[field], 'GENERATION_CATALOG_RESERVATION');
    check(value.requests + value.uploadBytes + value.downloadBytes > 0, 'GENERATION_CATALOG_RESERVATION');
    return this.#transaction(() => {
      this.#run(runId); const pending = this.#pending(runId);
      check(pending.op || pending.deletion, 'GENERATION_CATALOG_RESERVATION_WITHOUT_INTENT');
      check(!this.db.prepare('SELECT id FROM reservations WHERE id=?').get(value.id), 'GENERATION_CATALOG_RESERVATION_EXISTS');
      this.db.prepare('INSERT INTO reservations VALUES(?,?,?,?,?)')
        .run(value.id, runId, pending.op?.id ?? null, pending.deletion?.key ?? null, bounded(value));
      return `r2-${value.id}`;
    });
  }
  reservationIds(runId) {
    this.#check(); this.#run(runId);
    return this.db.prepare('SELECT id FROM reservations WHERE run_id=? ORDER BY id').all(runId).map(row => `r2-${row.id}`);
  }
  completeOperation(runId, operationId, result) {
    return this.#transaction(() => {
      this.#run(runId); const {op, deletion} = this.#pending(runId);
      check(op && !deletion && op.id === operationId, 'GENERATION_CATALOG_OPERATION_MISMATCH');
      const intent = JSON.parse(op.intent);
      check(result?.status === 'PASS' && result.kind === intent.kind && result.key === intent.key,
        'GENERATION_CATALOG_OPERATION_RESULT');
      if (intent.kind === 'list') { rawInventory(result.raw); iso(result.capturedAt); }
      else {
        check(result.bytes === intent.expected.bytes && result.sha256 === intent.expected.sha256,
          'GENERATION_CATALOG_OPERATION_RESULT');
        if (intent.kind === 'head' || intent.kind === 'upload') check(typeof result.etag === 'string' && result.etag.length > 0,
          'GENERATION_CATALOG_OPERATION_RESULT');
      }
      const charges = this.db.prepare('SELECT value FROM reservations WHERE run_id=? AND operation_id=?')
        .all(runId, operationId).map(row => JSON.parse(row.value));
      const charge = field => charges.reduce((n, row) => n + row[field], 0);
      check(charge('requests') >= (intent.kind === 'upload' ? 4 : 1)
        && (intent.kind !== 'upload' || charge('uploadBytes') >= intent.expected.bytes)
        && (intent.kind !== 'download' || charge('downloadBytes') >= intent.expected.bytes),
      'GENERATION_CATALOG_UNCHARGED_OPERATION');
      this.db.prepare("UPDATE operations SET status='complete',result=? WHERE run_id=? AND id=?")
        .run(bounded(result), runId, operationId); return clone(result);
    });
  }
  commitVerified(runId, {generation: value, objects: newObjects, proof, proofHash, base}) {
    const gen = generation(value); check(gen.kind === 'base-overlay', 'GENERATION_CATALOG_GENERATION');
    check(Array.isArray(newObjects) && newObjects.length > 0 && newObjects.length <= 20, 'GENERATION_CATALOG_OBJECTS');
    const values = newObjects.map(v => object(v, this.scope));
    check(new Set(values.map(v => v.key)).size === values.length, 'GENERATION_CATALOG_OBJECTS');
    exact(proof, ['scope', 'verification', 'inventory']); check(equal(scope(proof.scope), this.scope), 'GENERATION_CATALOG_SCOPE');
    sha(proofHash); check(hash(proof) === proofHash, 'GENERATION_CATALOG_PROOF_HASH');
    exact(base, ['key', 'descriptor']); key(base.key);
    return this.#transaction(() => {
      const run = this.#run(runId, ['running']); this.#noPending(runId);
      const runValue = JSON.parse(run.value);
      check(gen.id === runId && Date.parse(gen.verifiedAt) >= Date.parse(runValue.at), 'GENERATION_CATALOG_RUN_BINDING');
      check(!this.db.prepare('SELECT id FROM generations WHERE id=?').get(gen.id), 'GENERATION_CATALOG_GENERATION_EXISTS');
      for (const supplied of values) {
        const existing = this.#object(supplied.key);
        if (existing) check(existing.status === 'active' && equal(existing.value, supplied), 'GENERATION_CATALOG_OBJECT_CHANGED');
        else check(dependencies(gen).includes(supplied.key), 'GENERATION_CATALOG_OBJECTS');
      }
      const records = new Map();
      for (const k of dependencies(gen)) {
        const supplied = values.find(v => v.key === k), existing = this.#object(k);
        check(!existing || existing.status === 'active', 'GENERATION_CATALOG_OBJECT_TOMBSTONED');
        if (existing && supplied) check(equal(existing.value, supplied), 'GENERATION_CATALOG_OBJECT_CHANGED');
        const record = supplied ?? existing?.value; check(record, 'GENERATION_CATALOG_DANGLING'); records.set(k, record);
      }
      const b = records.get(gen.baseKey), overlay = records.get(gen.overlayKey);
      check(b.kind === 'base' && overlay.kind === 'overlay' && b.key === base.key
        && equal(b.descriptor, base.descriptor), 'GENERATION_CATALOG_BASE_BINDING');
      const bd = b.descriptor, gd = overlay.descriptor;
      check(gd.manifest.release === runValue.release, 'GENERATION_CATALOG_RELEASE');
      check(equal(gd.base, {cipherHash: bd.cipherHash, cipherBytes: bd.cipherBytes, manifestHash: bd.manifestHash}),
        'GENERATION_CATALOG_BASE_BINDING');
      const old = new Map(bd.manifest.files.map(f => [f.file, f])), current = new Set(gd.manifest.files.map(f => f.file));
      check(equal(gd.changedFiles, gd.manifest.files.filter(f => !old.has(f.file) || !equal(old.get(f.file), f)))
        && equal(gd.deletedPaths, bd.manifest.files.filter(f => !current.has(f.file)).map(f => f.file)),
      'GENERATION_CATALOG_DESCRIPTOR_DIFF');
      const v = proof.verification;
      check(v?.schemaVersion === 1 && v.status === 'PASS' && v.generationId === gen.id
        && v.generationHash === hash(gen) && v.inventoryHash === hash(proof.inventory),
      'GENERATION_CATALOG_PROOF_BINDING');
      iso(v.verifiedAt); check(Date.parse(v.verifiedAt) >= Date.parse(gen.verifiedAt), 'GENERATION_CATALOG_PROOF_TIME');
      const restored = v.fullRestore;
      check(restored?.status === 'PASS' && restored.databaseIntegrity === 'ok'
        && restored.mailSent === false && restored.liveStorageOverwritten === false
        && restored.logicalFiles === gd.manifest.files.length && restored.logicalBytes === gd.logicalBytes,
      'GENERATION_CATALOG_FULL_RESTORE');
      const completed = this.#completed(runId), latestList = completed.filter(op => op.intent.kind === 'list').at(-1);
      check(latestList && equal(rawInventory(latestList.result.raw), plannerInventory(proof.inventory))
        && latestList.result.capturedAt === proof.inventory.capturedAt, 'GENERATION_CATALOG_LIST_PROOF');
      for (const row of proof.inventory.objects) {
        const known = records.get(row.key) ?? this.#object(row.key)?.value;
        if (known) check(row.bytes === known.bytes && row.sha256 === known.sha256 && row.etag === known.etag,
          'GENERATION_CATALOG_INVENTORY_CHANGED');
      }
      for (const existing of this.db.prepare("SELECT value FROM objects WHERE status='active'").all()) {
        const known = JSON.parse(existing.value);
        check(proof.inventory.objects.some(row => row.key === known.key && row.bytes === known.bytes
          && row.sha256 === known.sha256 && row.etag === known.etag), 'GENERATION_CATALOG_INVENTORY_MISSING');
      }
      for (const record of records.values()) {
        check(proof.inventory.objects.some(row => row.key === record.key && row.sha256 === record.sha256),
          'GENERATION_CATALOG_INVENTORY_MISSING');
        check(completed.some(op => op.intent.kind === 'download' && op.result.key === record.key
          && op.result.bytes === record.bytes && op.result.sha256 === record.sha256), 'GENERATION_CATALOG_DOWNLOAD_REQUIRED');
      }
      check(Array.isArray(v.downloads) && v.downloads.length === 2
        && new Set(v.downloads.map(row => row.key)).size === 2, 'GENERATION_CATALOG_DOWNLOAD_PROOF');
      for (const row of v.downloads) {
        const expected = records.get(row.key);
        check(expected && row.status === 'PASS' && row.bytes === expected.bytes && row.sha256 === expected.sha256,
          'GENERATION_CATALOG_DOWNLOAD_PROOF');
      }
      const uploaded = values.filter(row => !this.#object(row.key));
      check(uploaded.some(row => row.key === overlay.key), 'GENERATION_CATALOG_NEW_OVERLAY_REQUIRED');
      check(Array.isArray(v.uploads) && v.uploads.length === uploaded.length
        && new Set(v.uploads.map(row => row.key)).size === uploaded.length, 'GENERATION_CATALOG_UPLOAD_PROOF');
      for (const record of uploaded) {
        check(completed.some(op => op.intent.kind === 'upload' && op.result.key === record.key
          && op.result.bytes === record.bytes && op.result.sha256 === record.sha256 && op.result.etag === record.etag),
        'GENERATION_CATALOG_UPLOAD_REQUIRED');
        check(v.uploads.some(row => row.key === record.key && row.status === 'PASS'
          && row.bytes === record.bytes && row.sha256 === record.sha256), 'GENERATION_CATALOG_UPLOAD_PROOF');
      }
      const charges = this.db.prepare('SELECT value FROM reservations WHERE run_id=?').all(runId)
        .map(r => JSON.parse(r.value)).filter(row => row.at <= Date.parse(v.verifiedAt));
      check(equal(sortedKeys(v.reservationIds), sortedKeys(charges.map(row => `r2-${row.id}`))),
        'GENERATION_CATALOG_RESERVATION_PROOF');
      const sum = field => charges.reduce((n, r) => n + r[field], 0);
      check(sum('requests') >= 1 + 4 * uploaded.length + 2
        && sum('uploadBytes') >= uploaded.reduce((n, r) => n + r.bytes, 0)
        && sum('downloadBytes') >= b.bytes + overlay.bytes, 'GENERATION_CATALOG_RESERVATION_PROOF');
      for (const record of uploaded) this.db.prepare("INSERT INTO objects VALUES(?,?,'active')").run(record.key, bounded(record, MAX_DESCRIPTOR + 4096));
      this.db.prepare("INSERT INTO generations VALUES(?,?,'active',?)").run(gen.id, bounded(gen), runId);
      this.db.prepare("UPDATE runs SET status='verified',proof=?,proof_hash=?,base=? WHERE id=?")
        .run(bounded(proof), proofHash, bounded(base, MAX_DESCRIPTOR + 4096), runId);
      return clone(gen);
    });
  }
  beginPrune(runId, {plan, planHash}) {
    sha(planHash); check(hash(plan) === planHash, 'GENERATION_CATALOG_PLAN_HASH');
    return this.#transaction(() => {
      const run = this.#run(runId, ['verified']); this.#noPending(runId);
      const wrapper = JSON.parse(run.proof), proof = wrapper.verification, rows = this.#activeGenerations();
      const chosen = selection(rows, proof.generationId);
      check(plan?.planningOnly === true && plan.phase === 'restored' && plan.admitted === true
        && equal(plan.blockers, []) && plan.policy === RETENTION_POLICY && plan.anchor === proof.generationId
        && plan.inventoryHash === proof.inventoryHash && plan.candidateHash === proof.generationHash
        && plan.verification?.proofHash === hash(proof) && plan.verification.fullRestoreVerified === true,
      'GENERATION_CATALOG_PLAN_BINDING');
      check(equal(plan.weekly, chosen.weekly) && equal(plan.monthly, chosen.monthly)
        && equal(plan.keepGenerationIds, chosen.keep) && equal(plan.retireGenerationIds, chosen.retire),
      'GENERATION_CATALOG_RETENTION_POLICY');
      const retainedKeys = sortedKeys([...new Set(rows.filter(r => chosen.keep.includes(r.id)).flatMap(dependencies))]);
      const remove = sortedKeys([...new Set(rows.filter(r => chosen.retire.includes(r.id)).flatMap(dependencies))]
        .filter(k => !retainedKeys.includes(k)));
      check(equal(sortedKeys(plan.keepObjectKeys), retainedKeys)
        && equal(sortedKeys(plan.deletionCandidates.map(r => r.key)), remove), 'GENERATION_CATALOG_DEPENDENCY_CLOSURE');
      for (const value of plan.deletionCandidates) {
        const old = this.#object(value.key);
        check(old?.status === 'active'
          && ['key', 'bytes', 'sha256', 'kind', 'etag'].every(k => value[k] === old.value[k]),
        'GENERATION_CATALOG_DELETE_CHANGED');
        this.db.prepare("INSERT INTO deletions VALUES(?,?,?,'planned',NULL,NULL)").run(runId, value.key, bounded(value));
      }
      const seq = this.db.prepare('SELECT coalesce(max(seq),0) n FROM operations WHERE run_id=?').get(runId).n;
      this.db.prepare("UPDATE runs SET status='pruning',plan=?,plan_hash=?,plan_operation_seq=? WHERE id=?").run(bounded(plan), planHash, seq, runId);
      return clone(plan.deletionCandidates);
    });
  }
  markDeleting(runId, keyValue) {
    key(keyValue);
    return this.#transaction(() => {
      const run = this.#run(runId, ['pruning']); this.#noPending(runId);
      const plan = JSON.parse(run.plan), completed = this.#completed(runId);
      for (const kept of plan.keepObjectKeys) {
        const record = this.#object(kept)?.value;
        check(record && completed.some(op => op.seq > run.plan_operation_seq && op.intent.kind === 'head' && op.result.key === kept
          && op.result.bytes === record.bytes && op.result.sha256 === record.sha256 && op.result.etag === record.etag),
        'GENERATION_CATALOG_RETAINED_HEAD_REQUIRED');
      }
      const seq = this.db.prepare('SELECT coalesce(max(seq),0) n FROM operations WHERE run_id=?').get(runId).n;
      check(this.db.prepare("UPDATE deletions SET status='attempting',operation_seq=? WHERE run_id=? AND key=? AND status='planned'")
        .run(seq, runId, keyValue).changes === 1, 'GENERATION_CATALOG_DELETE_NOT_PLANNED');
      return JSON.parse(this.db.prepare('SELECT value FROM deletions WHERE run_id=? AND key=?').get(runId, keyValue).value);
    });
  }
  markDeleted(runId, keyValue, receipt) {
    return this.#transaction(() => {
      this.#run(runId, ['pruning']); const pending = this.#pending(runId);
      check(!pending.op && pending.deletion?.key === keyValue, 'GENERATION_CATALOG_DELETE_NOT_ATTEMPTED');
      check(receipt?.status === 'PASS' && receipt.key === keyValue && receipt.confirmedAbsent === true,
        'GENERATION_CATALOG_DELETE_RECEIPT');
      const charges = this.db.prepare('SELECT value FROM reservations WHERE run_id=? AND delete_key=?').all(runId, keyValue).map(r => JSON.parse(r.value));
      check(charges.reduce((n, r) => n + r.requests, 0) >= 3, 'GENERATION_CATALOG_DELETE_UNCHARGED');
      this.db.prepare("UPDATE deletions SET status='confirmed_absent',receipt=? WHERE run_id=? AND key=?")
        .run(bounded(receipt), runId, keyValue);
      check(this.db.prepare("UPDATE objects SET status='deleted' WHERE key=? AND status='active'").run(keyValue).changes === 1,
        'GENERATION_CATALOG_DELETE_CHANGED');
      return clone(receipt);
    });
  }
  finishRun(runId, {receipt, retireGenerationIds}) {
    return this.#transaction(() => {
      const run = this.#run(runId, ['pruning']); this.#noPending(runId);
      const plan = JSON.parse(run.plan);
      check(equal(sortedKeys(retireGenerationIds), sortedKeys(plan.retireGenerationIds)), 'GENERATION_CATALOG_RETIRE_MISMATCH');
      check(this.db.prepare("SELECT count(*) n FROM deletions WHERE run_id=? AND status!='confirmed_absent'").get(runId).n === 0,
        'GENERATION_CATALOG_DELETE_UNCONFIRMED');
      check(receipt?.status === 'PASS', 'GENERATION_CATALOG_FINISH_RECEIPT');
      const latest = this.#completed(runId).filter(op => op.intent.kind === 'list').at(-1);
      const lastDeletionSeq = this.db.prepare('SELECT coalesce(max(operation_seq),0) n FROM deletions WHERE run_id=?').get(runId).n;
      check(latest && latest.seq > Math.max(run.plan_operation_seq, lastDeletionSeq)
        && equal(rawInventory(latest.result.raw), plannerInventory(receipt.inventory))
        && latest.result.capturedAt === receipt.inventory.capturedAt, 'GENERATION_CATALOG_FINAL_INVENTORY');
      for (const kept of plan.keepObjectKeys) {
        const record = this.#object(kept)?.value;
        check(record && this.#completed(runId).some(op => op.seq > run.plan_operation_seq
          && op.intent.kind === 'head' && op.result.key === kept && op.result.bytes === record.bytes
          && op.result.sha256 === record.sha256 && op.result.etag === record.etag),
        'GENERATION_CATALOG_RETAINED_HEAD_REQUIRED');
      }
      const before = JSON.parse(run.proof).inventory.objects;
      const removed = new Set(plan.deletionCandidates.map(r => r.key));
      const expectedRaw = before.filter(r => !removed.has(r.key)).map(r => ({Key: r.key, Size: r.bytes, ETag: r.etag}));
      check(equal(rawInventory(expectedRaw), rawInventory(latest.result.raw)), 'GENERATION_CATALOG_FINAL_INVENTORY');
      const activeKeys = new Set(this.db.prepare("SELECT key FROM objects WHERE status='active'").all().map(r => r.key));
      for (const gen of this.#activeGenerations().filter(g => !retireGenerationIds.includes(g.id))) {
        check(dependencies(gen).every(k => activeKeys.has(k)), 'GENERATION_CATALOG_RETAINED_DEPENDENCY_MISSING');
      }
      for (const generationId of retireGenerationIds) {
        check(this.db.prepare("UPDATE generations SET status='retired' WHERE id=? AND status='active'").run(generationId).changes === 1,
          'GENERATION_CATALOG_RETIRE_MISMATCH');
      }
      const base = JSON.parse(run.base);
      check(activeKeys.has(base.key), 'GENERATION_CATALOG_BASE_MISSING');
      this.db.prepare("UPDATE meta SET value=? WHERE key='active_base'").run(json(base.key));
      this.db.prepare("UPDATE runs SET status='complete',receipt=? WHERE id=?").run(bounded(receipt), runId);
      this.owned.delete(runId); return {status: 'PASS',runId,retired: clone(retireGenerationIds),deleted: [...removed]};
    });
  }
}
