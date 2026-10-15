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

export async function createHostedCustomerServer({publicOrigin,healthHosts=[],storage=path.join(PRIVATE_ROOT,'molyvi-hosted-staging'),transport}={}){
  createRequestBoundary({publicOrigin,healthHosts});
  const accounts=await new CustomerStore(path.join(storage,'accounts')).ready();let server;
  try{
    const workspaces=await new TaskStore(path.join(storage,'workspaces')).ready(),notifications=await new CustomerNotifications({accounts,workspaces,storage:path.join(storage,'mail'),portalUrl:publicOrigin+'/customer/',transport}).ready(),
      deliveries=await new CustomerDelivery({accounts,workspaces,storage:path.join(storage,'deliveries'),notifications}).ready();
    server=await createWorkspaceApp({storage:workspaces.storage,customerAccess:{accounts,notifications,deliveries},deployment:{publicOrigin,healthHosts}});
    let interval,stopping=false,active,stopPromise,backupPaused=false;
    const tick=()=>{if(!stopping&&!backupPaused&&!active)active=notifications.tick().catch(()=>{}).finally(()=>{active=null;});};
    server.on('listening',()=>{if(transport){interval=setInterval(tick,1000);tick();}});
    const stop=()=>stopPromise??=(async()=>{stopping=true;clearInterval(interval);server.closeIdleConnections();await server.drainWorkers();if(server.listening)await new Promise(r=>server.close(r));await active;accounts.close();})();
    server.on('close',()=>{clearInterval(interval);});
    const quietSnapshot=async fn=>{backupPaused=true;let resume;try{resume=await server.pauseForBackup();await active;return await fn();}finally{resume?.();backupPaused=false;}};
    return {server,accounts,workspaces,notifications,deliveries,stop,quietSnapshot};
  }catch(e){accounts.close();throw e;}
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
  const app=await createHostedCustomerServer({publicOrigin:process.env.MOLYVI_PORTAL_ORIGIN??process.env.RENDER_EXTERNAL_URL,healthHosts:(process.env.MOLYVI_HEALTH_HOSTS??'').split(',').filter(Boolean),storage,transport});
  await fs.writeFile(path.join(storage,'hosted-scope.json'),JSON.stringify({mode:'hosted_staging',realEmailEnabled:Boolean(transport),aiWorkersEnabled:false,realPaymentsEnabled:false,cloudArchiveActive:false})+'\n',{mode:0o600});
  let backups;
  try{backups=await createAutomaticBackups({storage,release:process.env.RENDER_GIT_COMMIT,quietSnapshot:app.quietSnapshot,transport});}
  catch{console.error('MOLYVI_AUTOMATIC_BACKUP_STARTUP_BLOCKED');await reportBackupStartupFailure(transport);}
  app.server.listen(port,'0.0.0.0',()=>console.log(JSON.stringify({status:'ready',mode:'hosted_staging',port,realEmailEnabled:Boolean(transport)})));
  app.server.once('listening',()=>backups?.start());
  const shutdown=()=>{void (async()=>{await backups?.stop();await app.stop();process.exit(0);})();};process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
}
