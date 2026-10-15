// Bound active work without rejecting a normal burst of gallery images.
// Waiting clients have a fixed budget and leave the queue on disconnect.
export class RequestSlots {
  constructor({limit=8,maxWaiting=64,waitMs=10000}={}){this.limit=limit;this.maxWaiting=maxWaiting;this.waitMs=waitMs;this.active=0;this.waiting=[];}
  acquire({wait=false,signal}={}){
    if(signal?.aborted)return Promise.reject(new Error('REQUEST_CANCELLED'));
    if(this.active<this.limit){this.active++;return Promise.resolve(this.releaseHandle());}
    if(!wait||this.waiting.length>=this.maxWaiting)return Promise.reject(new Error('SERVER_BUSY'));
    return new Promise((resolve,reject)=>{
      const item={resolve,reject,signal};
      const cancel=code=>{const index=this.waiting.indexOf(item);if(index<0)return;this.waiting.splice(index,1);item.cleanup();reject(new Error(code));};
      const aborted=()=>cancel('REQUEST_CANCELLED'),timer=setTimeout(()=>cancel('SERVER_BUSY'),this.waitMs);
      item.cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',aborted);};
      signal?.addEventListener('abort',aborted,{once:true});this.waiting.push(item);
    });
  }
  releaseHandle(){let released=false;return ()=>{if(released)return;released=true;const next=this.waiting.shift();if(next){next.cleanup();next.resolve(this.releaseHandle());}else this.active--;};}
}
