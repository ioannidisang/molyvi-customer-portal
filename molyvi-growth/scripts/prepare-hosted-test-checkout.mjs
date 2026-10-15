import fs from 'node:fs/promises';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {PRIVATE_ROOT} from '../lib/intake-store.mjs';
import {TaskStore} from '../lib/task-store.mjs';
import {loadHostedTestPaymentConfig,createHostedTestPayments} from '../lib/hosted-test-payments.mjs';
const {values}=parseArgs({options:{out:{type:'string'}}});
if(!values.out||!/^molyvi-hosted-checkout-[a-z0-9-]+\.json$/.test(values.out))throw Error('FRESH_PRIVATE_OUTPUT_NAME_REQUIRED');
const output=path.join(PRIVATE_ROOT,values.out),file=await fs.open(output,'wx',0o600);
try{
  // Run once in the named single-instance pilot, before registering its webhook.
  // No network, mail, customer provisioning, credentials on stdout or AI execution.
  const config=await loadHostedTestPaymentConfig({enabled:true}),store=await new TaskStore(path.join(PRIVATE_ROOT,'molyvi-hosted-staging','workspaces')).ready();
  const receiver=createHostedTestPayments({store,config,notifications:{captureVerifiedPayment(){throw Error('OPERATOR_PREPARATION_ONLY');}}});
  const intent=await receiver.openIntent();await file.writeFile(JSON.stringify(intent,null,2)+'\n');await file.sync();
  console.log(JSON.stringify({status:'PREPARED_TEST_ONLY',output:values.out,projectId:intent.projectId,remainingIntents:intent.remainingIntents}));
}finally{await file.close();}
