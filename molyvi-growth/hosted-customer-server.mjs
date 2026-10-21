import {hostedBackupReadView} from './lib/hosted-backup-read-view.mjs';
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
import {loadHostedBasicInstallerActivation} from './lib/hosted-basic-installer-activation.mjs';
import {loadHostedBasicPipelinePermit,createHostedBasicPipeline} from './lib/hosted-basic-pipeline.mjs';
import {createHeavyWorkCoordinator} from './lib/heavy-work-coordinator.mjs';
import {loadHostedMemoryProbe,runHostedMemoryProbe} from './operations/r2-backup/hosted-memory-probe.mjs';
import {loadHostedGenerationProbe,runHostedGenerationProbe} from './operations/r2-backup/hosted-generation-probe.mjs';
import {runCanonicalMigrationStartup} from './operations/canonical-migration-startup.mjs';

export async function createHostedCustomerServer({publicOrigin,healthHosts=[],storage=path.join(PRIVATE_ROOT,'molyvi-hosted-staging'),transport,testPaymentConfig,controlledProConfig,photoOperationConfig,operationsConfig,catalogExtensionConfig,themeRecheckConfig,basicInstaller=null,basicPipelinePermit=null,deferBackgroundStart=false,backupReadOnly=false}={}){
  if(typeof deferBackgroundStart!=='boolean')throw Error('HOSTED_BACKGROUND_START_CONFIG');
  if(typeof backupReadOnly!=='boolean')throw Error('HOSTED_BACKUP_READ_CONFIG');
  createRequestBoundary({publicOrigin,healthHosts});
  const accounts=await new CustomerStore(path.join(storage,'accounts')).ready();let server,themeRechecks,basicPipeline;
  try{
    const workspaces=await new TaskStore(path.join(storage,'workspaces')).ready(),notifications=await new CustomerNotifications({accounts,workspaces,storage:path.join(storage,'mail'),portalUrl:publicOrigin+'/customer/',transport}).ready(),
      deliveries=await new CustomerDelivery({accounts,workspaces,storage:path.join(storage,'deliveries'),notifications}).ready();
    const testPayments=testPaymentConfig?createHostedTestPayments({store:workspaces,notifications,config:testPaymentConfig}):null;
    if([controlledProConfig,photoOperationConfig,operationsConfig,catalogExtensionConfig,themeRecheckConfig,basicInstaller].filter(Boolean).length>1)throw Error('HOSTED_STARTUP_OPERATION_EXCLUSIVE');
    if(basicPipelinePermit&&([controlledProConfig,photoOperationConfig,operationsConfig,catalogExtensionConfig,themeRecheckConfig].some(Boolean)||(basicInstaller&&basicInstaller.status().phase!=='verified')))throw Error('HOSTED_PIPELINE_OPERATION_EXCLUSIVE');
    if(basicInstaller&&['start','pause','drain','resume','stop','status'].some(k=>typeof basicInstaller[k]!=='function'))throw Error('HOSTED_INSTALLER_LIFECYCLE_INVALID');
    const controlledPro=controlledProConfig?await createHostedControlledPro({config:controlledProConfig,storage:path.join(storage,'controlled-pro'),store:workspaces,accounts}):null;
    if(photoOperationConfig){if(controlledProConfig)throw Error('HOSTED_PHOTO_OPERATION_EXCLUSIVE');await runHostedPhotoOperation({config:photoOperationConfig,store:workspaces,accounts,storage:path.join(storage,'controlled-photos')});}
    if(operationsConfig)await runHostedOperations({config:operationsConfig,store:workspaces,accounts,storage:path.join(storage,'controlled-operations')});
    if(catalogExtensionConfig)await runHostedCatalogExtension({config:catalogExtensionConfig,store:workspaces,accounts});
    // Trusted operator configuration only. No HTTP route can enqueue a job,
    // provide callbacks or broaden the fixed store/attempt binding.
    themeRechecks=themeRecheckConfig?createHostedThemeRechecks(themeRecheckConfig):null;
    let preparationPaused=false,active,interval,stopping=false,stopPromise,backupPaused=false,resourcesPaused=false,backgroundStarted=false;
    const resources=createHeavyWorkCoordinator({
      pause(){
        resourcesPaused=true;
        const worker=basicPipeline?.status().worker;
        const lease={workspace:server.pauseHeavyResources(),theme:themeRechecks?.status().lifecycle==='running',
          installer:basicInstaller?.status().lifecycle==='running',pipeline:Boolean(worker&&!worker.paused&&['idle','running','waiting'].includes(worker.lifecycle))};
        if(lease.theme)themeRechecks.pause();
        if(lease.pipeline)basicPipeline.pause();
        // An initial installer owns its entire current cycle. Pausing it before
        // completion would turn a valid installation into INITIAL_INTERRUPTED.
        if(lease.installer&&!basicInstaller.status().inFlight)basicInstaller.pause();
        return lease;
      },
      async waitOwned(lease){
        const installerIdle=(async()=>{
          while(basicInstaller?.status().inFlight)await new Promise(r=>setTimeout(r,25));
          if(lease.installer&&basicInstaller.status().lifecycle==='running')basicInstaller.pause();
        })();
        await Promise.all([lease.workspace.waitOwned(),active,installerIdle]);
      },
      async drain(lease){
        await Promise.all([lease.workspace.drain(),active,lease.theme?themeRechecks.drain():null,lease.installer?basicInstaller.drain():null,basicPipeline?.drain()]);
      },
      resume(lease){
        if(stopping)return;
        if(lease.theme&&themeRechecks.status().lifecycle==='paused')themeRechecks.resume();
        if(lease.installer&&basicInstaller.status().lifecycle==='paused')basicInstaller.resume();
        if(lease.pipeline&&basicPipeline.status().worker.lifecycle==='paused')basicPipeline.resume();
        lease.workspace.resume();resourcesPaused=false;
      }
    });
    const acquirePreparationLease=async()=>{
      if(preparationPaused)throw Error('HOSTED_PREPARATION_BUSY');
      const releaseResource=resources.acquireProduction();preparationPaused=true;
      let release;try{await active;release=await server.pauseForPreparation();}catch(e){preparationPaused=false;releaseResource();throw e;}
      let released=false;return ()=>{if(released)return;released=true;try{release();}finally{preparationPaused=false;releaseResource();}};
    };
    basicPipeline=basicPipelinePermit?await createHostedBasicPipeline({permit:basicPipelinePermit,store:workspaces,storage,acquireLease:acquirePreparationLease}):null;
    server=await createWorkspaceApp({storage:workspaces.storage,customerAccess:{accounts,notifications,deliveries,workspaces},hostedTestPayments:testPayments,hostedControlledPro:controlledPro,
      ...(basicPipeline?{basicPreparationRuntime:basicPipeline}:{basicPreparationConfig:{storage:path.join(storage,'controlled-operations','basic-preparation')}}),deployment:{publicOrigin,healthHosts}});
    const tick=()=>{if(!stopping&&!backupPaused&&!resourcesPaused&&!preparationPaused&&!active)active=notifications.tick().catch(()=>{}).finally(()=>{active=null;});};
    const startBackground=()=>{
      if(stopping||backgroundStarted)return;
      if(!server.listening||resourcesPaused)throw Error('HOSTED_BACKGROUND_START_UNAVAILABLE');
      backgroundStarted=true;
      if(transport){interval=setInterval(tick,1000);tick();}
      themeRechecks?.start();basicInstaller?.start();basicPipeline?.start();
    };
    server.on('listening',()=>{if(!deferBackgroundStart)startBackground();});
    const stop=()=>stopPromise??=(async()=>{stopping=true;server.revokeBackupReadOnly();clearInterval(interval);await resources.stop();themeRechecks?.pause();basicInstaller?.pause();server.closeIdleConnections();await Promise.all([server.drainWorkers(),themeRechecks?.stop(),basicInstaller?.stop(),basicPipeline?.stop()]);if(server.listening)await new Promise(r=>server.close(r));await active;accounts.close();})();
    server.on('close',()=>{clearInterval(interval);void themeRechecks?.stop();void basicInstaller?.stop();void basicPipeline?.stop();});
    const withBackupResources=fn=>{
      if(!server.listening)throw Error('BACKUP_APPLICATION_NOT_LISTENING');
      return resources.runBackup(fn);
    };
    const quietSnapshot=async fn=>{
      if(typeof fn!=='function')throw Error('BACKUP_SNAPSHOT_CALLBACK_REQUIRED');
      const snapshot=async()=>{
        if(backupPaused)throw Error('BACKUP_SNAPSHOT_ALREADY_ACTIVE');
        backupPaused=true;let resume,verified=false;
        try{resume=await server.pauseForBackup();await active;const value=await fn();verified=true;return value;}
        finally{
          resume?.();backupPaused=false;
          if(verified&&backupReadOnly&&!stopping&&resources.ownsBackup())server.enableBackupReadOnly();
        }
      };
      return resources.ownsBackup()?snapshot():withBackupResources(snapshot);
    };
    return {server,accounts,workspaces,notifications,deliveries,testPayments,themeRechecks,basicInstaller,basicPipeline,stop,quietSnapshot,withBackupResources,resourceStatus:resources.status,startBackground};
  }catch(e){await themeRechecks?.stop();await basicInstaller?.stop();await basicPipeline?.stop();accounts.close();throw e;}
}

