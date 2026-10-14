import http from 'node:http';

// A separate, POST-only pilot listener. A tunnel must never point at the
// workspace server: it contains the customer UI, sessions and private APIs.
export function createServiceWebhookReceiver({bridge,onDelivery,enabled=()=>false,maxInFlight=4}={}){
  if(typeof enabled!=='function'||!Number.isInteger(maxInFlight)||maxInFlight<1||maxInFlight>16)throw new Error('RECEIVER_CONFIG_INVALID');
  let active=0;
  const send=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));};
  const server=http.createServer(async(req,res)=>{
    if(req.url!=='/webhooks/shopify/orders-paid')return send(res,404,{error:'NOT_FOUND'});
    if(req.method!=='POST')return send(res,405,{error:'POST_REQUIRED'});
    if(!enabled())return send(res,503,{error:'RECEIVER_NOT_ENABLED'});
    if(req.headers.origin||req.headers['sec-fetch-site'])return send(res,403,{error:'SERVER_DELIVERY_REQUIRED'});
    if(!/^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers['content-type']??''))return send(res,415,{error:'JSON_REQUIRED'});
    if(!bridge?.receive||typeof onDelivery!=='function')return send(res,503,{error:'RECEIVER_CONFIG_INVALID'});
    if(active>=maxInFlight)return send(res,429,{error:'RECEIVER_BUSY'});
    active++;
    try{
      const chunks=[];let size=0;
      for await(const bytes of req){size+=bytes.length;if(size>1_048_576){send(res,413,{error:'PAYLOAD_TOO_LARGE'});return;}chunks.push(bytes);}
      const raw=Buffer.concat(chunks),headers={};
      for(const name of ['x-shopify-hmac-sha256','x-shopify-shop-domain','x-shopify-api-version','x-shopify-topic','x-shopify-webhook-id','x-shopify-event-id'])if(req.headers[name]!==undefined)headers[name]=req.headers[name];
      const result=await bridge.receive(raw,headers);
      // Store a private delivery only after successful provider verification.
      await onDelivery({raw,headers,result});
      send(res,200,{accepted:true});
    }catch(error){send(res,error.status??500,{error:error.code??'RECEIVER_FAILED'});}
    finally{active--;}
  });
  server.requestTimeout=10_000;server.headersTimeout=10_000;server.maxHeadersCount=40;
  return server;
}
