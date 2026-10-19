import fs from 'node:fs/promises';
import path from 'node:path';
import {PRIVATE_ROOT,WORKSPACE_ROOT,IntakeError} from './intake-store.mjs';
import {gallerySelectionSnapshot} from './product-gallery.mjs';
import {approvedBrandPresentation} from './brand-presentation.mjs';
import {basicStoreCatalogCsv} from './basic-store-package.mjs';

export const HOSTED_BASIC_COMPOSITION_LIMITS=Object.freeze({inputBytes:8*1024*1024,backupSourceBytes:512000000,installerReserveBytes:8*1024*1024,pipelineReserveBytes:3*1024*1024,metadataReserveBytes:1024*1024});
const roots=new Set(['accounts','controlled-operations','controlled-photos','controlled-pro','deliveries','delivery-imports','gmail-journal','hosted-scope.json','mail','regeneration-import-1005-r1','workspaces']);
const fail=code=>{throw new IntakeError(`BASIC_PREPARATION_${code}`,409);};
const inside=(root,target)=>{const relative=path.relative(root,target);return relative!==''&&relative!=='..'&&!relative.startsWith(`..${path.sep}`)&&!path.isAbsolute(relative);};
async function directory(value){const absolute=path.resolve(value),parsed=path.parse(absolute);let current=parsed.root;for(const part of absolute.slice(current.length).split(path.sep).filter(Boolean)){current=path.join(current,part);const stat=await fs.lstat(current);if(!stat.isDirectory()||stat.isSymbolicLink())fail('CAPACITY_UNSAFE_DIRECTORY');}return absolute;}
async function regular(file){await directory(path.dirname(file));const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||!Number.isSafeInteger(stat.size))fail('CAPACITY_UNSAFE_FILE');return stat;}
async function inventory(root,{source=false}={}){
  root=await directory(root);let bytes=0,files=0;
  async function visit(folder,prefix=''){
    for(const entry of await fs.readdir(folder,{withFileTypes:true})){
      if(source&&!prefix&&!roots.has(entry.name))fail('UNEXPECTED_SERVICE_ROOT');
      const relative=prefix?`${prefix}/${entry.name}`:entry.name,file=path.join(folder,entry.name);
      if(source&&['accounts/customers.sqlite-wal','accounts/customers.sqlite-shm'].includes(relative))continue;
      const stat=await fs.lstat(file);if(stat.isSymbolicLink())fail('CAPACITY_UNSAFE_FILE');
      if(stat.isDirectory())await visit(file,relative);
      else{if(!stat.isFile()||stat.nlink!==1||++files>100000||!Number.isSafeInteger(stat.size))fail('CAPACITY_UNSAFE_FILE');bytes+=stat.size;if(!Number.isSafeInteger(bytes)||bytes>HOSTED_BASIC_COMPOSITION_LIMITS.backupSourceBytes)fail('BACKUP_SOURCE_SIZE_LIMIT');}
    }
  }
  await visit(root);return {bytes,files};
}

// Pure bound for an already byte-validated immutable package. Both the operator
// pre-seed gate and hosted admission call this same function; no assets or files
// are loaded here. Every emitted upload is counted, including repeated bytes.
export function estimateHostedBasicCompositionOutput({prepared,theme,heroBytes,logoBytes=0}={}){
  if(!prepared?.plan||!Array.isArray(prepared.uploads)||![theme?.bytes,theme?.files,heroBytes,logoBytes].every(n=>Number.isSafeInteger(n)&&n>=0)||!theme.files)fail('CAPACITY_PLAN_METADATA');
  const size=value=>Buffer.byteLength(JSON.stringify(value,null,2)+'\n'),plan=prepared.plan,planBytes=size(plan),textAllowance=planBytes*6+512*1024;
  const themePlainBytes=theme.bytes+heroBytes+logoBytes+textAllowance;
  const zipBound=Math.ceil(themePlainBytes*1.02)+(theme.files+8)*1024;
  const packageFiles=3+Object.keys(plan.operations).length+plan.pages.length*2+prepared.uploads.length+1;
  if(packageFiles>64||Buffer.byteLength(String(plan.orderId))>4096||prepared.uploads.some(upload=>!Buffer.isBuffer(upload.bytes)))fail('CAPACITY_PLAN_METADATA');
  const selectedBytes=prepared.uploads.reduce((sum,upload)=>sum+upload.bytes.length,0);
  const packageTextBytes=planBytes+size(plan.branding)+Buffer.byteLength(basicStoreCatalogCsv(plan))+Object.values(plan.operations).reduce((sum,item)=>sum+size(item),0)+plan.pages.reduce((sum,page)=>sum+Buffer.byteLength(page.bodyHtml)+Buffer.byteLength(page.bodyText),0);
  // <=64 records with fixed UUID-derived filenames and SHA/byte metadata, plus
  // the fixed README and bounded order ID, fit within this 128 KiB reserve.
  const packageBoundBytes=selectedBytes+packageTextBytes+128*1024,outputBoundBytes=packageBoundBytes+zipBound+512*1024;
  if(!Number.isSafeInteger(outputBoundBytes))fail('CAPACITY_PLAN_METADATA');
  return {planBytes,packageTextBytes,selectedBytes,packageBoundBytes,zipBoundBytes:zipBound,outputBoundBytes};
}

