import http from 'node:http';
import crypto from 'node:crypto';
import {GOOGLE_MAIL_SENDER} from './google-mail-token-provider.mjs';

const sendScope='https://www.googleapis.com/auth/gmail.send';
const allowedScopes=new Set(['openid','email','https://www.googleapis.com/auth/userinfo.email',sendScope]);
const credential=v=>typeof v==='string'&&v.length>0&&v.length<=4096&&!/[\x00-\x1f\x7f]/.test(v);
const safeEqual=(a,b)=>typeof a==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&crypto.timingSafeEqual(Buffer.from(a),Buffer.from(b));

// Operator-only, short-lived loopback consent. Never logs codes or tokens.
export function createGmailOAuthBootstrap({clientId,clientSecret,port=8915,saveCredentials,fetchImpl=globalThis.fetch,now=Date.now,ttlMs=600_000}={}){
  if(!credential(clientId)||!credential(clientSecret)||!Number.isInteger(port)||port<1024||port>65535||typeof saveCredentials!=='function'||!Number.isInteger(ttlMs)||ttlMs<1000||ttlMs>600_000)throw Error('INVALID_OAUTH_BOOTSTRAP');
  const state=crypto.randomBytes(32).toString('base64url'),verifier=crypto.randomBytes(48).toString('base64url'),created=now(),host='127.0.0.1:'+port;
  const redirectUri='http://'+host+'/oauth/google/callback';let busy=false,completed=false;
  const authorize=new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authorize.search=new URLSearchParams({client_id:clientId,redirect_uri:redirectUri,response_type:'code',scope:'openid email '+sendScope,
    access_type:'offline',prompt:'consent',login_hint:GOOGLE_MAIL_SENDER,state,code_challenge:crypto.createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'}).toString();
  const reply=(res,status,text)=>{res.writeHead(status,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer',
    'Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",'X-Content-Type-Options':'nosniff'});res.end('<!doctype html><html lang="el"><meta charset="utf-8"><title>Molyvi · Σύνδεση email</title><body>'+text+'</body></html>');};
  const server=http.createServer(async(req,res)=>{
    if(req.headers.host!==host||req.method!=='GET')return reply(res,403,'Η πρόσβαση δεν επιτρέπεται.');
    if(now()-created>=ttlMs)return reply(res,410,'Η σύνδεση έληξε. Ξεκίνησε ξανά από την εφαρμογή.');
    const url=new URL(req.url,'http://'+host);
    if(url.pathname==='/')return reply(res,200,'<h1>Σύνδεση info@molyvi.com με Molyvi</h1><p>Επιτρέπεται μόνο η αποστολή email και η επιβεβαίωση της διεύθυνσης. Δεν ζητείται ανάγνωση μηνυμάτων.</p><p><a href="'+authorize.href.replaceAll('&','&amp;')+'">Συνέχεια στη Google</a></p>');
    if(url.pathname!=='/oauth/google/callback')return reply(res,404,'Η σελίδα δεν βρέθηκε.');
    if(!safeEqual(url.searchParams.get('state'),state)||url.searchParams.getAll('state').length!==1)return reply(res,403,'Η επιβεβαίωση σύνδεσης δεν είναι έγκυρη.');
    if(busy||completed)return reply(res,409,'Η σύνδεση έχει ήδη υποβληθεί.');
    if(url.searchParams.has('error'))return reply(res,400,'Η πρόσβαση δεν εγκρίθηκε στη Google.');
    const code=url.searchParams.get('code');if(!credential(code)||url.searchParams.getAll('code').length!==1)return reply(res,400,'Δεν βρέθηκε έγκυρη επιβεβαίωση.');
    busy=true;
    try{
      const response=await fetchImpl('https://oauth2.googleapis.com/token',{method:'POST',redirect:'error',signal:AbortSignal.timeout(10_000),headers:{'Content-Type':'application/x-www-form-urlencoded'},
        body:new URLSearchParams({client_id:clientId,client_secret:clientSecret,code,redirect_uri:redirectUri,grant_type:'authorization_code',code_verifier:verifier}).toString()});
      const token=await response.json(),scopes=typeof token.scope==='string'?token.scope.split(' ').filter(Boolean):[];
      if(!response.ok||!credential(token.access_token)||!credential(token.refresh_token)||!scopes.includes(sendScope)||scopes.some(s=>!allowedScopes.has(s)))throw Error('OAUTH_GRANT_REJECTED');
      const profile=await fetchImpl('https://openidconnect.googleapis.com/v1/userinfo',{redirect:'error',signal:AbortSignal.timeout(10_000),headers:{Authorization:'Bearer '+token.access_token}}),identity=await profile.json();
      if(!profile.ok||identity.email!==GOOGLE_MAIL_SENDER||identity.email_verified!==true)throw Error('OAUTH_ACCOUNT_MISMATCH');
      await saveCredentials({MOLYVI_GOOGLE_CLIENT_ID:clientId,MOLYVI_GOOGLE_CLIENT_SECRET:clientSecret,MOLYVI_GOOGLE_REFRESH_TOKEN:token.refresh_token});
      completed=true;return reply(res,200,'<h1>Η σύνδεση επιβεβαιώθηκε</h1><p>Το info@molyvi.com είναι έτοιμο για σύνδεση με την εφαρμογή. Μπορείς να κλείσεις αυτή την καρτέλα.</p>');
    }catch{return reply(res,400,'Η σύνδεση δεν ολοκληρώθηκε. Έλεγξε τον λογαριασμό και τις άδειες και ξεκίνησε νέα σύνδεση.');}
    finally{busy=false;}
  });
  return {server,redirectUri,port,status:()=>({completed,expired:now()-created>=ttlMs})};
}
