import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {codespacesConfig,startDemo,demoStatus} from '../scripts/start-codespaces.mjs';
import {createApp} from '../server/index.mjs';
import {createEmailFixture} from './email-fixture.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const codespacesEnvironment={CODESPACE_NAME:'sample-demo-abc123',GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:'app.github.dev'};
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const linuxOnly={skip:process.platform!=='linux'&&'Codespaces process identity and kernel locks require Linux; configuration tests still run.'};

async function stop(pid){
  try{process.kill(pid,'SIGTERM')}catch(error){if(error.code==='ESRCH')return;throw error}
  for(let attempt=0;attempt<100;attempt++){
    try{process.kill(pid,0)}catch(error){if(error.code==='ESRCH')return;throw error}
    await wait(20);
  }
  throw new Error('Fixture backend did not stop.');
}

async function freePort(){
  const listener=net.createServer();await new Promise((resolve,reject)=>{listener.once('error',reject);listener.listen(0,'127.0.0.1',resolve)});
  const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));return port;
}

function request(config,route,{method='GET',body,cookie,csrf,headers={}}={}){
  const h={Host:new URL(config.publicOrigin).host};
  if(method!=='GET'&&method!=='HEAD'){h.Origin=config.publicOrigin;h['Content-Type']='application/json'}
  if(cookie)h.Cookie=cookie;if(csrf)h['X-CSRF-Token']=csrf;Object.assign(h,headers);
  return new Promise((resolve,reject)=>{
    const req=http.request({hostname:'127.0.0.1',port:config.port,path:route,method,headers:h},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>{
        const bytes=Buffer.concat(chunks);let json;try{json=JSON.parse(bytes.toString())}catch{}
        resolve({status:res.statusCode,json,bytes,setCookie:res.headers['set-cookie']?.[0]});
      });
    });req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));
  });
}

async function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'order-hub-codespaces-')),port=await freePort();
  const config={...codespacesConfig(codespacesEnvironment,root),port,publicOrigin:`https://sample-demo-abc123-${port}.app.github.dev`,dbPath:path.join(dir,'.local','demo.sqlite'),markerPath:path.join(dir,'.local','process.json'),logPath:path.join(dir,'.local','demo.log')};
  const pids=new Set();t.after(async()=>{for(const pid of pids)await stop(pid);fs.rmSync(dir,{recursive:true,force:true})});
  async function start(){const environment={...process.env};delete environment.RESEND_API_KEY;delete environment.ORDER_HUB_EMAIL_FROM;delete environment.ORDER_HUB_EMAIL_OTP_SECRET;const result=await startDemo(config,{environment});pids.add(result.pid);return result}
  async function halt(pid){await stop(pid);pids.delete(pid)}
  return {config,dir,start,halt};
}

test('Codespaces derives the exact private-forward origin and keeps demo data separate',()=>{
  const config=codespacesConfig(codespacesEnvironment,root);
  assert.equal(config.publicOrigin,'https://sample-demo-abc123-4180.app.github.dev');assert.equal(config.port,4180);assert.equal(config.host,'0.0.0.0');
  assert.equal(config.dbPath,path.join(root,'.local','codespaces-demo.sqlite'));
  assert.notEqual(config.dbPath,path.join(root,'.local','order-hub.sqlite'));
  const aligned={...codespacesEnvironment,ORDER_HUB_PUBLIC_ORIGIN:config.publicOrigin+'/',ORDER_HUB_HOST:'0.0.0.0',ORDER_HUB_PORT:'4180',PORT:'4180',ORDER_HUB_DB:'.local/codespaces-demo.sqlite'};
  assert.deepEqual(codespacesConfig(aligned,root),config);
  const container=JSON.parse(fs.readFileSync(path.join(root,'.devcontainer','devcontainer.json'),'utf8'));
  assert.equal(container.image,'node:24-bookworm');assert.equal(container.remoteUser,'node');assert.deepEqual(container.forwardPorts,[4180]);
  assert.equal(container.portsAttributes['4180'].protocol,'http');assert.equal(container.portsAttributes['4180'].onAutoForward,'openBrowser');
  assert.equal(container.postStartCommand,'node scripts/start-codespaces.mjs');assert.equal(JSON.stringify(container).includes('public'),false);
});

