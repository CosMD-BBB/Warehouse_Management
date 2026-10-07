import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {createApp} from '../server/index.mjs';

const publicOrigin='https://order-hub.example';

async function fixture(t,{origin=publicOrigin}={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'order-hub-hosting-'));
  const {server}=createApp({dbPath:path.join(dir,'test.sqlite'),publicOrigin:origin});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));fs.rmSync(dir,{recursive:true,force:true})});
  const port=server.address().port,localOrigin=`http://127.0.0.1:${port}`,allowedOrigin=origin||localOrigin;
  function request(route,{method='GET',body,session,headers={}}={}){
    const h={Host:new URL(allowedOrigin).host};
    if(method!=='GET'&&method!=='HEAD'){h.Origin=allowedOrigin;h['Content-Type']='application/json'}
    if(session){h.Cookie=session.cookie;h['X-CSRF-Token']=session.csrf}
    Object.assign(h,headers);
    for(const key of Object.keys(h))if(h[key]===undefined)delete h[key];
    return new Promise((resolve,reject)=>{
      const req=http.request({hostname:'127.0.0.1',port,path:route,method,headers:h},res=>{
        const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>{
          const text=Buffer.concat(chunks).toString();let json;try{json=JSON.parse(text)}catch{}
          const setCookie=res.headers['set-cookie']?.[0];
          resolve({status:res.statusCode,json,setCookie,cookie:setCookie?.split(';')[0]});
        });
      });
      req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));
    });
  }
  return {request,localOrigin};
}

test('public origin configuration fails before opening SQLite for malformed or unsafe URLs',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'order-hub-host-config-')),dbPath=path.join(dir,'not-created','test.sqlite');
  try{
    for(const value of ['http://order-hub.example','https://user:secret@order-hub.example','https://order-hub.example/app','https://order-hub.example/app/..','https://order-hub.example/?a=1','https://order-hub.example/#fragment','https://*.example',' https://order-hub.example','https://order-hub.exa\nmple',null]){
      assert.throws(()=>createApp({dbPath,publicOrigin:value}),/ORDER_HUB_PUBLIC_ORIGIN/);
      assert.equal(fs.existsSync(path.dirname(dbPath)),false,'invalid hosting configuration must not initialize data');
    }
  }finally{fs.rmSync(dir,{recursive:true,force:true})}
});

test('HTTPS proxy configuration keeps authentication and CSRF, and sets Secure on issued and cleared cookies',async t=>{
  const f=await fixture(t),password=randomBytes(24).toString('hex'),changedPassword=randomBytes(24).toString('hex');
  let r=await f.request('/api/auth/status');assert.equal(r.status,200);assert.equal(r.json.needsSetup,true);
  assert.equal((await f.request('/api/state')).status,401);
  r=await f.request('/api/auth/setup',{method:'POST',body:{storeName:'ร้านทดสอบ HTTPS',storeCode:'hosting-test',username:'testadmin',name:'Fixture Admin',password}});
  assert.equal(r.status,201);assert.match(r.setCookie,/; HttpOnly;/);assert.match(r.setCookie,/; SameSite=Strict;/);assert.match(r.setCookie,/; Secure(?:;|$)/);
  let session={cookie:r.cookie,csrf:r.json.csrf};
  assert.equal((await f.request('/api/state',{session})).status,200);
  assert.equal((await f.request('/api/store',{method:'PATCH',session,body:{name:'ร้านทดสอบ'},headers:{'X-CSRF-Token':undefined}})).status,403);
  assert.equal((await f.request('/api/store',{method:'PATCH',session,body:{name:'ร้านทดสอบ'}})).status,200);
  r=await f.request('/api/auth/password',{method:'POST',session,body:{currentPassword:password,password:changedPassword}});
  assert.equal(r.status,200);assert.match(r.setCookie,/; Secure(?:;|$)/);assert.match(r.setCookie,/Max-Age=0/);
  assert.equal((await f.request('/api/state',{session})).status,401);
  r=await f.request('/api/auth/login',{method:'POST',body:{storeCode:'hosting-test',username:'testadmin',password:changedPassword}});
  assert.equal(r.status,200);assert.match(r.setCookie,/; Secure(?:;|$)/);session={cookie:r.cookie,csrf:r.json.csrf};
  r=await f.request('/api/auth/logout',{method:'POST',session,body:{}});assert.equal(r.status,200);assert.match(r.setCookie,/; Secure(?:;|$)/);assert.match(r.setCookie,/Max-Age=0/);
  assert.equal((await f.request('/api/state',{session})).status,401);
  for(const route of ['/server/seed.json','/.local/order-hub.sqlite'])assert.equal((await f.request(route)).status,404);
});

test('only the configured public Host and mutation Origin are accepted; forwarded headers cannot grant access',async t=>{
  const f=await fixture(t),body={};
  const spoof={'X-Forwarded-Host':'order-hub.example','X-Forwarded-Proto':'https',Forwarded:'host=order-hub.example;proto=https'};
  for(const host of ['attacker.example','order-hub.example.attacker.example','order-hub.example:443',new URL(f.localOrigin).host]){
    assert.equal((await f.request('/api/auth/status',{headers:{Host:host,...spoof}})).status,403);
  }
  for(const origin of [undefined,'null','http://order-hub.example','https://attacker.example',f.localOrigin,publicOrigin+'/']){
    const r=await f.request('/api/auth/setup',{method:'POST',body,headers:{Origin:origin,...spoof}});assert.equal(r.status,403);
  }
  assert.equal((await f.request('/api/auth/status',{headers:{'X-Forwarded-Host':'attacker.example','X-Forwarded-Proto':'http',Forwarded:'host=attacker.example;proto=http'}})).status,200,'untrusted forwarding headers cannot change the configured authority');
  assert.equal((await f.request('/api/auth/setup',{method:'POST',body})).status,400,'correct origin reaches normal account validation');
});

test('default loopback requests remain usable without Secure cookies and still reject external authority',async t=>{
  const f=await fixture(t,{origin:''});
  const r=await f.request('/api/auth/setup',{method:'POST',body:{username:'testadmin',name:'Fixture Admin',password:randomBytes(24).toString('hex')}});
  assert.equal(r.status,201);assert.doesNotMatch(r.setCookie,/; Secure(?:;|$)/);
  assert.equal((await f.request('/api/auth/status',{headers:{Host:'order-hub.example','X-Forwarded-Host':new URL(f.localOrigin).host}})).status,403);
  assert.equal((await f.request('/api/auth/login',{method:'POST',body:{},headers:{Origin:publicOrigin,'X-Forwarded-Proto':'https'}})).status,403);
});
