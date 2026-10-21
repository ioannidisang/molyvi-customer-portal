import crypto from 'node:crypto';
import {IntakeError} from './intake-store.mjs';
import {verifyBasicStorePackage} from './basic-store-package.mjs';
import {verifyBasicReferenceComposition} from './basic-reference-composition.mjs';
import {assertBasicRetainedRequest,withBasicRetainedOperation} from './basic-source-retention.mjs';

const sources=new WeakSet();
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const fail=code=>{throw new IntakeError(`BASIC_INSTALLATION_SOURCE_${code}`,422);};
const freeze=value=>{
  if(value&&typeof value==='object'){Object.freeze(value);for(const child of Object.values(value))freeze(child);}
  return value;
};
const descriptor=asset=>({fileName:asset.fileName,sha256:asset.sha256,bytes:asset.bytes});
const sameDescriptor=(a,b)=>a?.fileName===b.fileName&&a.sha256===b.sha256&&a.bytes===b.bytes;
const abortCheck=signal=>{if(signal?.aborted)fail('REQUEST_ABORTED');};

export const isBasicInstallationSource=value=>sources.has(value);
export function verifyBasicInstallationSource(value){
  if(!isBasicInstallationSource(value))fail('CAPABILITY_REQUIRED');
  return value.plan;
}

/** LOCAL source seam only: not an installation permit or a network client.
 * Legacy callers retain their exact upload ordering and private byte snapshots.
 * Reference callers retain only genuine capabilities and immutable descriptors.
 * guardFetch must NOT wrap the upload POST inside withAsset: that exclusive
 * lease already checks the current record, every input pin and current bytes
 * before/after the consumer; nested revalidation intentionally fails closed.
 */
export function createBasicInstallationSource({prepared,referenceComposition,retainLegacyBytes=false}={}){
  if((prepared!==undefined)+(referenceComposition!==undefined)!==1)fail('EXACTLY_ONE_SOURCE_REQUIRED');
  if(typeof retainLegacyBytes!=='boolean')fail('CONFIGURATION_INVALID');
  const reference=referenceComposition!==undefined;
  const plan=freeze(structuredClone(reference?verifyBasicReferenceComposition(referenceComposition):verifyBasicStorePackage(prepared)));
  const originalPhotos=plan.products.flatMap(product=>product.photos);
  let uploads,owned;
  if(reference){
    const assets=referenceComposition.assets;
    const names=[...(plan.branding.logoFile?[plan.branding.logoFile]:[]),...originalPhotos.map(photo=>photo.fileName)];
    if(!Array.isArray(assets)||assets.length!==names.length||new Set(names).size!==names.length)fail('ASSET_MANIFEST_MISMATCH');
    const byName=new Map(assets.map(asset=>[asset.fileName,asset]));
    if(byName.size!==assets.length)fail('ASSET_MANIFEST_MISMATCH');
    uploads=names.map(fileName=>{
      const asset=byName.get(fileName),photo=originalPhotos.find(item=>item.fileName===fileName);
      if(!asset||asset.kind!=='image'||!Number.isSafeInteger(asset.bytes)||asset.bytes<=0||
        (photo?!sameDescriptor(asset,photo)||asset.mime!==photo.mime:asset.sha256!==plan.branding.logoSha256))fail('ASSET_MANIFEST_MISMATCH');
      return descriptor(asset);
    });
  }else{
    // No caller-owned byte or metadata references survive construction.
    if(retainLegacyBytes)owned=new Map(prepared.uploads.map(asset=>[asset.fileName,Buffer.from(asset.bytes)]));
    uploads=prepared.uploads.map(asset=>({fileName:asset.fileName,sha256:sha(asset.bytes),bytes:asset.bytes.length}));
  }
  uploads=freeze(uploads);
  const byName=new Map(uploads.map(asset=>[asset.fileName,asset]));
  const revalidate=async()=>{
    if(reference)await referenceComposition.revalidate();
    return plan;
  };
  const withAsset=async(fileName,consumer)=>{
    const expected=byName.get(fileName);
    if(!expected||typeof consumer!=='function')fail('ASSET_NOT_OWNED');
    const consume=async({bytes,metadata})=>{
      if(!Buffer.isBuffer(bytes)||!sameDescriptor(metadata,expected)||bytes.length!==expected.bytes||sha(bytes)!==expected.sha256)fail('ASSET_CHANGED');
      const result=await consumer({bytes,metadata});
      if(bytes.length!==expected.bytes||sha(bytes)!==expected.sha256)fail('CONSUMER_CHANGED_BYTES');
      return result;
    };
    if(reference)return referenceComposition.withAsset(fileName,consume);
    if(!owned)fail('LEGACY_BYTES_NOT_RETAINED');
    return consume({bytes:Buffer.from(owned.get(fileName)),metadata:expected});
  };
  const guardFetch=fn=>{
    if(typeof fn!=='function')fail('CALLBACK_REQUIRED');
    if(!reference)return fn;
    return async(...args)=>{
      const signal=args[1]?.signal;
      return withBasicRetainedOperation(referenceComposition,async()=>{
      abortCheck(signal);await revalidate();abortCheck(signal);
      try{return await fn(...args);}
      finally{await revalidate();abortCheck(signal);}
      });
    };
  };
  const guardMethod=fn=>{
    if(typeof fn!=='function')fail('CALLBACK_REQUIRED');
    if(!reference)return fn;
    return async(input,options={})=>{
      // Clone before the first await; never structuredClone an AbortSignal.
      const snapshot=structuredClone(input),optionSnapshot={...options},signal=optionSnapshot.signal;
      abortCheck(signal);await assertBasicRetainedRequest(referenceComposition,snapshot?.binding);await revalidate();abortCheck(signal);
      try{return await fn(snapshot,optionSnapshot);}
      finally{await revalidate();abortCheck(signal);}
    };
  };
  const source=Object.freeze({plan,uploads,revalidate,withAsset,guardFetch,guardMethod});
  sources.add(source);return source;
}