// Read-only admission: a size-only asset gate precedes immutable plan validation.
// Hosted caller must hold its global mutation lease throughout
// admission, composition and installer handoff. No reserve can raise a limit.
export async function inspectHostedBasicCompositionCapacity({store,session,record,buildRoot,themeSource=path.join(WORKSPACE_ROOT,'forma-production-kit','theme'),after=false}={}){
  const sourceRoot=path.dirname(store.storage);
  if(path.basename(store.storage)!=='workspaces'||!inside(PRIVATE_ROOT,sourceRoot)||path.resolve(buildRoot)!==path.join(sourceRoot,'controlled-operations','basic-composition')||session.projectId!==record.id||session.ownerId!==record.ownerId)fail('HOSTED_BUILD_SCOPE');
  const source=await inventory(sourceRoot,{source:true}),limits=HOSTED_BASIC_COMPOSITION_LIMITS;
  if(after){if(source.bytes+limits.installerReserveBytes+limits.pipelineReserveBytes+limits.metadataReserveBytes>limits.backupSourceBytes)fail('BACKUP_HEADROOM_REQUIRED');return {sourceBytes:source.bytes,reservedInstallerBytes:limits.installerReserveBytes,reservedPipelineBytes:limits.pipelineReserveBytes,reservedMetadataBytes:limits.metadataReserveBytes,backupSourceLimit:limits.backupSourceBytes};}
  const project=await store.directory(record.id),references=new Map();
  for(const product of record.tasks.catalog.draft.products){
    for(const photo of gallerySelectionSnapshot(record,product.id).photos)references.set(`generated:${photo.assetId}`,{asset:record.generatedAssets?.[photo.assetId],prefix:'generated'});
    for(const ref of record.productTasks[product.id].submission.photoEvidence)references.set(`source:${ref.id}`,{asset:record.assets?.[ref.id],prefix:'photo'});
  }
  const brand=approvedBrandPresentation(record),logo=brand?.logoAssetId?record.brandAssets?.[brand.logoAssetId]:null;
  if(logo)references.set(`logo:${logo.id}`,{asset:logo,prefix:'logo'});
  let inputBytes=0;
  for(const {asset,prefix}of references.values()){
    if(!asset||!/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(asset.id)||!Number.isSafeInteger(asset.bytes)||asset.bytes<=0)fail('CAPACITY_ASSET_METADATA');
    const stat=await regular(path.join(project,`${prefix}-${asset.id}.bin`));if(stat.size!==asset.bytes)fail('CAPACITY_ASSET_CHANGED');
    inputBytes+=stat.size;if(inputBytes>limits.inputBytes)fail('HOSTED_INPUT_BYTES_LIMIT');
  }
  const theme=await inventory(themeSource);
  const first=gallerySelectionSnapshot(record,record.tasks.catalog.draft.products[0].id).photos,hero=first.find(photo=>photo.role==='lifestyle')??first[0],heroBytes=record.generatedAssets[hero.assetId].bytes;
  // Only the immutable verified plan is emitted; workspace history, execution
  // packets and prior choices are never copied into package or theme output.
  // Stat admission above precedes all asset loads. The assembler checks actual
  // bytes/hash plus fresh source binding before this narrower estimate is used.
  const {createBasicAssemblyBinding,prepareStoredBasicStorePackage}=await import('./basic-store-package.mjs');
  const targetStore='molyvi-still-dev.myshopify.com',prepared=await prepareStoredBasicStorePackage(store,session,{targetStore,binding:createBasicAssemblyBinding(record,{targetStore})});
  const output=estimateHostedBasicCompositionOutput({prepared,theme,heroBytes,logoBytes:logo?.bytes??0});
  if(source.bytes+output.outputBoundBytes+limits.installerReserveBytes+limits.pipelineReserveBytes+limits.metadataReserveBytes>limits.backupSourceBytes)fail('BACKUP_HEADROOM_REQUIRED');
  return {sourceBytes:source.bytes,inputBytes,maximumInputBytes:limits.inputBytes,...output,reservedInstallerBytes:limits.installerReserveBytes,reservedPipelineBytes:limits.pipelineReserveBytes,reservedMetadataBytes:limits.metadataReserveBytes,backupSourceLimit:limits.backupSourceBytes};
}
