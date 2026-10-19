// Bounded operator commands for one explicitly approved synthetic Draft package.
// Neither credentials nor staged URLs are emitted. Never resets an existing run.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
try{
  const args=process.argv.slice(2),[command,arg]=args;let result;
  if(command==='--inspect'){
    if(args.length!==1)throw Error('OPERATOR_ARGUMENTS_INVALID');
    // Inspect through the existing passive snapshot reader. Loading the worker
    // would acquire journal writer locks and could interrupt an active install.
    // This branch imports no installer/access module and never reads a token.
    const {collectHostedBasicInstallation}=await import('./read-hosted-basic-installation.mjs');
    result=await collectHostedBasicInstallation();
    console.log(JSON.stringify({marker:'MOLYVI_REAL_INSTALLER',result}));
  }else{
  const {PRIVATE_ROOT,canonicalJson}=await import('../lib/intake-store.mjs');
  const {createReceiver,acceptEnvelope,readExactToken,HOSTED_BASIC_INSTALLER_ACCESS_ROOT}=await import('../lib/hosted-basic-installer-access.mjs');
const sha=x=>crypto.createHash('sha256').update(x).digest('hex'),hash=x=>sha(canonicalJson(x));
const fixture=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../qa/hosted-installer-20261019');
const proposal=JSON.parse(await fs.readFile(path.join(fixture,'proposal.json'),'utf8'));
if(process.env.RENDER_SERVICE_ID!=='srv-db7othjrjlhs73cg7lf0'||proposal.jobId!=='9e1bfcc0-1f1c-41f2-a369-1ad65b0fad9a'||proposal.projectId!=='6018a065-af86-4e4b-8f67-730e1adb3519'||proposal.packageSha256!=='2a1a942a0083f9f8160611f5c004d75229cdb222a3887f5e09052b21db244431')throw Error('EXACT_TEST_SCOPE_REQUIRED');
const common={runId:proposal.jobId,packageSha256:proposal.packageSha256};
const write=async(file,value)=>fs.writeFile(file,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
const receiver=async()=>JSON.parse(await fs.readFile(path.join(HOSTED_BASIC_INSTALLER_ACCESS_ROOT,proposal.jobId,'receiver.json'),'utf8'));
async function safeDirectory(dir){const absolute=path.resolve(dir);let current=path.parse(absolute).root;for(const bit of absolute.slice(current.length).split(path.sep).filter(Boolean)){current=path.join(current,bit);const s=await fs.lstat(current);if(!s.isDirectory()||s.isSymbolicLink())throw Error('UNSAFE_INPUT_DIRECTORY');}if(await fs.realpath(absolute)!==absolute)throw Error('UNSAFE_INPUT_DIRECTORY');}
  if(command==='--receiver'&&!arg)result=await createReceiver(common);
  else if(command==='--accept'&&arg&&arg.length<24000){
    const record=await receiver(),envelope=JSON.parse(Buffer.from(arg,'base64').toString('utf8'));
    result=await acceptEnvelope({...common,receiverSha256:record.receiverSha256,envelope});
  }else if(command==='--prepare-and-arm'&&!arg){
    const {prepareHostedBasicInstallation,HOSTED_BASIC_INSTALLER_ACTIVATION_FILE}=await import('../lib/hosted-basic-installer.mjs');
    try{await fs.lstat(HOSTED_BASIC_INSTALLER_ACTIVATION_FILE);throw Error('ALREADY_ACTIVATED');}catch(e){if(e.code!=='ENOENT')throw e;}
    const rec=await receiver(),token=await readExactToken({...common,receiverSha256:rec.receiverSha256});
    const {inventory}=await import('../operations/r2-backup/backup.mjs');
    const sourceFiles=await inventory(path.join(PRIVATE_ROOT,'molyvi-hosted-staging'),{skipSqliteSidecars:true}),sourceBytes=sourceFiles.reduce((n,x)=>n+x.bytes,0);
    if(sourceBytes+10*1024*1024>512000000)throw Error('BACKUP_HEADROOM_REQUIRED');
    const query='query MolyviHostedInstallerIdentity { shop { id myshopifyDomain currencyCode } currentAppInstallation { id app { id } accessScopes { handle } } themes(first:2,roles:[MAIN]) { nodes { id role } pageInfo { hasNextPage } } location(id:"gid://shopify/Location/125398417745") { id isActive fulfillsOnlineOrders } }';
    const response=await fetch('https://molyvi-still-dev.myshopify.com/admin/api/2026-10/graphql.json',{method:'POST',redirect:'error',signal:AbortSignal.timeout(30000),headers:{'Content-Type':'application/json','X-Shopify-Access-Token':token.accessToken},body:JSON.stringify({query})});
    if(!response.ok||response.redirected||!response.body?.getReader)throw Error('IDENTITY_HTTP_FAILED');const reader=response.body.getReader(),parts=[];let size=0;try{for(;;){const r=await reader.read();if(r.done)break;if((size+=r.value.byteLength)>32768)throw Error('IDENTITY_LIMIT');parts.push(Buffer.from(r.value));}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}const json=JSON.parse(Buffer.concat(parts).toString('utf8')),d=json.data;
    const scopes=['read_files','read_inventory','read_locations','read_online_store_pages','read_products','read_publications','read_themes','write_files','write_online_store_pages','write_products','write_themes'];
    if(json.errors||d?.shop?.id!=='gid://shopify/Shop/108668748113'||d.shop.myshopifyDomain!==proposal.targetStore||d.shop.currencyCode!=='EUR'||d.currentAppInstallation?.id!=='gid://shopify/AppInstallation/1195450433873'||d.currentAppInstallation.app?.id!=='gid://shopify/App/436878311425'||canonicalJson(d.currentAppInstallation.accessScopes.map(s=>s.handle).sort())!==canonicalJson(scopes)||d.themes?.nodes?.length!==1||d.themes.nodes[0].id!=='gid://shopify/OnlineStoreTheme/207379235153'||d.themes.nodes[0].role!=='MAIN'||d.themes.pageInfo.hasNextPage||d.location?.id!=='gid://shopify/Location/125398417745'||!d.location.isActive||!d.location.fulfillsOnlineOrders)throw Error('IDENTITY_MISMATCH');
    const bytes=await fs.readFile(path.join(fixture,'bundle.json'));if(sha(bytes)!==proposal.packageSha256)throw Error('BUNDLE_CHANGED');
    await safeDirectory(PRIVATE_ROOT);const privateInput=path.join(PRIVATE_ROOT,'molyvi-basic-installer-input');try{await fs.mkdir(privateInput,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}await safeDirectory(privateInput);const inputFile=path.join(privateInput,proposal.jobId+'.json');await fs.writeFile(inputFile,bytes,{flag:'wx',mode:0o600});
    const observedAt=new Date().toISOString(),preflight={observedAt,identity:d,sourceBytes,sourceFiles:sourceFiles.length,backupHeadroomBytes:512000000-sourceBytes,additionalRequests:1,newRights:false};
    result=await prepareHostedBasicInstallation({bundleFile:inputFile,bundleSha256:proposal.packageSha256,jobId:proposal.jobId,authorizationSha256:proposal.authorizationSha256,operatorId:'molyvi-authorized-draft-test-20261019',preflightEvidence:{operatorId:'molyvi-authorized-draft-test-20261019',evidenceSha256:hash(preflight),observedAt,scopeConfirmed:true}});
    await write(path.join(path.dirname(result.configFile),'fresh-preflight.json'),preflight);
    await write(HOSTED_BASIC_INSTALLER_ACTIVATION_FILE,{schemaVersion:1,mode:'real_basic_draft_test',jobId:proposal.jobId,projectId:proposal.projectId,packageSha256:proposal.packageSha256,configSha256:result.configSha256,receiverSha256:rec.receiverSha256});
    result={...result,armed:true,shopifyRequests:1,shopifyWrites:0,sourceBytes,publication:false,newCharges:false};
  }else throw Error('OPERATOR_ARGUMENTS_INVALID');
  console.log(JSON.stringify({marker:'MOLYVI_REAL_INSTALLER',result}));
  }
}catch(e){const code=typeof e.code==='string'&&/^[A-Z][A-Z0-9_]{2,120}$/.test(e.code)?e.code:typeof e.message==='string'&&/^[A-Z][A-Z0-9_]{2,120}$/.test(e.message)?e.message:'OPERATOR_STOPPED';console.log(JSON.stringify({marker:'MOLYVI_REAL_INSTALLER',status:'STOP',code}));process.exitCode=1;}