test('missing Codespaces identity and conflicting host, origin, port or database fail before filesystem changes',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'order-hub-codespaces-config-')),absentRoot=path.join(dir,'untouched');
  try{
    for(const environment of [{}, {...codespacesEnvironment,CODESPACE_NAME:'bad/name'}, {...codespacesEnvironment,CODESPACE_NAME:'name?token=secret'}, {...codespacesEnvironment,GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:'app.github.dev/route'}, {...codespacesEnvironment,GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:'user@domain.example'}, {...codespacesEnvironment,ORDER_HUB_PUBLIC_ORIGIN:'https://other.example'}, {...codespacesEnvironment,ORDER_HUB_PUBLIC_ORIGIN:'https://sample-demo-abc123-4180.app.github.dev/path'}, {...codespacesEnvironment,ORDER_HUB_HOST:'127.0.0.1'}, {...codespacesEnvironment,ORDER_HUB_PORT:'4181'}, {...codespacesEnvironment,PORT:'3000'}, {...codespacesEnvironment,ORDER_HUB_DB:'.local/order-hub.sqlite'}]){
      assert.throws(()=>codespacesConfig(environment,absentRoot));assert.equal(fs.existsSync(absentRoot),false);
    }
  }finally{fs.rmSync(dir,{recursive:true,force:true})}
});

test('real Codespaces backend serializes concurrent starts, enforces auth and origin, and preserves chosen accounts across restart',linuxOnly,async t=>{
  const f=await fixture(t),{config}=f;
  fs.mkdirSync(path.dirname(config.markerPath),{recursive:true});fs.writeFileSync(config.markerPath+'.lock','leftover file from a previous stopped launcher');
  const launches=await Promise.all([f.start(),f.start(),f.start()]);
  assert.equal(new Set(launches.map(result=>result.pid)).size,1);assert.equal(launches.filter(result=>!result.reused).length,1);
  let started=launches.find(result=>!result.reused);assert.equal(started.needsSetup,true);
  assert.equal((await demoStatus(config)).needsSetup,true);
  const db=new DatabaseSync(config.dbPath,{readOnly:true});assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n,0);db.close();
  assert.equal((await request(config,'/api/state')).status,401);
  for(const route of ['/', '/auth-client.js','/brand-logo.jpeg','/brand-icon.png','/fonts/SukhumvitThai-400.ttf','/fonts/Manrope-Variable.ttf']){const r=await request(config,route);assert.equal(r.status,200);assert.ok(r.bytes.length>0);}
  assert.equal((await request(config,'/.local/codespaces-demo.sqlite')).status,404);
  assert.equal((await request(config,'/api/auth/status',{headers:{Host:'attacker.example','X-Forwarded-Host':new URL(config.publicOrigin).host}})).status,403);
  assert.equal((await request(config,'/api/auth/setup',{method:'POST',body:{},headers:{Origin:'https://attacker.example','X-Forwarded-Proto':'https'}})).status,403);
  const password=randomBytes(24).toString('hex');
  const fields={storeName:'ร้านสาธิต Codespaces',storeCode:'demo-space',username:'fixtureadmin',name:'Fixture Admin',password};
  assert.equal((await request(config,'/api/auth/setup',{method:'POST',body:fields})).status,503,'unconfigured mail must not admit an unverified owner');
  const stillEmpty=new DatabaseSync(config.dbPath,{readOnly:true});assert.equal(stillEmpty.prepare('SELECT COUNT(*) n FROM users').get().n,0);stillEmpty.close();
  await f.halt(started.pid);
  // Provision chosen fixture credentials via actual OTP endpoints, using an
  // injected sender in a temporary app. The launcher retains production auth.
  const email=createEmailFixture(),setupApp=createApp({dbPath:config.dbPath,publicOrigin:config.publicOrigin,emailAuth:email.emailAuth});
  await new Promise((resolve,reject)=>{setupApp.server.once('error',reject);setupApp.server.listen(0,'127.0.0.1',resolve)});
  let owner;
  try{
    const provisioningConfig={...config,port:setupApp.server.address().port};
    const verified=await email.signup((route,body)=>request(provisioningConfig,route,{method:'POST',body}),fields);
    owner=await request(provisioningConfig,'/api/auth/setup',{method:'POST',body:verified});
    assert.equal(owner.status,201);assert.match(owner.setCookie,/; HttpOnly;/);assert.match(owner.setCookie,/; Secure(?:;|$)/);
  }finally{await new Promise(resolve=>setupApp.server.close(resolve))}
  started=await f.start();assert.equal(started.reused,false);assert.equal(started.needsSetup,false);
  const repeated=await f.start();assert.equal(repeated.reused,true);assert.equal(repeated.pid,started.pid);assert.equal(repeated.needsSetup,false);
  await f.halt(started.pid);started=await f.start();assert.equal(started.reused,false);assert.equal(started.needsSetup,false);
  const login=await request(config,'/api/auth/login',{method:'POST',body:{storeCode:'demo-space',username:'fixtureadmin',password}});assert.equal(login.status,200);
  assert.equal((await request(config,'/api/state',{cookie:login.setCookie.split(';')[0]})).status,200);
  assert.equal((await request(config,'/api/store',{method:'PATCH',cookie:login.setCookie.split(';')[0],body:{name:'No CSRF'}})).status,403);
  assert.equal((await request(config,'/api/auth/setup',{method:'POST',body:{}})).status,409);
});

