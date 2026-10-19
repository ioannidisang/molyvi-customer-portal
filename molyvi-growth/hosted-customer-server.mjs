import path from 'node:path';
import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {PRIVATE_ROOT} from './lib/intake-store.mjs';
import {CustomerStore} from './lib/customer-store.mjs';
import {TaskStore} from './lib/task-store.mjs';
import {CustomerDelivery} from './lib/customer-delivery.mjs';
import {CustomerNotifications} from './lib/customer-notifications.mjs';
import {GmailMailTransport} from './lib/gmail-mail-transport.mjs';
import {createGoogleMailTokenProvider} from './lib/google-mail-token-provider.mjs';
import {createWorkspaceApp} from './paid-workspace-server.mjs';
import {createRequestBoundary} from './lib/hosted-request-boundary.mjs';
import {createAutomaticBackups,reportBackupStartupFailure} from './operations/r2-backup/automatic.mjs';
import {createHostedTestPayments,loadHostedTestPaymentConfig} from './lib/hosted-test-payments.mjs';
import {createHostedControlledPro,loadHostedControlledProConfig} from './lib/hosted-controlled-pro.mjs';
import {loadHostedPhotoConfig,runHostedPhotoOperation} from './lib/hosted-photo-operation.mjs';
import {loadHostedOperationsConfig,runHostedOperations} from './lib/hosted-service-operations.mjs';
import {loadHostedCatalogConfig,runHostedCatalogExtension} from './lib/hosted-catalog-extension.mjs';
import {createHostedThemeRechecks} from './lib/hosted-theme-rechecks.mjs';
import {loadHostedThemeRecheckActivation} from './lib/hosted-theme-recheck-activation.mjs';

