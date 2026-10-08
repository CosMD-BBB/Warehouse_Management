import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createApp} from '../server/index.mjs';
import {initializeStorage} from '../server/storage.mjs';
import {createResendEmailAuth,deliverEmailJobs} from '../server/email-auth.mjs';
import {createEmailFixture} from './email-fixture.mjs';
import {backupStorageBeforeMigration} from '../server/migration-backup.mjs';

const PASSWORD='Fix6!!',NEW_PASSWORD='New6!!';
async function harness(t,{configured=true,deferEmailDelivery=false,sendFailure=false}={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'order-hub-email-')),dbPath=path.join(dir,'fixture.sqlite');
  let clock=Date.now(),app,origin;const fixture=createEmailFixture({now:()=>clock,sendFailure});
  async function start(){app=createApp({dbPath,emailAuth:configured?fixture.emailAuth:null,deferEmailDelivery});await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${app.server.address().port}`}
  async function stop(){if(app?.server.listening)await new Promise(resolve=>app.server.close(resolve))}
  await start();t.after(async()=>{await stop();fs.rmSync(dir,{recursive:true,force:true})});
  async function request(route,{method='GET',body,session,originOverride}={}){
    const headers={};if(session?.cookie)headers.Cookie=session.cookie;
    if(method!=='GET'){headers['Content-Type']='application/json';headers.Origin=originOverride||origin;if(session?.csrf)headers['X-CSRF-Token']=session.csrf}
    const response=await fetch(origin+route,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
    return {status:response.status,j:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};
  }
  const post=(route,body,session)=>request(route,{method:'POST',body,session});
  const fields=(storeCode='main',username='owner')=>({storeCode,storeName:`Store ${storeCode}`,username,name:'Fixture owner',password:PASSWORD});
  async function signup(storeCode='main',username='owner',email='owner@fixture.example',route='/api/auth/setup'){
    const body=await fixture.signup((route,body)=>post(route,body),{...fields(storeCode,username),email});
    const result=await post(route,body);assert.equal(result.status,201);
    return {result,body,session:{cookie:result.cookie,csrf:result.j.csrf,id:result.j.user.id}};
  }
  async function challenge(purpose,details={},session){
    const result=await post('/api/auth/email/request',{purpose,email:'owner@fixture.example',storeCode:'main',username:'owner',...details},session);
    assert.equal(result.status,200);return {result,message:fixture.messages.findLast(message=>message.challengeId===result.j.challengeId)};
  }
  async function prove(purpose,details={},session){const c=await challenge(purpose,details,session);assert.ok(c.message);const r=await post('/api/auth/email/verify',{challengeId:c.result.j.challengeId,code:c.message.code},session);assert.equal(r.status,200);return {...c,token:r.j.verificationToken}}
  return {get app(){return app},fixture,request,post,fields,signup,challenge,prove,advance(ms){clock+=ms},async restart(){await stop();await start()}};
}

test('email setup fails closed when sender or HMAC configuration is missing',async t=>{
  const h=await harness(t,{configured:false});
  assert.equal((await h.request('/api/auth/status')).j.emailEnabled,false);
  for(const route of ['/api/auth/email/request','/api/auth/setup','/api/auth/register','/api/auth/reset']){
    const r=await h.post(route,{...h.fields(),email:'owner@fixture.example',purpose:'reset'});assert.equal(r.status,503);assert.equal(r.cookie,undefined);
  }
  assert.equal(h.app.db.prepare('SELECT COUNT(*) n FROM users').get().n,0);
  assert.equal(createResendEmailAuth({RESEND_API_KEY:'fixture',ORDER_HUB_EMAIL_FROM:'owner@fixture.example',ORDER_HUB_EMAIL_OTP_SECRET:'short'}),null);
});

test('signup requires mailbox OTP and a one-use proof bound to email, store and username',async t=>{
  const h=await harness(t),base={...h.fields(),email:'owner@fixture.example'};
  assert.equal((await h.post('/api/auth/setup',base)).status,400);
  const c=await h.challenge('signup');assert.match(c.message.code,/^\d{6}$/);
  const stored=h.app.db.prepare('SELECT * FROM email_challenges WHERE id=?').get(c.result.j.challengeId);
  assert.equal(stored.code_hash.length,64);assert.equal(Object.values(stored).includes(c.message.code),false);
  assert.equal((await h.post('/api/auth/email/verify',{challengeId:c.result.j.challengeId,code:c.message.code==='000000'?'111111':'000000'})).status,400);
  const verified=await h.post('/api/auth/email/verify',{challengeId:c.result.j.challengeId,code:c.message.code});assert.equal(verified.status,200);
  const body={...base,verificationToken:verified.j.verificationToken};
  for(const change of [{email:'other@fixture.example'},{storeCode:'another'},{username:'another'}])assert.equal((await h.post('/api/auth/setup',{...body,...change})).status,400);
  for(const password of ['12345','x'.repeat(129)]){
    assert.equal((await h.post('/api/auth/setup',{...body,password})).status,400);
    assert.equal(h.app.db.prepare('SELECT used_at FROM email_challenges WHERE id=?').get(c.result.j.challengeId).used_at,null);
  }
  const created=await h.post('/api/auth/setup',body);assert.equal(created.status,201);assert.equal(created.j.user.email,'owner@fixture.example');assert.equal(created.j.user.emailVerified,true);
  assert.equal((await h.post('/api/auth/register',body)).status,400);
  assert.equal((await h.post('/api/auth/email/verify',{challengeId:c.result.j.challengeId,code:c.message.code})).status,400);
  assert.ok(h.app.db.prepare('SELECT used_at FROM email_challenges WHERE id=?').get(c.result.j.challengeId).used_at);
});

test('proof consumption rolls back if account provisioning fails',async t=>{
  const h=await harness(t),body=await h.fixture.signup((route,body)=>h.post(route,body),h.fields());
  h.app.db.exec("CREATE TRIGGER fixture_fail_store BEFORE INSERT ON tenants BEGIN SELECT RAISE(ABORT,'Fixture store failure'); END;");
  assert.equal((await h.post('/api/auth/setup',body)).status,500);
  assert.equal(h.app.db.prepare('SELECT used_at FROM email_challenges').get().used_at,null);
  assert.equal(h.app.db.prepare('SELECT COUNT(*) n FROM tenants').get().n,0);
  h.app.db.exec('DROP TRIGGER fixture_fail_store');assert.equal((await h.post('/api/auth/setup',body)).status,201);
});

test('OTP attempts, cooldown and expiry persist across server restarts',async t=>{
  const h=await harness(t),c=await h.challenge('signup'),bad=c.message.code==='000000'?'111111':'000000';
  assert.equal((await h.post('/api/auth/email/request',{purpose:'signup',email:'owner@fixture.example',storeCode:'main',username:'owner'})).status,429);
  for(let i=0;i<3;i++)assert.equal((await h.post('/api/auth/email/verify',{challengeId:c.result.j.challengeId,code:bad})).status,400);
  await h.restart();
  for(let i=0;i<2;i++)assert.equal((await h.post('/api/auth/email/verify',{challengeId:c.result.j.challengeId,code:bad})).status,400);
  assert.equal((await h.post('/api/auth/email/verify',{challengeId:c.result.j.challengeId,code:c.message.code})).status,400);
  assert.equal(h.app.db.prepare('SELECT attempts FROM email_challenges WHERE id=?').get(c.result.j.challengeId).attempts,5);
  h.advance(60_001);const fresh=await h.prove('signup');h.advance(600_001);
  assert.equal((await h.post('/api/auth/setup',{...h.fields(),email:'owner@fixture.example',verificationToken:fresh.token})).status,400);
});

test('resending invalidates the old code and durable mailbox quotas bound requests',async t=>{
  const h=await harness(t),first=await h.challenge('signup');h.advance(60_001);const next=await h.challenge('signup');
  assert.equal((await h.post('/api/auth/email/verify',{challengeId:first.result.j.challengeId,code:first.message.code})).status,400);
  assert.equal((await h.post('/api/auth/email/verify',{challengeId:next.result.j.challengeId,code:next.message.code})).status,200);
  for(let i=0;i<8;i++){h.advance(60_001);assert.equal((await h.post('/api/auth/email/request',{purpose:'signup',email:'owner@fixture.example',storeCode:`shop-${i}`,username:'owner'})).status,200)}
  await h.restart();h.advance(60_001);assert.equal((await h.post('/api/auth/email/request',{purpose:'signup',email:'owner@fixture.example',storeCode:'shop-last',username:'owner'})).status,429);
});

test('recovery has generic responses and cannot target another tenant',async t=>{
  const h=await harness(t),first=await h.signup();h.advance(60_001);const second=await h.signup('second','owner','owner@fixture.example','/api/auth/register');
  const before=h.fixture.messages.length,known=await h.challenge('reset'),unknown=await h.challenge('reset',{storeCode:'missing'});
  assert.deepEqual(Object.keys(known.result.j),Object.keys(unknown.result.j));assert.equal(known.result.j.message,unknown.result.j.message);assert.equal(h.fixture.messages.length,before+1);
  assert.equal((await h.post('/api/auth/email/verify',{challengeId:unknown.result.j.challengeId,code:'123456'})).status,400);
  const verified=await h.post('/api/auth/email/verify',{challengeId:known.result.j.challengeId,code:known.message.code});assert.equal(verified.status,200);
  const body={email:'owner@fixture.example',storeCode:'main',username:'owner',verificationToken:verified.j.verificationToken,password:NEW_PASSWORD};
  assert.equal((await h.post('/api/auth/reset',{...body,storeCode:'second'})).status,400);
  assert.equal((await h.post('/api/auth/reset',body)).status,200);
  assert.equal((await h.request('/api/state',{session:first.session})).status,401);
  assert.equal((await h.request('/api/state',{session:second.session})).status,200);
  assert.equal((await h.post('/api/auth/login',{storeCode:'second',username:'owner',password:PASSWORD})).status,200);
});

test('reset revokes every session and outstanding challenge, prevents replay and persists new password',async t=>{
  const h=await harness(t),owner=await h.signup();
  const login=await h.post('/api/auth/login',{storeCode:'main',username:'owner',password:PASSWORD});
  const extra={cookie:login.cookie,csrf:login.j.csrf};const proof=await h.prove('reset');
  const body={storeCode:'main',username:'owner',email:'owner@fixture.example',verificationToken:proof.token,password:NEW_PASSWORD};
  for(const password of ['12345','x'.repeat(129)]){
    assert.equal((await h.post('/api/auth/reset',{...body,password})).status,400);
    assert.equal(h.app.db.prepare('SELECT used_at FROM email_challenges WHERE id=?').get(proof.result.j.challengeId).used_at,null);
    assert.equal((await h.request('/api/state',{session:owner.session})).status,200);
  }
  assert.equal((await h.post('/api/auth/reset',body)).status,200);
  assert.equal((await h.request('/api/state',{session:owner.session})).status,401);assert.equal((await h.request('/api/state',{session:extra})).status,401);
  assert.equal(h.app.db.prepare('SELECT COUNT(*) n FROM sessions').get().n,0);
  assert.equal(h.app.db.prepare("SELECT COUNT(*) n FROM email_challenges WHERE user_id=? AND used_at IS NULL").get(owner.session.id).n,0);
  assert.equal((await h.post('/api/auth/reset',body)).status,400);await h.restart();
  assert.equal((await h.post('/api/auth/login',{storeCode:'main',username:'owner',password:PASSWORD})).status,401);
  assert.equal((await h.post('/api/auth/login',{storeCode:'main',username:'owner',password:NEW_PASSWORD})).status,200);
});

test('changing password invalidates a previously verified reset proof',async t=>{
  const h=await harness(t),owner=await h.signup(),proof=await h.prove('reset');
  for(const password of ['12345','x'.repeat(129)]){
    assert.equal((await h.post('/api/auth/password',{currentPassword:PASSWORD,password},owner.session)).status,400);
    assert.equal((await h.request('/api/state',{session:owner.session})).status,200);
  }
  assert.equal((await h.post('/api/auth/password',{currentPassword:PASSWORD,password:NEW_PASSWORD},owner.session)).status,200);
  assert.equal((await h.request('/api/state',{session:owner.session})).status,401);
  assert.equal((await h.post('/api/auth/login',{storeCode:'main',username:'owner',password:PASSWORD})).status,401);
  assert.equal((await h.post('/api/auth/login',{storeCode:'main',username:'owner',password:NEW_PASSWORD})).status,200);
  assert.equal((await h.post('/api/auth/reset',{storeCode:'main',username:'owner',email:'owner@fixture.example',verificationToken:proof.token,password:PASSWORD})).status,400);
});

test('registration and admin member provisioning retain the 6–128 password boundaries',async t=>{
  const h=await harness(t),owner=await h.signup();
  const registration=await h.fixture.signup((route,body)=>h.post(route,body),{...h.fields('registered'),email:'registered@fixture.example'});
  for(const password of ['12345','x'.repeat(129)])assert.equal((await h.post('/api/auth/register',{...registration,password})).status,400);
  const registered=await h.post('/api/auth/register',registration);assert.equal(registered.status,201);
  assert.equal((await h.post('/api/auth/login',{storeCode:'registered',username:'owner',password:PASSWORD})).status,200);
  const fields={username:'boundary-member',name:'Boundary fixture',role:'finance'};
  for(const password of ['12345','x'.repeat(129)])assert.equal((await h.post('/api/users',{...fields,password},owner.session)).status,400);
  const created=await h.post('/api/users',{...fields,password:PASSWORD},owner.session);assert.equal(created.status,201);
  const login=await h.post('/api/auth/login',{storeCode:'main',username:fields.username,password:PASSWORD}),session={cookie:login.cookie,csrf:login.j.csrf};assert.equal(login.status,200);
  for(const password of ['12345','x'.repeat(129)]){
    assert.equal((await h.request(`/api/users/${created.j.id}`,{method:'PATCH',body:{password},session:owner.session})).status,400);
    assert.equal((await h.request('/api/state',{session})).status,200);
  }
  const maximum='x'.repeat(128);
  assert.equal((await h.request(`/api/users/${created.j.id}`,{method:'PATCH',body:{password:maximum},session:owner.session})).status,200);
  assert.equal((await h.request('/api/state',{session})).status,401);
  assert.equal((await h.post('/api/auth/login',{storeCode:'main',username:fields.username,password:maximum})).status,200);
  assert.equal((await h.request(`/api/users/${created.j.id}`,{method:'PATCH',body:{password:NEW_PASSWORD},session:owner.session})).status,200);
  assert.equal((await h.post('/api/auth/login',{storeCode:'main',username:fields.username,password:NEW_PASSWORD})).status,200);
});

test('existing members bind an email only with their current password and authenticated proof',async t=>{
  const h=await harness(t),owner=await h.signup();
  const member=await h.post('/api/users',{username:'member',name:'Fixture member',role:'finance',password:PASSWORD},owner.session);assert.equal(member.status,201);
  const login=await h.post('/api/auth/login',{storeCode:'main',username:'member',password:PASSWORD}),session={cookie:login.cookie,csrf:login.j.csrf};
  assert.equal(login.j.user.emailVerified,false);assert.equal(login.j.user.email,null);
  const before=h.fixture.messages.length,unknown=await h.challenge('reset',{username:'member',email:'member@fixture.example'});assert.equal(h.fixture.messages.length,before);assert.equal(unknown.message,undefined);
  assert.equal((await h.post('/api/auth/email/request',{purpose:'bind',email:'member@fixture.example',currentPassword:'wrong'},session)).status,400);
  const proof=await h.prove('bind',{email:'member@fixture.example',currentPassword:PASSWORD},session);
  assert.equal((await h.post('/api/auth/email',{email:'member@fixture.example',verificationToken:proof.token,currentPassword:PASSWORD},owner.session)).status,400);
  const bound=await h.post('/api/auth/email',{email:'member@fixture.example',verificationToken:proof.token,currentPassword:PASSWORD},session);assert.equal(bound.status,200);assert.equal(bound.j.user.emailVerified,true);
  h.advance(60_001);const reset=await h.prove('reset',{username:'member',email:'member@fixture.example'});assert.ok(reset.token);
});

test('email binding rejects stale session and proof after account deactivation',async t=>{
  const h=await harness(t),owner=await h.signup();
  const member=await h.post('/api/users',{username:'member',name:'Member',role:'warehouse',password:PASSWORD},owner.session);
  const login=await h.post('/api/auth/login',{storeCode:'main',username:'member',password:PASSWORD}),session={cookie:login.cookie,csrf:login.j.csrf};
  const proof=await h.prove('bind',{email:'member@fixture.example',currentPassword:PASSWORD},session);
  assert.equal((await h.request(`/api/users/${member.j.id}`,{method:'PATCH',body:{active:false},session:owner.session})).status,200);
  assert.equal((await h.post('/api/auth/email',{email:'member@fixture.example',verificationToken:proof.token,currentPassword:PASSWORD},session)).status,401);
});

test('new-store owners also require email proof and keep the original store session',async t=>{
  const h=await harness(t),owner=await h.signup();
  assert.equal((await h.post('/api/stores',{...h.fields('second'),email:'second@fixture.example'},owner.session)).status,400);
  const body=await h.fixture.signup((route,body)=>h.post(route,body,owner.session),{...h.fields('second'),email:'second@fixture.example'});
  for(const password of ['12345','x'.repeat(129)])assert.equal((await h.post('/api/stores',{...body,password},owner.session)).status,400);
  assert.equal((await h.post('/api/stores',body,owner.session)).status,201);
  const current=await h.request('/api/state',{session:owner.session});assert.equal(current.j.store.code,'main');
  const login=await h.post('/api/auth/login',{storeCode:'second',username:'owner',password:PASSWORD});assert.equal(login.j.user.emailVerified,true);
  const data=await h.request('/api/state',{session:{cookie:login.cookie}});assert.equal(data.j.data.orders.length,0);assert.ok(data.j.data.products.every(product=>product.stock===0));
});

test('deferred email jobs wait for the hosting commit and remain usable after app closes',async t=>{
  const h=await harness(t,{deferEmailDelivery:true});
  const result=await h.post('/api/auth/email/request',{purpose:'signup',email:'owner@fixture.example',storeCode:'main',username:'owner'});
  assert.equal(result.status,200);assert.equal(h.fixture.messages.length,0);
  const jobs=h.app.takeEmailJobs();assert.equal(jobs.length,1);assert.equal(h.app.takeEmailJobs().length,0);
  await h.restart();await deliverEmailJobs(jobs);assert.equal(h.fixture.messages.length,1);
  const message=h.fixture.messages[0];assert.equal((await h.post('/api/auth/email/verify',{challengeId:result.j.challengeId,code:message.code})).status,200);
});

test('provider failure is sanitized, recovery stays generic, and codes never appear in responses',async t=>{
  const h=await harness(t),owner=await h.signup();h.fixture.emailAuth.sendOtp=async()=>{throw Error('Fixture key and provider body must not escape')};
  const reset=await h.challenge('reset');assert.equal(reset.result.status,200);assert.equal(reset.message,undefined);
  const bind=await h.post('/api/auth/email/request',{purpose:'bind',email:'new@fixture.example',currentPassword:PASSWORD},owner.session);assert.equal(bind.status,424);assert.equal(JSON.stringify(bind).includes('Fixture key'),false);
  assert.equal((await h.post('/api/auth/email/request',{purpose:'signup',email:'bad\n@example.test',storeCode:'other',username:'owner'})).status,400);
});

test('schema 3 migration preserves existing hashes, users, sessions and stock while adding nullable email',()=>{
  const db=new DatabaseSync(':memory:');
  db.exec("CREATE TABLE tenants(id TEXT PRIMARY KEY,code TEXT NOT NULL UNIQUE,name TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL);CREATE TABLE users(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL REFERENCES tenants(id),username TEXT NOT NULL,name TEXT NOT NULL,password_hash TEXT NOT NULL,role TEXT NOT NULL,active INTEGER NOT NULL,created_at TEXT NOT NULL,UNIQUE(tenant_id,username));CREATE TABLE sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),csrf TEXT NOT NULL,expires_at INTEGER NOT NULL);CREATE TABLE tenant_state(tenant_id TEXT PRIMARY KEY REFERENCES tenants(id),data TEXT NOT NULL);INSERT INTO tenants VALUES('fixture-tenant','main','Fixture store',1,'fixture-date');INSERT INTO users VALUES('fixture-user','fixture-tenant','owner','Owner','fixture-salt:fixture-hash','admin',1,'fixture-date');INSERT INTO sessions VALUES('fixture-token','fixture-user','fixture-csrf',9999999999999);INSERT INTO tenant_state VALUES('fixture-tenant','{\"fixtureStock\":27}');PRAGMA user_version=3;");
  try{initializeStorage(db);assert.equal(db.prepare('PRAGMA user_version').get().user_version,4);const user=db.prepare('SELECT * FROM users').get();assert.equal(user.id,'fixture-user');assert.equal(user.password_hash,'fixture-salt:fixture-hash');assert.equal(user.email,null);assert.equal(user.email_verified_at,null);assert.equal(db.prepare('SELECT COUNT(*) n FROM sessions').get().n,1);assert.equal(JSON.parse(db.prepare('SELECT data FROM tenant_state').get().data).fixtureStock,27);initializeStorage(db);assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0)}finally{db.close()}
});

test('local startup backs up an existing WAL database before schema migration and refuses failed backup',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'order-hub-email-backup-')),dbPath=path.join(dir,'existing.sqlite'),db=new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode=WAL;CREATE TABLE users(id TEXT PRIMARY KEY,password_hash TEXT NOT NULL);INSERT INTO users VALUES('fixture-owner','fixture-salted-hash');PRAGMA user_version=3;");
  try{
    const before=await backupStorageBeforeMigration(dbPath);assert.equal(before.fromVersion,3);assert.equal(fs.statSync(before.path).mode&0o777,0o600);
    const saved=new DatabaseSync(before.path,{readOnly:true});try{assert.equal(saved.prepare('SELECT password_hash FROM users').get().password_hash,'fixture-salted-hash');assert.equal(saved.prepare('PRAGMA user_version').get().user_version,3)}finally{saved.close()}
    assert.equal(db.prepare('PRAGMA table_info(users)').all().some(column=>column.name==='email'),false);
    fs.rmSync(path.join(dir,'backups'),{recursive:true,force:true});fs.writeFileSync(path.join(dir,'backups'),'blocked fixture directory');
    await assert.rejects(backupStorageBeforeMigration(dbPath),/backup failed/);assert.equal(db.prepare('PRAGMA user_version').get().user_version,3);
  }finally{db.close();fs.rmSync(dir,{recursive:true,force:true})}
});

test('Resend transport fixes its HTTPS endpoint, bounds delivery and sanitizes failures',async()=>{
  const originalFetch=globalThis.fetch,calls=[];
  const configuration=createResendEmailAuth({RESEND_API_KEY:'fixture-key',ORDER_HUB_EMAIL_FROM:'Order Hub <owner@fixture.example>',ORDER_HUB_EMAIL_OTP_SECRET:'fixture-secret-with-at-least-thirty-two-bytes'});
  try{
    globalThis.fetch=async(url,options)=>{calls.push({url,options});return {ok:true}};
    await configuration.sendOtp({email:'customer@fixture.example',code:'000123',purpose:'signup',storeCode:'fixture-shop',challengeId:'fixture-challenge'});
    assert.equal(calls[0].url,'https://api.resend.com/emails');assert.equal(calls[0].options.redirect,'error');assert.ok(calls[0].options.signal instanceof AbortSignal);
    assert.equal(calls[0].options.headers['Idempotency-Key'],'order-hub-fixture-challenge');assert.deepEqual(JSON.parse(calls[0].options.body).to,['customer@fixture.example']);
    assert.ok(JSON.parse(calls[0].options.body).text.includes('000123'));
    globalThis.fetch=async()=>{throw new Error('fixture-key private provider details')};
    await assert.rejects(configuration.sendOtp({email:'customer@fixture.example',code:'000123',purpose:'reset',challengeId:'another-fixture'}),error=>error.message==='Email delivery unavailable');
    globalThis.fetch=async()=>({ok:false,status:403,body:'fixture-key private provider details'});
    await assert.rejects(configuration.sendOtp({email:'customer@fixture.example',code:'000123',purpose:'reset',challengeId:'third-fixture'}),error=>error.message==='Email delivery unavailable');
  }finally{globalThis.fetch=originalFetch}
});