test('an unrelated busy port and a marker pointing at another process are never replaced or stopped',linuxOnly,async t=>{
  const f=await fixture(t),{config}=f;
  const unrelated=http.createServer((req,res)=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({needsSetup:true,user:null}))});
  await new Promise((resolve,reject)=>{unrelated.once('error',reject);unrelated.listen(config.port,'127.0.0.1',resolve)});
  try{
    await assert.rejects(()=>f.start(),/Port .* unavailable.*No existing process was stopped/);assert.equal(fs.existsSync(config.dbPath),false);
    assert.equal((await request(config,'/still-here')).status,200);
  }finally{await new Promise(resolve=>unrelated.close(resolve))}
  fs.mkdirSync(path.dirname(config.markerPath),{recursive:true});
  fs.writeFileSync(config.markerPath,JSON.stringify({pid:process.pid,id:'0'.repeat(32),publicOrigin:config.publicOrigin,dbPath:config.dbPath,host:config.host,port:config.port,serverPath:config.serverPath}));
  await assert.rejects(()=>f.start(),/different process or configuration/);assert.equal(fs.existsSync(config.dbPath),false);
  assert.doesNotThrow(()=>process.kill(process.pid,0));
});

test('failure to record a newly spawned demo stops only that owned child',linuxOnly,async t=>{
  const f=await fixture(t),original=fs.writeFileSync;let ownedPid;
  fs.writeFileSync=function(file,data,...options){
    if(file===f.config.markerPath){ownedPid=JSON.parse(data).pid;throw Object.assign(new Error('Fixture marker write denied'),{code:'EACCES'})}
    return original.call(this,file,data,...options);
  };
  try{await assert.rejects(()=>f.start(),/Fixture marker write denied/)}finally{fs.writeFileSync=original}
  assert.ok(ownedPid);t.after(()=>stop(ownedPid));
  let running=true;
  for(let attempt=0;attempt<100&&running;attempt++){
    try{process.kill(ownedPid,0);await wait(20)}catch(error){if(error.code==='ESRCH')running=false;else throw error}
  }
  assert.equal(running,false,'a marker write failure must not leave an untracked backend running');
  assert.doesNotThrow(()=>process.kill(process.pid,0));
});

test('demo storage refuses symlinks into another database before starting anything',{skip:process.platform==='win32'&&'Fixture symbolic links require Unix permissions.'},async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'order-hub-codespaces-links-')),external=path.join(dir,'existing.sqlite'),demoRoot=path.join(dir,'demo');
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));fs.writeFileSync(external,'existing user data');
  const config=codespacesConfig(codespacesEnvironment,demoRoot);fs.mkdirSync(path.dirname(config.dbPath),{recursive:true});fs.symlinkSync(external,config.dbPath);
  await assert.rejects(()=>startDemo(config),/must not use symbolic links/);assert.equal(fs.readFileSync(external,'utf8'),'existing user data');assert.equal(fs.existsSync(config.markerPath),false);
});