// Private startup wiring only: no HTTP caller supplies the permit or callback.
// The probe must request its resource lease synchronously. A signal closes
// admission before awaiting the body, including its final preservation checks.
export function createHostedStartupLifecycle({app,backups=null,probeConfig=null,runProbe=runHostedMemoryProbe,onBlocked=()=>{}}={}){
  if(typeof app?.stop!=='function'||typeof app?.startBackground!=='function'||typeof runProbe!=='function'||typeof onBlocked!=='function')throw Error('HOSTED_STARTUP_LIFECYCLE_CONFIG');
  let started=false,stopping=false,phase='waiting',pending=null,stopPromise=null,lastCode=null;
  const status=()=>({started,stopping,phase,lastCode});
  const blocked=error=>{
    phase=stopping?'stopping':'blocked';
    lastCode=/^[A-Z][A-Z0-9_]{2,99}$/.test(error?.message??'')?error.message:'HOSTED_MEMORY_PROBE_BLOCKED';
    try{onBlocked(lastCode);}catch{}
    return status();
  };
  const start=()=>{
    if(started||stopping)return pending??Promise.resolve(status());
    started=true;
    if(!probeConfig){
      try{backups?.start();phase='running';pending=Promise.resolve(status());}
      catch(error){pending=Promise.resolve(blocked(error));}
      return pending;
    }
    phase='probe';
    let operation;
    try{operation=runProbe({app,config:probeConfig});}
    catch(error){pending=Promise.resolve(blocked(error));return pending;}
    pending=Promise.resolve(operation).then(receipt=>{
      if(stopping){phase='stopping';return status();}
      if(!['PASS','SKIP_VERIFIED_PASS'].includes(receipt?.status)||receipt.allowAutomaticStart!==true)throw Error('HOSTED_MEMORY_PROBE_NOT_VERIFIED');
      app.startBackground();
      if(!stopping)backups?.start();
      phase=stopping?'stopping':'running';return status();
    }).catch(blocked);
    return pending;
  };
  const stop=()=>{
    stopping=true;phase='stopping';
    if(stopPromise)return stopPromise;
    // Invoke both stop methods now, before waiting for either one.
    const invoke=fn=>{try{return Promise.resolve(fn());}catch(error){return Promise.reject(error);}};
    const operations=[invoke(()=>app.stop()),invoke(()=>backups?.stop()),pending].filter(Boolean);
    return stopPromise=Promise.allSettled(operations).then(results=>{
      phase='stopped';
      const failure=results.find(result=>result.status==='rejected');if(failure)throw failure.reason;
      return status();
    });
  };
  return Object.freeze({start,stop,status});
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.env.MOLYVI_HOSTED_ENABLED!=='true')throw Error('HOSTED_ACTIVATION_REQUIRED');
  const backupReadOnly=hostedBackupReadView(process.env.MOLYVI_BACKUP_READ_ONLY_ENABLED);
  for(const flag of ['MOLYVI_PAYMENT_RECEIVER_ENABLED','MOLYVI_AI_WORKERS_ENABLED','MOLYVI_BACKUP_UPLOAD_ENABLED'])if(process.env[flag]==='true')throw Error('HOSTED_STAGING_SCOPE_REQUIRED');
  const port=Number(process.env.PORT??10000);if(!Number.isInteger(port)||port<1||port>65535||[18012,18013,19099].includes(port))throw Error('INVALID_PORT');
  const storage=process.env.MOLYVI_PRIVATE_STORAGE??path.join(PRIVATE_ROOT,'molyvi-hosted-staging');let transport;
  await runCanonicalMigrationStartup({source:storage,controlRoot:'/opt/render/project/src/briefs/molyvi-canonical-migration-20261020-r1',release:process.env.RENDER_GIT_COMMIT,serviceId:process.env.RENDER_SERVICE_ID});
  const probeRoot='/opt/render/project/src/briefs/molyvi-r2-memory-probe-20261020-r1';
  const legacyProbeConfig=await loadHostedMemoryProbe({permitFile:path.join(probeRoot,'permit.json'),source:storage,probeRoot,release:process.env.RENDER_GIT_COMMIT,serviceId:process.env.RENDER_SERVICE_ID});
  const generationProbeRoot='/opt/render/project/src/briefs/molyvi-generation-memory-probe-20261020-r1';
  const generationProbeConfig=await loadHostedGenerationProbe({permitFile:path.join(generationProbeRoot,'permit.json'),source:storage,probeRoot:generationProbeRoot,release:process.env.RENDER_GIT_COMMIT,serviceId:process.env.RENDER_SERVICE_ID});
  // A distinct one-use proof; completed historical probes are never rearmed.
  const combinedProbeRoot='/opt/render/project/src/briefs/molyvi-generation-combined-probe-20261021-r1';
  const combinedProbeConfig=await loadHostedGenerationProbe({permitFile:path.join(combinedProbeRoot,'permit.json'),source:storage,probeRoot:combinedProbeRoot,release:process.env.RENDER_GIT_COMMIT,serviceId:process.env.RENDER_SERVICE_ID});
  if([legacyProbeConfig,generationProbeConfig,combinedProbeConfig].filter(Boolean).length>1)throw Error('HOSTED_MULTIPLE_PROBES_FORBIDDEN');
  const probeConfig=combinedProbeConfig??generationProbeConfig??legacyProbeConfig;
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
  let themeRecheckConfig,themeRecheckStartupBlocked=false,basicInstaller=null,basicInstallerStartupBlocked=false,basicPipelinePermit=null,basicPipelineStartupBlocked=false;
  try{basicPipelinePermit=await loadHostedBasicPipelinePermit();}catch{basicPipelineStartupBlocked=true;console.error('MOLYVI_BASIC_PIPELINE_STARTUP_BLOCKED');}
  try{basicInstaller=await loadHostedBasicInstallerActivation();}catch{basicInstallerStartupBlocked=true;console.error('MOLYVI_BASIC_INSTALLER_STARTUP_BLOCKED');}
  // An explicit real permit never falls back to the historical synthetic job.
  if(!basicInstaller&&!basicInstallerStartupBlocked&&!basicPipelinePermit&&!basicPipelineStartupBlocked)try{themeRecheckConfig=await loadHostedThemeRecheckActivation();}catch{themeRecheckStartupBlocked=true;console.error('MOLYVI_THEME_RECHECK_STARTUP_BLOCKED');}
  if(probeConfig&&([controlledProConfig,photoOperationConfig,operationsConfig,catalogExtensionConfig,themeRecheckConfig].some(Boolean)||(basicInstaller&&basicInstaller.status().phase!=='verified')||basicPipelineStartupBlocked||basicInstallerStartupBlocked||themeRecheckStartupBlocked))throw Error('HOSTED_MEMORY_PROBE_STARTUP_NOT_SETTLED');
  const app=await createHostedCustomerServer({publicOrigin:process.env.MOLYVI_PORTAL_ORIGIN??process.env.RENDER_EXTERNAL_URL,healthHosts:(process.env.MOLYVI_HEALTH_HOSTS??'').split(',').filter(Boolean),storage,transport,testPaymentConfig,controlledProConfig,photoOperationConfig,operationsConfig,catalogExtensionConfig,themeRecheckConfig,basicInstaller,basicPipelinePermit,deferBackgroundStart:Boolean(probeConfig),backupReadOnly:backupReadOnly||Boolean(combinedProbeConfig)});
  await fs.writeFile(path.join(storage,'hosted-scope.json'),JSON.stringify({mode:'hosted_staging',realEmailEnabled:Boolean(transport),testPaymentsEnabled:Boolean(app.testPayments),controlledLocalProEnabled:Boolean(controlledProConfig),photoStartupOperationEnabled:Boolean(photoOperationConfig),operationsStartupEnabled:Boolean(operationsConfig),catalogExtensionEnabled:Boolean(catalogExtensionConfig),themeRecheckProbeConfigured:Boolean(themeRecheckConfig),themeRecheckStartupBlocked,shopifyInstallerWorkerEnabled:Boolean(basicInstaller),basicInstallerStartupBlocked,basicPipelineConfigured:Boolean(app.basicPipeline),basicPipelineStartupBlocked,aiWorkersEnabled:false,realPaymentsEnabled:false,cloudArchiveActive:false})+'\n',{mode:0o600});
  let backups;
  try{backups=await createAutomaticBackups({storage,release:process.env.RENDER_GIT_COMMIT,quietSnapshot:app.quietSnapshot,withBackupResources:app.withBackupResources,transport});}
  catch{
    console.error('MOLYVI_AUTOMATIC_BACKUP_STARTUP_BLOCKED');
    if(probeConfig){await app.stop();throw Error('HOSTED_MEMORY_PROBE_AUTOMATIC_SETUP_FAILED');}
    await reportBackupStartupFailure(transport);
  }
  const startup=createHostedStartupLifecycle({app,backups,probeConfig,runProbe:(generationProbeConfig||combinedProbeConfig)?runHostedGenerationProbe:runHostedMemoryProbe,onBlocked:code=>console.error(code)});
  const shutdown=()=>{void startup.stop().then(()=>process.exit(0),()=>{console.error('MOLYVI_HOSTED_SHUTDOWN_FAILED');process.exit(1);});};
  process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
  if(probeConfig)app.server.prependOnceListener('listening',()=>{void startup.start();});
  else app.server.once('listening',()=>{void startup.start();});
  app.server.listen(port,'0.0.0.0',()=>console.log(JSON.stringify({status:'ready',mode:'hosted_staging',port,realEmailEnabled:Boolean(transport)})));
}
