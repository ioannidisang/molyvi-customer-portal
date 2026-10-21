import test from 'node:test';import assert from 'node:assert/strict';
import {planBudgetWait,validateBudgetWait} from './budget-wait.mjs';
const t=Date.parse('2026-10-15T15:20:30.623Z'),row={id:1,at:t,requests:37,uploadBytes:1075392821,downloadBytes:1075392821};
test('first and second measured generations fit; third waits for real rolling expiry without crediting old reservations',()=>{
 const entries=[row],demand={requests:25,uploadBytes:352651970,downloadBytes:352651970};
 assert.equal(planBudgetWait({entries,demand,now:Date.parse('2026-10-25T01:00Z')}),null);
 entries.push({id:2,at:Date.parse('2026-10-25T01:00Z'),...demand});
 const next={requests:22,uploadBytes:78261,downloadBytes:352651970};
 assert.equal(planBudgetWait({entries,demand:next,now:Date.parse('2026-11-01T01:00Z')}),null);
 entries.push({id:3,at:Date.parse('2026-11-01T01:00Z'),...next});const before=JSON.stringify(entries);
 const wait=planBudgetWait({entries,demand:next,now:Date.parse('2026-11-08T01:00Z')});
 assert.equal(wait.notBefore,t+31*86400000+60000);assert.deepEqual(wait.blockedBy,['downloadBytes']);assert.equal(JSON.stringify(entries),before);
 assert.equal(wait.providerCalls,0);assert.equal(wait.reservationsCreated,0);
});
test('additional usage changes the next review; impossible demand and future/duplicate rows fail closed',()=>{
 assert.throws(()=>planBudgetWait({entries:[row],demand:{requests:201,uploadBytes:0,downloadBytes:0},now:t}),/DEMAND/);
 assert.throws(()=>planBudgetWait({entries:[row],demand:{requests:1,uploadBytes:0,downloadBytes:0},now:t-1}),/LEDGER/);
 assert.throws(()=>planBudgetWait({entries:[row,row],demand:{requests:1,uploadBytes:0,downloadBytes:0},now:t}),/LEDGER/);
 const entries=[row,{...row,id:2,at:t+86400000,requests:0,uploadBytes:0,downloadBytes:900000000}];
 const wait=planBudgetWait({entries,demand:{requests:1,uploadBytes:1,downloadBytes:1500000000},now:t+86400000});
 assert.equal(wait.notBefore,t+32*86400000+60000);
});
test('automatic waiting requires no provider, reservation or unsettled scratch and a bounded future date',()=>{
 const w=planBudgetWait({entries:[row],demand:{requests:1,uploadBytes:0,downloadBytes:1000000000},now:t});
 const good={...w,catalogUnchanged:true,scratchCleaned:true};assert.equal(validateBudgetWait(good,t),good);
 for(const extra of [{providerCalls:1},{reservationsCreated:1},{scratchCleaned:false},{catalogUnchanged:false},{notBefore:t}])assert.throws(()=>validateBudgetWait({...good,...extra},t),/INVALID/);
});
