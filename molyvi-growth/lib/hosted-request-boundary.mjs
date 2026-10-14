import {IntakeError} from './intake-store.mjs';
const fail=(code,status=403)=>{throw new IntakeError(code,status);};
export function createRequestBoundary(deployment){
  if(!deployment)return {hosted:false,cookieName:'molyvi_customer_local',cookieSuffix:'; HttpOnly; SameSite=Strict; Path=/',
    inspect(req,port){const hosts=[`127.0.0.1:${port}`,`localhost:${port}`];if(!hosts.includes(req.headers.host))fail('HOST_NOT_ALLOWED');return {origin:`http://${req.headers.host}`,client:req.socket.remoteAddress,health:false};}};
  const {publicOrigin,healthHosts=[]}=deployment;
  let url;try{url=new URL(publicOrigin);}catch{fail('INVALID_HOSTED_ORIGIN',500);}
  if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash||url.port||!(url.hostname==='app.molyvi.com'||/^molyvi-[a-z0-9-]+\.onrender\.com$/.test(url.hostname))||!Array.isArray(healthHosts)||healthHosts.some(h=>!/^molyvi-[a-z0-9-]+\.onrender\.com$/.test(h)))fail('INVALID_HOSTED_ORIGIN',500);
  const origin=url.origin;
  return {hosted:true,origin,cookieName:'__Host-molyvi_customer',cookieSuffix:'; Secure; HttpOnly; SameSite=Strict; Path=/',
    inspect(req,port){
      for(const header of ['host','origin'])if(req.rawHeaders.filter((x,i)=>i%2===0&&x.toLowerCase()===header).length>(header==='host'?1:1))fail('DUPLICATE_SECURITY_HEADER');
      if(typeof req.url!=='string'||!req.url.startsWith('/')||req.url.startsWith('//')||req.url.includes('\\'))fail('INVALID_REQUEST_TARGET',400);
      const health=req.url==='/healthz'&&['GET','HEAD'].includes(req.method);
      const allowed=health?[url.host,...healthHosts,`127.0.0.1:${port}`,`localhost:${port}`]:[url.host];
      if(!allowed.includes(req.headers.host))fail('HOST_NOT_ALLOWED');
      // Public origin is configuration, never X-Forwarded-Host/Proto input.
      // Low-volume staging uses a conservative shared login budget. A client
      // cannot bypass it by forging forwarded IPs; trusted edge IP parsing is deferred.
      return {origin,client:'hosted-shared-budget',health};
    }};
}
