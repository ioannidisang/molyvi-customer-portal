import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {canonicalJson, IntakeError} from './intake-store.mjs';
import {productFor, requestPhotoReview, recordPhotoReview} from './product-materials.mjs';
import {requestTextVariant, recordTextVariant} from './product-text.mjs';
import {initializeGallery, recordInitialPhoto,photoSourceForSlot} from './product-gallery.mjs';
import {unitFor} from './catalog-model.mjs';
import {validatePhoto, storeGeneratedPhoto} from './product-assets.mjs';
import {validateSessionExecution} from './session-execution.mjs';

const digest = value => crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
const bytesHash = value => crypto.createHash('sha256').update(value).digest('hex');
const fail = (code, status = 409) => { throw new IntakeError(code, status); };
const uuid = value => typeof value === 'string' && /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(value);

function requestedAssetIds(product,kind,visualUnitId) {
  if(kind==='text')return product.photos;
  if(Array.isArray(product.visualUnits)) {
    if(!visualUnitId)fail('VISUAL_UNIT_REQUIRED',422);
    return unitFor(product,visualUnitId).sourceAssetIds;
  }
  if(visualUnitId!==undefined)fail('VISUAL_UNIT_NOT_FOUND',404);
  return product.photos;
}
async function assetEvidence(store, record, product,ids=product.photos) {
  const directory = await store.directory(record.id);
  return Promise.all(ids.map(async id => {
    const asset = record.assets?.[id];
    if (!asset || asset.productId !== product.id) fail('PHOTO_NOT_OWNED', 403);
    const file = path.join(directory, `photo-${id}.bin`), info = await fs.lstat(file);
    if (info.isSymbolicLink() || !info.isFile()) fail('UNSAFE_STORAGE', 500);
    const bytes = await fs.readFile(file);
    if (bytes.length !== asset.bytes || bytesHash(bytes) !== asset.sha256) fail('PHOTO_INTEGRITY_FAILED', 500);
    return {id, sha256: asset.sha256, bytes: asset.bytes, mime: asset.mime, name: asset.name, file};
  }));
}

// Only trusted local code calls these functions. There is deliberately no HTTP
// route that lets the customer supply AI verdicts, final copy or generated media.
// Preparing a packet reserves existing allowances but makes no provider calls.
export async function prepareProductPilot(store, session, {productId, kind, field, visualUnitId, requestId = crypto.randomUUID()}) {
  if (!['materials', 'text', 'photos'].includes(kind)) fail('INVALID_PILOT_KIND', 400);
  if(kind==='text'&&visualUnitId!==undefined)fail('INVALID_PILOT_TEXT_UNIT',400);
  return store.transact(session.projectId, session.ownerId, async record => {
    const product = productFor(record, productId), sourceIds=requestedAssetIds(product,kind,visualUnitId), sources = await assetEvidence(store, record, product,sourceIds);
    if (kind!=='text'&&!sources.length) fail('INPUT_INCOMPLETE', 422);
    let payload;
    if (kind === 'materials') {
      const review = requestPhotoReview(record, {productId,...(visualUnitId?{visualUnitId}:{})});
      if (review.status !== 'awaiting_review') fail('PILOT_REVIEW_ALREADY_FINISHED');
      const scopedProduct=structuredClone(product);
      if(visualUnitId){const unit=unitFor(product,visualUnitId);scopedProduct.photos=[...sourceIds];scopedProduct.visualUnits=[structuredClone(unit)];scopedProduct.variants=scopedProduct.variants.filter(variant=>unit.variantIds.includes(variant.id));}
      payload = {reviewId: review.id, fingerprint: review.fingerprint, product: scopedProduct};
    } else if (kind === 'text') {
      const request = requestTextVariant(record, {productId, field, requestId});
      if (request.status !== 'awaiting_provider') fail('PILOT_TEXT_ALREADY_FINISHED');
      payload = {field, requestId: request.id, inputHash: request.inputHash, source: structuredClone(request.source)};
    } else {
      const gallery = initializeGallery(record, {productId});
      const submission = record.productTasks[productId].submission;
      const slots=visualUnitId?gallery.slots.filter(slot=>slot.visualUnitId===visualUnitId):gallery.slots;
      if(!slots.length)fail('VISUAL_UNIT_NOT_FOUND',404);
      payload = {workId: `${submission.hash}:work`, sourceHash: gallery.sourceHash,
        source: structuredClone(visualUnitId?photoSourceForSlot(gallery,slots[0].id):gallery.source), slots: slots.map(({id, role,...rest}) => ({id, role,...(rest.visualUnitId?{visualUnitId:rest.visualUnitId}:{})}))};
    }
    const content = {schemaVersion: 1, kind, projectId: record.id, ownerId: record.ownerId,
      orderId: record.order.id, productId,...(visualUnitId?{visualUnitId}:{}), assetEvidence: sources, ...payload};
    const payloadHash = digest(content);
    record.productPilotPackets ??= {};
    const existing = Object.values(record.productPilotPackets).find(item => item.payloadHash === payloadHash);
    if (existing) return structuredClone(existing);
    const packet = {...content, packetId: crypto.randomUUID(), payloadHash, preparedAt: new Date().toISOString()};
    record.productPilotPackets[packet.packetId] = structuredClone(packet);
    return packet;
  });
}

