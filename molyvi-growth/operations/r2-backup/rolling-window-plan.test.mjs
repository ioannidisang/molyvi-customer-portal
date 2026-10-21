import test from 'node:test';
import assert from 'node:assert/strict';
import {planRollingWindow} from './rolling-window-plan.mjs';
const row=(id,at,downloadBytes=0)=>({id,at,requests:1,uploadBytes:0,downloadBytes});
const observedAt='2026-10-21T00:00:00.000Z';

test('real ledger cutoff is exclusive at exactly 31 days',()=>{
  const r=row('old','2026-10-01T01:00:00.000Z',2_000_000_000);
  const one=planRollingWindow({observedAt,reservations:[r],attempts:[row('new','2026-11-01T01:00:00.000Z',1)]});
  assert.equal(one.results[0].status,'WITHIN_TRANSFER_WINDOW');assert.equal(one.results[0].consumed.downloadBytes,0);
  const before=planRollingWindow({observedAt,reservations:[r],attempts:[row('new','2026-11-01T00:59:59.999Z',1)]});
  assert.equal(before.results[0].status,'STOP');assert.equal(before.results[0].earliestRecheckAt,'2026-11-01T01:00:00.000Z');
});
test('failed and unknown charges remain; stop does not assume retry or mutate input',()=>{
  const input={observedAt,reservations:[{...row('failed','2026-10-15T01:00:00.000Z',1_500_000_000),status:'failed'}],
    attempts:[row('first','2026-10-25T01:00:00.000Z',350_000_000),row('second','2026-11-01T01:00:00.000Z',350_000_000),row('third','2026-11-08T01:00:00.000Z',350_000_000)]};
  const copy=structuredClone(input),p=planRollingWindow(input);assert.deepEqual(input,copy);
  assert.deepEqual(p.results.map(r=>r.status),['WITHIN_TRANSFER_WINDOW','STOP','NOT_EVALUATED_AFTER_STOP']);
  assert.equal(p.results[1].earliestRecheckAt,'2026-11-15T01:00:00.000Z');
  assert.equal(p.activationReady,false);assert.equal(p.actualReservationPerformed,false);assert.equal(p.automaticReschedule,false);
  assert.equal(p.initialUsage.downloadBytes,1_500_000_000);
});
test('a demand larger than the unchanged limit has no expiry solution',()=>{
  const p=planRollingWindow({observedAt,reservations:[],attempts:[row('large',observedAt,2_000_000_001)]});
  assert.equal(p.results[0].status,'STOP');assert.equal(p.results[0].earliestRecheckAt,null);
});
test('all dimensions enforced; unordered, duplicate, future and invalid values rejected',()=>{
  for(const field of ['requests','uploadBytes','downloadBytes']){
    const r={...row('demand',observedAt),[field]:field==='requests'?201:2_000_000_001};
    assert.deepEqual(planRollingWindow({observedAt,reservations:[],attempts:[r]}).results[0].blockedBy,[field]);
  }
  for(const attempts of [[row('same',observedAt),row('same',observedAt)],[row('a','2026-10-23T00:00:00.000Z'),row('b',observedAt)],[{...row('a',observedAt),uploadBytes:-1}]])
    assert.throws(()=>planRollingWindow({observedAt,reservations:[],attempts}));
  assert.throws(()=>planRollingWindow({observedAt,reservations:[row('future','2026-11-01T00:00:00.000Z')],attempts:[row('a',observedAt)]}));
});
