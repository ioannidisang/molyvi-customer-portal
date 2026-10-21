// One durable schedule in the existing service. No provider polling between runs.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {validateBudgetWait} from './budget-wait.mjs';

export function nextWeekly(now){
  const d=new Date(now);d.setUTCHours(1,0,0,0);
  d.setUTCDate(d.getUTCDate()+(7-d.getUTCDay())%7);
  if(d.getTime()<=now)d.setUTCDate(d.getUTCDate()+7);
  return d.getTime();
}
const safeError=e=>/^[A-Z0-9_]{3,100}$/.test(e?.message??'')?e.message:'BACKUP_ATTEMPT_FAILED';
export class BackupScheduler{
  constructor({file,firstAt,perform,notify,now=Date.now,allowBudgetDeferral=false}){Object.assign(this,{file,firstAt,perform,notify,now,allowBudgetDeferral});this.active=null;this.stopping=false;}
  async ready(){
    if(!Number.isSafeInteger(this.firstAt)||this.firstAt<1)throw Error('BACKUP_SCHEDULE_REQUIRED');
    if(typeof this.allowBudgetDeferral!=='boolean')throw Error('BACKUP_WAIT_CONFIG');
    await fs.mkdir(path.dirname(this.file),{recursive:true,mode:0o700});
    this.db=new DatabaseSync(this.file);await fs.chmod(this.file,0o600);
    this.db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS schedule(id INTEGER PRIMARY KEY CHECK(id=1),next_at INTEGER NOT NULL,status TEXT NOT NULL,run_id TEXT,last_result TEXT,error TEXT,alert_id TEXT,alert_status TEXT);');
    this.db.prepare("INSERT OR IGNORE INTO schedule(id,next_at,status) VALUES(1,?,'waiting')").run(this.firstAt);
    if(this.allowBudgetDeferral)this.db.exec('CREATE TABLE IF NOT EXISTS budget_waits(run_id TEXT PRIMARY KEY,due_at INTEGER NOT NULL,checked_at INTEGER NOT NULL,next_at INTEGER NOT NULL,receipt TEXT NOT NULL);');
    // An interrupted network operation is ambiguous. Never replay it on restart.
    this.db.prepare("UPDATE schedule SET status='paused',error='BACKUP_INTERRUPTED',alert_id=?,alert_status='pending' WHERE status='running'").run(crypto.randomUUID());
    return this;
  }
  status(){const r=this.db.prepare('SELECT * FROM schedule WHERE id=1').get();return {...r,last_result:r.last_result?JSON.parse(r.last_result):null};}
  start(){if(this.timer||this.stopping)return;this.timer=setInterval(()=>{void this.tick().catch(()=>console.error('MOLYVI_BACKUP_SCHEDULER_FAILED'));},60_000);this.timer.unref();void this.tick().catch(()=>console.error('MOLYVI_BACKUP_SCHEDULER_FAILED'));}
  tick(){
    if(this.stopping||this.active)return this.active??Promise.resolve();
    this.active=this.run().finally(()=>{this.active=null;});return this.active;
  }
  async run(){
    let r=this.status();
    if(r.status==='waiting'&&r.next_at<=this.now()){
      const runId='auto-'+new Date(this.now()).toISOString().replace(/[^0-9]/g,'').slice(0,14)+'-'+crypto.randomBytes(4).toString('hex');
      const claim=this.db.prepare("UPDATE schedule SET status='running',run_id=? WHERE id=1 AND status='waiting' AND next_at<=?").run(runId,this.now());
      if(claim.changes){
        try{
          const result=await this.perform(runId);
          if(result?.status==='WAIT_BUDGET'){
            if(!this.allowBudgetDeferral)throw Error('BACKUP_WAIT_NOT_ENABLED');
            validateBudgetWait(result,this.now());
            this.db.exec('BEGIN IMMEDIATE');
            try{
              this.db.prepare('INSERT INTO budget_waits VALUES(?,?,?,?,?)').run(runId,r.next_at,result.checkedAt,result.notBefore,JSON.stringify(result));
              const changed=this.db.prepare("UPDATE schedule SET status='waiting',next_at=?,error=?,alert_id=?,alert_status='pending' WHERE id=1 AND status='running' AND run_id=?").run(result.notBefore,result.code,crypto.randomUUID(),runId);
              if(changed.changes!==1)throw Error('BACKUP_WAIT_SCHEDULE_CHANGED');
              this.db.exec('COMMIT');
            }catch(e){this.db.exec('ROLLBACK');throw e;}
            console.log(JSON.stringify({event:'molyvi_backup',status:'WAIT_BUDGET',runId,nextAt:new Date(result.notBefore).toISOString()}));
          }else{
          this.db.prepare("UPDATE schedule SET status='waiting',next_at=?,last_result=?,error=NULL,alert_id=NULL,alert_status=NULL WHERE id=1").run(nextWeekly(this.now()),JSON.stringify(result));
          console.log(JSON.stringify({event:'molyvi_backup',status:'PASS',runId,nextAt:new Date(this.status().next_at).toISOString()}));
          }
        }catch(e){
          const code=safeError(e);
          this.db.prepare("UPDATE schedule SET status='paused',error=?,alert_id=?,alert_status='pending' WHERE id=1").run(code,crypto.randomUUID());
          console.error(JSON.stringify({event:'molyvi_backup',status:'PAUSED',code,runId}));
        }
      }
    }
    r=this.status();
    if((r.status==='paused'||r.status==='waiting'&&r.error==='BACKUP_TRANSFER_BUDGET_WAIT')&&r.alert_status==='pending'&&this.notify){
      // Persist before sending: a crash cannot send the same alert repeatedly.
      this.db.prepare("UPDATE schedule SET alert_status='attempting' WHERE id=1 AND alert_status='pending'").run();
      try{await this.notify({messageId:r.alert_id,code:r.error,...(r.error==='BACKUP_TRANSFER_BUDGET_WAIT'?{notBefore:r.next_at}:{})});this.db.prepare("UPDATE schedule SET alert_status='accepted' WHERE id=1").run();}
      catch{this.db.prepare("UPDATE schedule SET alert_status='failed_or_unknown' WHERE id=1").run();console.error('MOLYVI_BACKUP_ALERT_NOT_CONFIRMED');}
    }
  }
  async stop(){this.stopping=true;clearInterval(this.timer);await this.active;this.db?.close();this.db=null;}
}