function packetContent(packet) {
  const {packetId, payloadHash, preparedAt, ...content} = packet;
  return content;
}

export async function importProductPilot(store, session, {packet, result, evidence}) {
  if (!packet || !uuid(packet.packetId) || !result || typeof result !== 'object' || Array.isArray(result)) fail('INVALID_PILOT_RESULT', 400);
  const execution = validateSessionExecution(evidence, packet.payloadHash);
  if (packet.kind === 'photos' && execution.tool !== 'image_gen' || packet.kind !== 'photos' && execution.tool !== 'assistant_session') fail('PILOT_EXECUTION_TOOL_MISMATCH', 422);
  // Validate bytes before any state change or file write. Source data is not
  // transformed here; the real image tool has already produced the result.
  const image = packet.kind === 'photos' ? validatePhoto(result) : null;
  if (image && result.sha256 !== image.sha256) fail('GENERATED_PHOTO_INTEGRITY_FAILED', 422);
  return store.transact(session.projectId, session.ownerId, async record => {
    const saved = record.productPilotPackets?.[packet.packetId];
    if (!saved || canonicalJson(saved) !== canonicalJson(packet) || digest(packetContent(packet)) !== packet.payloadHash) fail('PILOT_PACKET_TAMPERED', 422);
    if (packet.projectId !== record.id || packet.ownerId !== record.ownerId || packet.orderId !== record.order.id) fail('PILOT_OWNER_MISMATCH', 403);
    const product = productFor(record, packet.productId);
    const sources = await assetEvidence(store, record, product,requestedAssetIds(product,packet.kind,packet.visualUnitId));
    if (canonicalJson(sources) !== canonicalJson(packet.assetEvidence)) fail('PILOT_SOURCES_STALE');
    const resultKey = `${packet.packetId}:${packet.kind === 'photos' ? result.slotId : 'result'}`;
    const resultHash = digest({result: image ? {slotId: result.slotId, sha256: image.sha256, name: image.name, mime: image.mime} : result, evidence: execution});
    record.productPilotImports ??= {};
    const prior = record.productPilotImports[resultKey];
    if (prior) {
      if (prior.resultHash !== resultHash) fail('PILOT_RESULT_CONFLICT');
      return {duplicate: true, receipt: structuredClone(prior)};
    }
    let delivered;
    if (packet.kind === 'materials') {
      delivered = recordPhotoReview(record, {productId: packet.productId, reviewId: packet.reviewId,
        fingerprint: packet.fingerprint, verdict: result.verdict, reason: result.reason,...(packet.visualUnitId?{visualUnitId:packet.visualUnitId}:{})});
    } else if (packet.kind === 'text') {
      // Recheck current customer/business/branding text. A delayed result must
      // not silently fulfill a request after its source was edited.
      const current = requestTextVariant(record, {productId: packet.productId, field: packet.field, requestId: packet.requestId});
      if (current.inputHash !== packet.inputHash) fail('TEXT_REQUEST_STALE');
      if (current.status !== 'awaiting_provider') fail('PILOT_TEXT_ALREADY_FINISHED');
      delivered = recordTextVariant(record, {productId: packet.productId, field: packet.field,
        requestId: packet.requestId, inputHash: packet.inputHash, text: result.text,
        factsVerified: result.factsVerified, costEur: null, executionEvidence: execution});
      if (delivered.status !== 'completed') fail('PILOT_TEXT_REQUIRES_REVIEW', 422);
    } else {
      const gallery = initializeGallery(record, {productId: packet.productId});
      if (gallery.sourceHash !== packet.sourceHash || !gallery.slots.some(slot => slot.id === result.slotId) || !packet.slots.some(slot=>slot.id===result.slotId)) fail('GALLERY_STALE');
      if (gallery.slots.find(slot => slot.id === result.slotId).candidates.length) fail('INITIAL_PHOTO_EXISTS');
      // Reuse asset validation/storage inside this one serialized transaction.
      // This avoids a second nested lock, and the candidate plus receipt commit
      // together. A crash before commit leaves an unreferenced private file only.
      const transactionStore = {directory: store.directory.bind(store), transact: async (id, owner, operation) => {
        if (id !== record.id || owner !== record.ownerId) fail('NOT_OWNER', 403);
        return {record, result: await operation(record)};
      }};
      const assetResult = await storeGeneratedPhoto(transactionStore, session, {productId: packet.productId,
        sourceHash: packet.sourceHash, name: image.name, mime: image.mime, data: result.data,...(packet.visualUnitId?{visualUnitId:packet.visualUnitId}:{})});
      delivered = recordInitialPhoto(record, {productId: packet.productId, slotId: result.slotId,
        galleryHash: packet.sourceHash, assetId: assetResult.result.assetId});
      record.generatedAssets[assetResult.result.assetId].executionEvidence = execution;
    }
    const receipt = {packetId: packet.packetId, kind: packet.kind, productId: packet.productId,
      ...(packet.kind === 'photos' ? {slotId: result.slotId} : {}), resultHash,
      importedAt: new Date().toISOString(), executionEvidence: execution,
      costEur: null, delivered: structuredClone(delivered)};
    record.productPilotImports[resultKey] = receipt;
    return {duplicate: false, receipt: structuredClone(receipt)};
  });
}