export async function createHostedCustomerServer({publicOrigin,healthHosts=[],storage=path.join(PRIVATE_ROOT,'molyvi-hosted-staging'),transport,testPaymentConfig,controlledProConfig,photoOperationConfig,operationsConfig,catalogExtensionConfig,themeRecheckConfig}={}){
  createRequestBoundary({publicOrigin,healthHosts});
  const accounts=await new CustomerStore(path.join(storage,'accounts')).ready();let server,themeRechecks;
  try{
    const workspaces=await new TaskStore(path.join(storage,'workspaces')).ready(),notifications=await new CustomerNotifications({accounts,workspaces,storage:path.join(storage,'mail'),portalUrl:publicOrigin+'/customer/',transport}).ready(),
      deliveries=await new CustomerDelivery({accounts,workspaces,storage:path.join(storage,'deliveries'),notifications}).ready();
    const testPayments=testPaymentConfig?createHostedTestPayments({store:workspaces,notifications,config:testPaymentConfig}):null;
    if([controlledProConfig,photoOperationConfig,operationsConfig,catalogExtensionConfig,themeRecheckConfig].filter(Boolean).length>1)throw Error('HOSTED_STARTUP_OPERATION_EXCLUSIVE');
    const controlledPro=controlledProConfig?await createHostedControlledPro({config:controlledProConfig,storage:path.join(storage,'controlled-pro'),store:workspaces,accounts}):null;
    if(photoOperationConfig){if(controlledProConfig)throw Error('HOSTED_PHOTO_OPERATION_EXCLUSIVE');await runHostedPhotoOperation({config:photoOperationConfig,store:workspaces,accounts,storage:path.join(storage,'controlled-photos')});}
    if(operationsConfig)await runHostedOperations({config:operationsConfig,store:workspaces,accounts,storage:path.join(storage,'controlled-operations')});
    if(catalogExtensionConfig)await runHostedCatalogExtension({config:catalogExtensionConfig,store:workspaces,accounts});
    // Trusted operator configuration only. No HTTP route can enqueue a job,
    // provide callbacks or broaden the fixed store/attempt binding.
    themeRechecks=themeRecheckConfig?createHostedThemeRechecks(themeRecheckConfig):null;
    server=await createWorkspaceApp({storage:workspaces.storage,customerAccess:{accounts,notifications,deliveries,workspaces},hostedTestPayments:testPayments,hostedControlledPro:controlledPro,deployment:{publicOrigin,healthHosts}});
    let interval,stopping=false,active,stopPromise,backupPaused=false;
    const tick=()=>{if(!stopping&&!backupPaused&&!active)active=notifications.tick().catch(()=>{}).finally(()=>{active=null;});};
    server.on('listening',()=>{if(transport){interval=setInterval(tick,1000);tick();}themeRechecks?.start();});
    const stop=()=>stopPromise??=(async()=>{stopping=true;clearInterval(interval);themeRechecks?.pause();server.closeIdleConnections();await Promise.all([server.drainWorkers(),themeRechecks?.stop()]);if(server.listening)await new Promise(r=>server.close(r));await active;accounts.close();})();
    server.on('close',()=>{clearInterval(interval);void themeRechecks?.stop();});
    const quietSnapshot=async fn=>{backupPaused=true;themeRechecks?.pause();let resume;try{resume=await server.pauseForBackup();await Promise.all([active,themeRechecks?.drain()]);return await fn();}finally{resume?.();backupPaused=false;if(!stopping&&themeRechecks?.status().lifecycle==='paused')themeRechecks.resume();}};
    return {server,accounts,workspaces,notifications,deliveries,testPayments,themeRechecks,stop,quietSnapshot};
  }catch(e){await themeRechecks?.stop();accounts.close();throw e;}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.env.MOLYVI_HOSTED_ENABLED!=='true')throw Error('HOSTED_ACTIVATION_REQUIRED');
  for(const flag of ['MOLYVI_PAYMENT_RECEIVER_ENABLED','MOLYVI_AI_WORKERS_ENABLED','MOLYVI_BACKUP_UPLOAD_ENABLED'])if(process.env[flag]==='true')throw Error('HOSTED_STAGING_SCOPE_REQUIRED');
  const port=Number(process.env.PORT??10000);if(!Number.isInteger(port)||port<1||port>65535||[18012,18013,19099].includes(port))throw Error('INVALID_PORT');
  const storage=process.env.MOLYVI_PRIVATE_STORAGE??path.join(PRIVATE_ROOT,'molyvi-hosted-staging');let transport;
  if(process.env.MOLYVI_REAL_EMAIL_ENABLED==='true'){
    if(process.env.MOLYVI_GMAIL_ACCOUNT_VERIFIED!=='true')throw Error('GMAIL_ACCOUNT_VERIFICATION_REQUIRED');
    const getAccessToken=createGoogleMailTokenProvider({clientId:process.env.MOLYVI_GOOGLE_CLIENT_ID,clientSecret:process.env.MOLYVI_GOOGLE_CLIENT_SECRET,refreshToken:process.env.MOLYVI_GOOGLE_REFRESH_TOKEN});
    transport=await new GmailMailTransport({storage:path.join(storage,'gmail-journal'),enabled:true,accountVerified:true,getAccessToken,
      approvedRecipients:[process.env.MOLYVI_GMAIL_APPROVED_TEST_RECIPIENT].filter(Boolean)}).ready();
    await getAccessToken(); // Refuse startup if the grant belongs to another mailbox.
  }
  const testPaymentConfig=await loadHostedTestPaymentConfig({enabled:process.env.MOLYVI_HOSTED_TEST_PAYMENTS_ENABLED==='true'});
  const controlledProConfig=await loadHostedControlledProConfig({enabled:process.env.MOLYVI_HOSTED_CONTROLLED_PRO_ENABLED==='true'});
  const photoOperationConfig=await loadHostedPhotoConfig({enabled:process.env.MOLYVI_HOSTED_PHOTO_IMPORT_ENABLED==='true'});
  const operationsConfig=await loadHostedOperationsConfig({enabled:process.env.MOLYVI_HOSTED_OPERATIONS_ENABLED==='true'});
  const catalogExtensionConfig=await loadHostedCatalogConfig({enabled:process.env.MOLYVI_HOSTED_CATALOG_EXTENSION_ENABLED==='true'});
  let themeRecheckConfig,themeRecheckStartupBlocked=false;
  try{themeRecheckConfig=await loadHostedThemeRecheckActivation();}catch{themeRecheckStartupBlocked=true;console.error('MOLYVI_THEME_RECHECK_STARTUP_BLOCKED');}
  const app=await createHostedCustomerServer({publicOrigin:process.env.MOLYVI_PORTAL_ORIGIN??process.env.RENDER_EXTERNAL_URL,healthHosts:(process.env.MOLYVI_HEALTH_HOSTS??'').split(',').filter(Boolean),storage,transport,testPaymentConfig,controlledProConfig,photoOperationConfig,operationsConfig,catalogExtensionConfig,themeRecheckConfig});
  await fs.writeFile(path.join(storage,'hosted-scope.json'),JSON.stringify({mode:'hosted_staging',realEmailEnabled:Boolean(transport),testPaymentsEnabled:Boolean(app.testPayments),controlledLocalProEnabled:Boolean(controlledProConfig),photoStartupOperationEnabled:Boolean(photoOperationConfig),operationsStartupEnabled:Boolean(operationsConfig),catalogExtensionEnabled:Boolean(catalogExtensionConfig),themeRecheckProbeConfigured:Boolean(themeRecheckConfig),themeRecheckStartupBlocked,shopifyInstallerWorkerEnabled:false,aiWorkersEnabled:false,realPaymentsEnabled:false,cloudArchiveActive:false})+'\n',{mode:0o600});
  let backups;
  try{backups=await createAutomaticBackups({storage,release:process.env.RENDER_GIT_COMMIT,quietSnapshot:app.quietSnapshot,transport});}
  catch{console.error('MOLYVI_AUTOMATIC_BACKUP_STARTUP_BLOCKED');await reportBackupStartupFailure(transport);}
  app.server.listen(port,'0.0.0.0',()=>console.log(JSON.stringify({status:'ready',mode:'hosted_staging',port,realEmailEnabled:Boolean(transport)})));
  app.server.once('listening',()=>backups?.start());
  const shutdown=()=>{void (async()=>{await backups?.stop();await app.stop();process.exit(0);})();};process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
}
