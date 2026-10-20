// Private observational sampler. No cgroup writes, peak reset or process kill.
import fs from 'node:fs/promises';
import path from 'node:path';
import {parentPort,workerData,isMainThread} from 'node:worker_threads';

const check=(v,m)=>{if(!v)throw Error(m);};
const pairs=text=>Object.fromEntries(text.trim().split('\n').filter(Boolean).map(line=>{
  const [key,value]=line.trim().split(/\s+/);const number=Number(value);
  check(Number.isSafeInteger(number)&&number>=0,'PROBE_MEMORY_VALUE');return [key,number];
}));
export async function readLinuxMemorySample({cgroup='/sys/fs/cgroup',proc='/proc',pid=process.pid}={}){
  const [max,current,peak,events,stats,status,processStat]=await Promise.all([
    ...['memory.max','memory.current','memory.peak','memory.events','memory.stat'].map(name=>fs.readFile(path.join(cgroup,name),'utf8')),
    fs.readFile(path.join(proc,String(pid),'status'),'utf8'),fs.readFile(path.join(proc,String(pid),'stat'),'utf8')
  ]);
  const readNumber=value=>{check(/^\d+\s*$/.test(value),'PROBE_FINITE_CGROUP_REQUIRED');const n=Number(value);check(Number.isSafeInteger(n),'PROBE_MEMORY_VALUE');return n;};
  const stat=pairs(stats),event=pairs(events),kb=name=>{
    const match=status.match(new RegExp('^'+name+':\\s+(\\d+) kB$','m'));
    check(match,'PROBE_PROC_STATUS');return Number(match[1])*1024;
  };
  const fields=processStat.slice(processStat.lastIndexOf(')')+2).trim().split(/\s+/);
  check(/^\d+$/.test(fields[19]??''),'PROBE_PROCESS_IDENTITY');
  return {at:Date.now(),pid,startTicks:fields[19],limitBytes:readNumber(max),currentBytes:readNumber(current),lifetimePeakBytes:readNumber(peak),
    rssBytes:kb('VmRSS'),rssHighWaterBytes:kb('VmHWM'),anonBytes:stat.anon??0,fileBytes:stat.file??0,
    slabBytes:stat.slab??0,slabUnreclaimableBytes:stat.slab_unreclaimable??0,
    inactiveFileBytes:stat.inactive_file??0,fileDirtyBytes:stat.file_dirty??0,fileWritebackBytes:stat.file_writeback??0,
    workingSetBytes:Math.max(0,readNumber(current)-(stat.inactive_file??0)),
    nonreclaimableEstimateBytes:(stat.anon??0)+(stat.slab_unreclaimable??0)+(stat.file_dirty??0)+(stat.file_writeback??0),events:event};
}

if(!isMainThread){
  const {shared,logFile,deadline,policy,cgroup,proc,pid,initial}=workerData,flags=new Int32Array(shared);
  let log,count=0,bytes=0,first=null,last=null,error=null;
  const peaks={currentBytes:0,rssBytes:0,anonBytes:0,fileBytes:0,slabBytes:0,slabUnreclaimableBytes:0,workingSetBytes:0,nonreclaimableEstimateBytes:0};
  let rawCurrentWarnings=0;
  const setReason=value=>Atomics.compareExchange(flags,1,0,value);
  const observe=async terminal=>{
    const sample=await readLinuxMemorySample({cgroup,proc,pid});sample.phaseSequence=Atomics.load(flags,2);sample.terminal=terminal;
    check(initial?.pid===pid&&sample.limitBytes===policy.limitBytes&&sample.startTicks===initial.startTicks,'PROBE_MEMORY_IDENTITY_CHANGED');
    first??=sample;last=sample;
    for(const key of Object.keys(peaks))peaks[key]=Math.max(peaks[key],sample[key]);
    if(sample.rssBytes>=policy.rssStopBytes||sample.nonreclaimableEstimateBytes>=policy.anonStopBytes)setReason(2);
    if(sample.currentBytes>=policy.currentWarningBytes)rawCurrentWarnings++;
    if((sample.events.oom??0)>(initial.events.oom??0)||(sample.events.oom_kill??0)>(initial.events.oom_kill??0))setReason(3);
    if(Date.now()>deadline)setReason(1);
    const line=JSON.stringify(sample)+'\n';bytes+=Buffer.byteLength(line);count++;
    check(bytes<=8*1024*1024&&count<=10000,'PROBE_SAMPLE_LOG_LIMIT');
    await log.write(line);return sample;
  };
  try{
    log=await fs.open(logFile,'wx',0o600);
    while(!Atomics.load(flags,0)){
      const sample=await observe(false);
      if(count===1)parentPort.postMessage({type:'ready',sample});
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    // One terminal observation after the caller's last synchronous/native phase.
    await observe(true);
    await log.sync();
  }catch(e){error=/^[A-Z0-9_]+$/.test(e.message)?e.message:'PROBE_SAMPLER_FAILED';setReason(4);}
  finally{await log?.close();}
  parentPort.postMessage({type:'complete',initial,first,last,peaks,samples:count,logBytes:bytes,error,stopReason:Atomics.load(flags,1),
    intervalMs:100,threadId:workerData.threadLabel,rawCurrentWarnings,instantaneousAbort:false,peakReset:false});
}
