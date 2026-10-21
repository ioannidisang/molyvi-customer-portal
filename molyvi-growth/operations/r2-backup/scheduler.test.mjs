import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {BackupScheduler,nextWeekly} from './scheduler.mjs';

async function fixture(t,options){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'molyvi-schedule-'));
  const file=path.join(dir,'schedule.sqlite');let scheduler;
  t.after(async()=>{if(scheduler?.db)await scheduler.stop();const real=await fs.realpath(dir);assert.equal(path.dirname(real),await fs.realpath(os.tmpdir()));await fs.rm(real,{recursive:true});});
  scheduler=await new BackupScheduler({file,firstAt:1,...options}).ready();return {scheduler,file};
}
test('weekly UTC boundary handles Sunday and DST dates without catch-up bursts',()=>{
  assert.equal(new Date(nextWeekly(Date.parse('2026-10-15T12:00Z'))).toISOString(),'2026-10-18T01:00:00.000Z');
  assert.equal(new Date(nextWeekly(Date.parse('2026-10-18T01:00Z'))).toISOString(),'2026-10-25T01:00:00.000Z');
});
test('concurrent ticks execute once; restart preserves next run and result',async t=>{
  let runs=0,now=Date.parse('2026-10-15T12:00Z'),release;
  const {scheduler,file}=await fixture(t,{now:()=>now,perform:async()=>{runs++;await new Promise(r=>release=r);return {status:'PASS',bytes:203};}});
  const a=scheduler.tick(),b=scheduler.tick();assert.equal(a,b);release();await a;assert.equal(runs,1);
  const previous=scheduler.status();await scheduler.stop();
  const restarted=await new BackupScheduler({file,firstAt:1,now:()=>now,perform:async()=>{runs++;return {};}}).ready();
  try{await restarted.tick();assert.equal(runs,1);assert.deepEqual(restarted.status(),previous);now=Date.parse('2026-11-15T12:00Z');await restarted.tick();assert.equal(runs,2);assert.ok(restarted.status().next_at>now);}finally{await restarted.stop();}
});
test('budget error pauses permanently and sends one alert across restart',async t=>{
  let runs=0,alerts=0;
  const {scheduler,file}=await fixture(t,{perform:async()=>{runs++;throw Error('R2_BUDGET_STOP_STORAGE');},notify:async()=>{alerts++;}});
  await scheduler.tick();await scheduler.tick();assert.equal(runs,1);assert.equal(alerts,1);assert.equal(scheduler.status().status,'paused');await scheduler.stop();
  const restarted=await new BackupScheduler({file,firstAt:1,perform:async()=>runs++,notify:async()=>alerts++}).ready();
  try{await restarted.tick();assert.equal(runs,1);assert.equal(alerts,1);}finally{await restarted.stop();}
});
test('unexpected service root remains paused after a repaired implementation restarts without another attempt or alert',async t=>{
  let attempts=0,now=Date.parse('2026-10-18T01:00:00Z');const alerts=[];
  const {scheduler,file}=await fixture(t,{now:()=>now,perform:async()=>{attempts++;throw Error('UNEXPECTED_SERVICE_ROOT');},notify:async alert=>{alerts.push(alert);}});
  await scheduler.tick();await scheduler.tick();const stopped=scheduler.status();
  assert.equal(attempts,1);assert.equal(alerts.length,1);assert.equal(alerts[0].code,'UNEXPECTED_SERVICE_ROOT');
  assert.equal(stopped.status,'paused');assert.equal(stopped.error,'UNEXPECTED_SERVICE_ROOT');assert.equal(stopped.alert_status,'accepted');
  await scheduler.stop();now=Date.parse('2026-10-25T01:01:00Z');
  // Fixing snapshot scope must not implicitly authorize replay of a paused run.
  const restarted=await new BackupScheduler({file,firstAt:1,now:()=>now,perform:async()=>{attempts++;return {status:'PASS'};},notify:async alert=>{alerts.push(alert);}}).ready();
  try{await restarted.tick();await restarted.tick();assert.deepEqual(restarted.status(),stopped);assert.equal(attempts,1);assert.equal(alerts.length,1);}finally{await restarted.stop();}
});
test('interrupted attempt never replays on restart and alert uncertainty never repeats',async t=>{
  const {scheduler,file}=await fixture(t,{perform:async()=>assert.fail('replayed')});
  scheduler.db.prepare("UPDATE schedule SET status='running',run_id='interrupted'").run();await scheduler.stop();let alerts=0;
  const restarted=await new BackupScheduler({file,firstAt:1,perform:async()=>assert.fail('replayed'),notify:async()=>{alerts++;throw Error('timeout');}}).ready();
  try{await restarted.tick();await restarted.tick();assert.equal(alerts,1);assert.equal(restarted.status().error,'BACKUP_INTERRUPTED');assert.equal(restarted.status().alert_status,'failed_or_unknown');}finally{await restarted.stop();}
});
test('unknown provider error is redacted in state and alert',async t=>{
  let code;
  const {scheduler}=await fixture(t,{perform:async()=>{throw Error('secret https://private.invalid/?key=redacted');},notify:async r=>{code=r.code;}});
  await scheduler.tick();assert.equal(code,'BACKUP_ATTEMPT_FAILED');assert.equal(scheduler.status().error,code);
});

test('forged budget waits with provider activity are permanently paused',async t=>{
  let attempts=0;const {scheduler}=await fixture(t,{allowBudgetDeferral:true,perform:async()=>{attempts++;return {status:'WAIT_BUDGET',providerCalls:1};}});
  await scheduler.tick();await scheduler.tick();assert.equal(attempts,1);assert.equal(scheduler.status().status,'paused');assert.equal(scheduler.status().error,'BACKUP_WAIT_INVALID');
  assert.equal(scheduler.db.prepare('SELECT count(*) n FROM budget_waits').get().n,0);
});
