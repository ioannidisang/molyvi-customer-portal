// Operator-owned Google Workspace OAuth only; no domain-wide delegation.
// Required scopes: openid, email, https://www.googleapis.com/auth/gmail.send.
// Credentials belong in managed secrets, never a public bundle or tracked file.
export function createGoogleMailTokenProvider({clientId,clientSecret,refreshToken,expectedEmail='hello@molyvi.com',fetchImpl=globalThis.fetch,now=Date.now}={}){
  if(expectedEmail!=='hello@molyvi.com'||[clientId,clientSecret,refreshToken].some(v=>typeof v!=='string'||!v||v.length>4096||/[\x00-\x1f\x7f]/.test(v)))throw Error('GOOGLE_MAIL_CREDENTIALS_REQUIRED');
  let cached,pending;
  return async()=>{
    if(cached&&cached.expires>now()+60_000)return {accessToken:cached.token,email:cached.email,emailVerified:true};
    if(pending)return pending;
    pending=(async()=>{
      try{
        const r=await fetchImpl('https://oauth2.googleapis.com/token',{method:'POST',redirect:'error',signal:AbortSignal.timeout(10_000),
          headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:clientId,client_secret:clientSecret,refresh_token:refreshToken,grant_type:'refresh_token'}).toString()});
        const token=await r.json();
        if(!r.ok||typeof token.access_token!=='string'||!token.access_token||/[\x00-\x1f]/.test(token.access_token)||!Number.isFinite(token.expires_in)||token.expires_in<120||
          typeof token.scope!=='string'||!token.scope.split(' ').includes('https://www.googleapis.com/auth/gmail.send'))throw Error('GOOGLE_MAIL_AUTH_UNAVAILABLE');
        const profile=await fetchImpl('https://openidconnect.googleapis.com/v1/userinfo',{redirect:'error',signal:AbortSignal.timeout(10_000),headers:{Authorization:'Bearer '+token.access_token}}),identity=await profile.json();
        if(!profile.ok||identity.email!==expectedEmail||identity.email_verified!==true)throw Error('GOOGLE_MAIL_IDENTITY_MISMATCH');
        cached={token:token.access_token,email:identity.email,expires:now()+Math.min(token.expires_in,3600)*1000};
        return {accessToken:cached.token,email:cached.email,emailVerified:true};
      }catch{throw Error('GOOGLE_MAIL_AUTH_UNAVAILABLE');}
    })().finally(()=>{pending=null;});return pending;
  };
}
