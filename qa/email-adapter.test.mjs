import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {randomBytes} from 'node:crypto';
import {createVercelDemoHandler} from '../server/vercel-demo.mjs';
import {createEmailFixture} from './email-fixture.mjs';

const origin='https://email-preview.example';
const environment={ORDER_HUB_PUBLIC_ORIGIN:origin,VERCEL_ENV:'preview',VERCEL_GIT_COMMIT_REF:'vercel-demo'};

async function fixture(t,{mailConfigured=true}={}){
  const rows=new Map(),email=createEmailFixture();let tail=Promise.resolve(),failSend=false;
  const store={failCommit:false,transaction(callback,options={}){
    const key=options.visitor||'private-account';
    const work=tail.then(async()=>{
      const before=rows.get(key)||{snapshot:null,attempts:[]};
      const next=await callback({snapshot:before.snapshot&&Buffer.from(before.snapshot),attempts:structuredClone(before.attempts)});
      if(store.failCommit)throw Error('Fixture commit failed');
      rows.set(key,{snapshot:Buffer.from(next.snapshot),attempts:structuredClone(next.attempts)});return next.result;
    });tail=work.catch(()=>{});return work;
  }};
  const emailAuth=mailConfigured?{...email.emailAuth,sendOtp:async value=>{if(failSend)throw Error('Fixture private provider detail');await email.emailAuth.sendOtp(value)}}:null;
  let handler=createVercelDemoHandler({store,environment,emailAuth});
  const server=http.createServer((req,res)=>handler(req,res));
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const request=(path,{method='GET',body,cookie,csrf,headers={}}={})=>new Promise((resolve,reject)=>{
    const h={Host:new URL(origin).host,...(method==='GET'?{}:{Origin:origin,'Content-Type':'application/json'}),...headers};
    if(cookie)h.Cookie=cookie;if(csrf)h['X-CSRF-Token']=csrf;
    const req=http.request({hostname:'127.0.0.1',port:server.address().port,path,method,headers:h},res=>{
      const chunks=[];res.on('data',value=>chunks.push(value));res.on('end',()=>{
        const text=Buffer.concat(chunks).toString();let json;try{json=JSON.parse(text)}catch{}
        resolve({status:res.statusCode,headers:res.headers,text,json,cookies:(res.headers['set-cookie']||[]).map(value=>value.split(';')[0])});
      });
    });req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));
  });
  return {request,store,email,failSend(value){failSend=value},restart(){handler=createVercelDemoHandler({store,environment,emailAuth})}};
}

test('public demo and real account area have separate sessions, authorization and email flows',async t=>{
  const f=await fixture(t);
  assert.equal((await f.request('/account')).status,200);
  const redirect=await f.request('/account/?screen=register');assert.equal(redirect.status,308);assert.equal(redirect.headers.location,'/account?screen=register');
  const guest=await f.request('/api/auth/status');assert.equal(guest.json.publicDemo,true);
  assert.ok(guest.cookies.some(value=>value.startsWith('__Host-oh_demo_session=')));
  const guestCookie=guest.cookies.join('; ');
  const privateStatus=await f.request('/api/account/auth/status',{cookie:guestCookie});assert.equal(privateStatus.json.user,null);assert.equal(privateStatus.json.publicDemo,undefined);
  assert.equal((await f.request('/api/account/state',{cookie:guestCookie})).status,401);
  const fields={storeName:'Email fixture',storeCode:'email-fixture',username:'owner',name:'Fixture owner',password:randomBytes(24).toString('hex'),email:'owner@example.test'};
  const post=(route,body)=>f.request('/api/account'+route.slice('/api'.length),{method:'POST',body});
  assert.equal((await f.request('/api/auth/email/request',{method:'POST',body:{purpose:'signup',...fields},cookie:guestCookie,csrf:guest.json.csrf})).status,403);
  assert.equal(f.email.messages.length,0);
  const verified=await f.email.signup(post,fields),signup=await post('/api/auth/register',verified);assert.equal(signup.status,201);
  const accountCookie=signup.cookies.find(value=>value.startsWith('oh_session='));assert.ok(accountCookie);
  const both=guestCookie+'; '+accountCookie;
  f.restart();
  const account=await f.request('/api/account/auth/status',{cookie:both});assert.equal(account.json.user.id,signup.json.user.id);assert.equal(account.json.publicDemo,undefined);
  const retainedGuest=await f.request('/api/auth/status',{cookie:both});assert.equal(retainedGuest.json.user.id,guest.json.user.id);
  const state=await f.request('/api/account/state',{cookie:both});assert.deepEqual(state.json.data.orders,[]);assert.ok(state.json.data.products.every(product=>product.stock===0));
  assert.equal((await f.request('/api/account/account/auth/status')).status,404);
  assert.equal((await f.request('/api/account/auth/demo-reset',{method:'POST',body:{},cookie:both,csrf:signup.json.csrf})).status,404);
});

test('OTP delivery follows durable commit and signup proofs survive a failed registration commit',async t=>{
  const f=await fixture(t),fields={storeName:'Commit fixture',storeCode:'commit-fixture',username:'owner',name:'Fixture owner',email:'commit@example.test',password:randomBytes(24).toString('hex')};
  const post=(route,body)=>f.request('/api/account'+route.slice('/api'.length),{method:'POST',body});
  f.store.failCommit=true;
  let reply=await post('/api/auth/email/request',{purpose:'signup',...fields});assert.equal(reply.status,503);assert.equal(f.email.messages.length,0);
  f.store.failCommit=false;
  const verified=await f.email.signup(post,fields);assert.equal(f.email.messages.length,1);
  f.restart();f.store.failCommit=true;
  reply=await post('/api/auth/register',verified);assert.equal(reply.status,503);assert.deepEqual(reply.cookies,[]);
  f.store.failCommit=false;
  reply=await post('/api/auth/register',verified);assert.equal(reply.status,201);
  assert.equal((await post('/api/auth/register',verified)).status,400);
  f.failSend(true);
  const failed=await post('/api/auth/email/request',{purpose:'signup',email:'delivery@example.test',storeCode:'delivery-fixture',username:'owner'});
  assert.equal(failed.status,424);assert.doesNotMatch(failed.text,/private provider detail/);
  assert.equal((await post('/api/auth/email/request',{purpose:'signup',email:'delivery@example.test',storeCode:'delivery-fixture',username:'owner'})).status,429,'a delivery failure must retain the committed cooldown');
});

test('missing email configuration gives an actionable email response while demo and private state remain usable',async t=>{
  const f=await fixture(t,{mailConfigured:false});
  const response=await f.request('/api/account/auth/email/request',{method:'POST',body:{purpose:'signup',email:'unconfigured@example.test',storeCode:'unconfigured',username:'owner'}});
  assert.equal(response.status,503);assert.equal(response.json.code,'EMAIL_NOT_CONFIGURED');assert.doesNotMatch(response.text,/ฐานข้อมูล/);assert.deepEqual(response.cookies,[]);
  assert.equal(f.email.messages.length,0);
  const status=await f.request('/api/account/auth/status');assert.equal(status.json.user,null);assert.equal(status.json.needsSetup,true);
  assert.equal((await f.request('/api/auth/status')).json.publicDemo,true);
});
