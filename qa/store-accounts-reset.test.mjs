import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Readable} from 'node:stream';
import {DatabaseSync,backup} from 'node:sqlite';
import {randomBytes,createHash,scrypt,timingSafeEqual} from 'node:crypto';
import {promisify} from 'node:util';
import {initializeStorage,insertStore} from '../server/storage.mjs';
import {createSeed} from '../server/model.mjs';
import {createApp} from '../server/index.mjs';
import {createVercelDemoHandler} from '../server/vercel-demo.mjs';
import {createPostgresSnapshotStore} from '../server/demo-postgres.mjs';
import {replaceSqliteStoreAccounts,replacePostgresStoreAccounts,recoverPostgresOwner,recoveryPasswordHash,parseRecoveryArguments,runOwnerRecovery} from '../scripts/recover-owner.mjs';
import {runOwnerRecoveryWizard,parseWizardArguments} from '../scripts/recover-owner-wizard.mjs';

const oldPassword='Fixture-original-owner-password',newPassword='New6!!';
const digest=value=>createHash('sha256').update(value).digest('hex'),scryptAsync=promisify(scrypt);
let initialHash;
const tables=['tenants','users','sessions','tenant_state','connection_drafts','action_requests','security_audit','email_challenges','email_rate_limits'];
function state(db){return Object.fromEntries(tables.map(table=>[table,db.prepare('SELECT * FROM '+table+' ORDER BY rowid').all()]))}
async function matches(password,stored){const [salt,hex]=stored.split(':');return timingSafeEqual(await scryptAsync(password,salt,64,{N:32768,r:8,p:1,maxmem:64*1024*1024}),Buffer.from(hex,'hex'))}
async function fixture(t){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'order-hub-accounts-replace-'));await fs.chmod(directory,0o700);
  const dbPath=path.join(directory,'accounts.sqlite'),backupFile=path.join(directory,'before.sqlite'),db=new DatabaseSync(dbPath);initializeStorage(db);
  initialHash||=await recoveryPasswordHash(oldPassword);
  const data=createSeed();data.products[0].stock=57;
  const stores=[insertStore(db,{name:'Fixture existing store',code:'fixture-one'},data),insertStore(db,{name:'Fixture other store',code:'fixture-two'})];
  const users=[{id:'old-owner',tenant:stores[0].id,username:'owner',role:'admin',active:1},{id:'old-warehouse',tenant:stores[0].id,username:'warehouse',role:'warehouse',active:1},{id:'old-finance',tenant:stores[0].id,username:'finance',role:'finance',active:1},{id:'old-disabled',tenant:stores[0].id,username:'disabled',role:'admin',active:0},{id:'foreign-owner',tenant:stores[1].id,username:'owner',role:'admin',active:1}];
  for(const user of users){
    user.token=randomBytes(32).toString('hex');
    db.prepare('INSERT INTO users(id,tenant_id,username,name,password_hash,role,active,created_at,email,email_verified_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(user.id,user.tenant,user.username,user.username,initialHash,user.role,user.active,'fixture-created',user.username+'@fixture.example',Date.now());
    db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(digest(user.token),user.id,'fixture-csrf',Date.now()+60000);
    db.prepare("INSERT INTO email_challenges(id,purpose,scope_hash,email,tenant_id,user_id,account_version,code_hash,proof_hash,expires_at,created_at) VALUES(?,'reset',?,?,?,?,?,?,?,?,?)").run(user.id+'-challenge',digest(user.id),'fixture@example.test',user.tenant,user.id,digest('version'),digest('code'),digest('proof'),Date.now()+60000,Date.now());
  }
  db.prepare("INSERT INTO email_challenges(id,purpose,scope_hash,email,tenant_id,user_id,account_version,code_hash,expires_at,created_at) VALUES('legacy-unscoped','bind',?,'fixture@example.test',NULL,'old-owner',?,?,?,?)").run(digest('scope'),digest('version'),digest('code'),Date.now()+60000,Date.now());
  db.prepare("INSERT INTO email_challenges(id,purpose,scope_hash,email,code_hash,expires_at,created_at) VALUES('signup-unrelated','signup',?,'other@example.test',?,?,?)").run(digest('other-signup'),digest('code'),Date.now()+60000,Date.now());
  for(const store of stores){
    const actor=store.id===stores[0].id?'old-owner':'foreign-owner';
    db.prepare('INSERT INTO connection_drafts VALUES(?,?,?,?,?)').run(store.id,'Shopee','{"storeName":"Fixture shop"}','fixture-updated',actor);
    db.prepare('INSERT INTO action_requests VALUES(?,?,?,?,?)').run(store.id,actor,'fixture-request','fixture-fingerprint','{"ok":true}');
    db.prepare('INSERT INTO security_audit(at,tenant_id,actor_id,action,target_id) VALUES(?,?,?,?,?)').run('fixture-at',store.id,actor,'fixture_history','fixture-order');
  }
  db.prepare('INSERT INTO email_rate_limits VALUES(?,?,?)').run(digest('rate'),2,Date.now());
  const options={dbPath,backupFile,storeCode:'fixture-one',username:'owner',confirmation:'fixture-one/owner',accountsConfirmation:'fixture-one/RESET-ACCOUNTS',newUsername:'owner',newName:'New fixture owner',password:newPassword,expectedStoreName:stores[0].name,expectedAccountsCount:4};
  t.after(async()=>{try{db.close()}catch{}await fs.rm(directory,{recursive:true,force:true})});
  return {directory,dbPath,backupFile,db,stores,users,options};
}
function assertPreserved(before,after,targetTenant){
  for(const table of ['tenants','tenant_state','connection_drafts','action_requests','email_rate_limits'])assert.deepEqual(after[table],before[table],table+' must remain byte-for-byte unchanged');
  assert.deepEqual(after.security_audit.slice(0,before.security_audit.length),before.security_audit);
  assert.equal(after.security_audit.length,before.security_audit.length+1);
  assert.equal(after.security_audit.at(-1).action,'store_accounts_operator_replace');
  assert.equal(after.security_audit.at(-1).tenant_id,targetTenant);
  assert.deepEqual(after.users.filter(user=>user.tenant_id!==targetTenant),before.users.filter(user=>user.tenant_id!==targetTenant));
  const removed=new Set(before.users.filter(user=>user.tenant_id===targetTenant).map(user=>user.id));
  assert.deepEqual(after.sessions,before.sessions.filter(session=>!removed.has(session.user_id)));
  assert.deepEqual(after.email_challenges,before.email_challenges.filter(challenge=>challenge.tenant_id!==targetTenant&&!(challenge.tenant_id===null&&removed.has(challenge.user_id))));
}

test('replacing all store accounts atomically creates one fresh admin and preserves exact stock/orders, drafts, idempotency, history and other stores',async t=>{
  const f=await fixture(t),before=state(f.db),result=await replaceSqliteStoreAccounts(f.options),after=state(f.db);
  assert.equal(result.replacedAccounts,4);assert.equal(result.storeCode,'fixture-one');assert.equal(result.username,'owner');assert.match(result.userId,/^[a-f0-9]{32}$/);assert.ok(!f.users.some(user=>user.id===result.userId));
  assertPreserved(before,after,f.stores[0].id);
  const admins=after.users.filter(user=>user.tenant_id===f.stores[0].id);assert.equal(admins.length,1);
  const owner=admins[0];assert.equal(owner.id,result.userId);assert.equal(owner.username,'owner');assert.equal(owner.role,'admin');assert.equal(owner.active,1);assert.equal(owner.name,'New fixture owner');assert.equal(owner.email,null);assert.equal(owner.email_verified_at,null);
  assert.equal(await matches(newPassword,owner.password_hash),true);assert.equal(await matches(oldPassword,owner.password_hash),false);
  assert.equal(f.db.prepare('PRAGMA foreign_key_check').all().length,0);
  const saved=new DatabaseSync(f.backupFile,{readOnly:true});try{assert.deepEqual(state(saved),before)}finally{saved.close()}
  assert.equal((await fs.stat(f.backupFile)).mode&0o777,0o600);assert.equal((await fs.stat(f.directory)).mode&0o777,0o700);
});

async function request(app,route,{method='GET',body,cookie,csrf}={}){
  const origin='https://accounts-fixture.example',req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]);
  req.url=route;req.method=method;req.headers={host:new URL(origin).host,origin,'content-type':'application/json',...(cookie?{cookie}:{}),...(csrf?{'x-csrf-token':csrf}:{})};req.socket={remoteAddress:'127.0.0.1'};
  let raw='',status,headers={};const res={setHeader(key,value){headers[key.toLowerCase()]=value},writeHead(code,values){status=code;for(const[key,value]of Object.entries(values))headers[key.toLowerCase()]=value},end(value){raw+=value||''}};
  await app.handler(req,res);return {status,headers,j:JSON.parse(raw)};
}
test('old passwords and all prior sessions lose access, new admin logs in to the same populated store, and other tenant login remains valid',async t=>{
  const f=await fixture(t),before=state(f.db);await replaceSqliteStoreAccounts(f.options);
  const app=createApp({dbPath:f.dbPath,publicOrigin:'https://accounts-fixture.example',emailAuth:null});t.after(()=>app.close());
  for(const user of f.users.filter(user=>user.tenant===f.stores[0].id)){
    assert.equal((await request(app,'/api/state',{cookie:'oh_session='+user.token})).status,401);
    assert.equal((await request(app,'/api/auth/login',{method:'POST',body:{storeCode:'fixture-one',username:user.username,password:oldPassword}})).status,401);
  }
  const status=await request(app,'/api/auth/status');assert.equal(status.j.needsSetup,false);assert.equal(status.j.user,null);
  const login=await request(app,'/api/auth/login',{method:'POST',body:{storeCode:'fixture-one',username:'owner',password:newPassword}});assert.equal(login.status,200);assert.equal(login.j.store.id,f.stores[0].id);assert.equal(login.j.store.name,f.stores[0].name);assert.equal(login.j.user.emailVerified,false);
  const current=await request(app,'/api/state',{cookie:login.headers['set-cookie'].split(';')[0]});assert.equal(current.status,200);const oldData=JSON.parse(before.tenant_state.find(row=>row.tenant_id===f.stores[0].id).data);assert.deepEqual(current.j.data.orders,oldData.orders);assert.deepEqual(current.j.data.products,oldData.products);
  assert.equal((await request(app,'/api/auth/login',{method:'POST',body:{storeCode:'fixture-two',username:'owner',password:oldPassword}})).status,200);
});

test('replacement requires exact operator account and explicit store confirmation; stale selection, invalid new owner and guest stores fail without mutation or backup',async t=>{
  const f=await fixture(t),before=state(f.db);
  for(const changes of [{confirmation:'wrong'},{accountsConfirmation:undefined},{accountsConfirmation:'fixture-two/RESET-ACCOUNTS'},{expectedAccountsCount:3},{expectedStoreName:'Different store'},{newUsername:'bad user'},{newName:''},{newName:'Owner\nname'},{password:'short'},{username:'warehouse',confirmation:'fixture-one/warehouse'},{username:'disabled',confirmation:'fixture-one/disabled'},{storeCode:'missing-store',confirmation:'missing-store/owner',accountsConfirmation:'missing-store/RESET-ACCOUNTS'}]){
    await assert.rejects(replaceSqliteStoreAccounts({...f.options,...changes}));assert.deepEqual(state(f.db),before);await assert.rejects(fs.stat(f.backupFile),{code:'ENOENT'});
  }
  f.db.exec("CREATE TABLE public_demo_meta(marker TEXT PRIMARY KEY); INSERT INTO public_demo_meta VALUES('synthetic-guest-v1');");
  await assert.rejects(replaceSqliteStoreAccounts(f.options),/ผู้ทดลองสาธารณะ/);assert.deepEqual(state(f.db),before);
});

test('failed fresh-admin insertion or audit write rolls back deletion, sessions and OTPs together and retains a usable before-image',async t=>{
  for(const trigger of ["CREATE TRIGGER fixture_fail_insert BEFORE INSERT ON users BEGIN SELECT RAISE(ABORT,'fixture admin insertion failed'); END;","CREATE TRIGGER fixture_fail_audit BEFORE INSERT ON security_audit BEGIN SELECT RAISE(ABORT,'fixture audit failed'); END;"]){
    const f=await fixture(t);f.db.exec(trigger);const before=state(f.db);await assert.rejects(replaceSqliteStoreAccounts(f.options),/fixture/);assert.deepEqual(state(f.db),before);
    const saved=new DatabaseSync(f.backupFile,{readOnly:true});try{assert.deepEqual(state(saved),before)}finally{saved.close()}
  }
});

test('backup collisions and unsafe backup permissions fail closed before clearing any account',async t=>{
  const f=await fixture(t),before=state(f.db);await fs.writeFile(f.backupFile,'existing private backup',{mode:0o600});
  await assert.rejects(replaceSqliteStoreAccounts(f.options),/มีอยู่แล้ว/);assert.equal(await fs.readFile(f.backupFile,'utf8'),'existing private backup');assert.deepEqual(state(f.db),before);
  await fs.rm(f.backupFile);await fs.chmod(f.directory,0o755);await assert.rejects(replaceSqliteStoreAccounts(f.options),/0700/);assert.deepEqual(state(f.db),before);await fs.chmod(f.directory,0o700);
});

function fixturePool(rows,{failCommit=false}={}){
  const events=[];return {events,async connect(){let pending;return {async query(sql,values=[]){
    events.push({sql,values});
    if(/^SELECT count\(/i.test(sql))return {rows:[{count:String(rows.size),max_bytes:Math.max(...[...rows.values()].map(row=>row.snapshot.length))}]};
    if(sql.startsWith('SELECT namespace, octet_length(snapshot)'))return {rows:[...rows].map(([namespace,row])=>({namespace,snapshot_bytes:row.snapshot.length,updated_at:new Date('2026-10-08T05:00:00Z')}))};
    if(sql.startsWith('SELECT namespace, snapshot, updated_at')){const row=rows.get(values[0]);return {rows:row?[{namespace:values[0],snapshot:row.snapshot,updated_at:new Date('2026-10-08T05:00:00Z')}]:[]}}
    if(sql.startsWith('SELECT snapshot,attempts FROM order_hub_demo_snapshots')){const row=rows.get(values[0]);return {rows:row?[{snapshot:Buffer.from(row.snapshot),attempts:structuredClone(row.attempts)}]:[]}}
    if(sql.startsWith('UPDATE order_hub_demo_snapshots')){pending={namespace:values[0],snapshot:Buffer.from(values[1]),attempts:JSON.parse(values[2])};return {rowCount:1}}
    if(sql==='COMMIT'&&pending){if(failCommit)throw new Error('fixture PG commit failure');rows.set(pending.namespace,pending);pending=undefined}
    if(sql==='ROLLBACK')pending=undefined;
    return {rows:[],rowCount:1};
  },release(){}}},async end(){}};
}
async function postgresFixture(t,settings){
  const f=await fixture(t),exportFile=path.join(f.directory,'export.sqlite');await backup(f.db,exportFile);const snapshot=await fs.readFile(exportFile),attempts=[[digest('login-rate'),{count:2,at:Date.now()}]],rows=new Map([['fixture-private',{snapshot,attempts}],['foreign-private',{snapshot:Buffer.from(snapshot),attempts:[]}]]),pool=fixturePool(rows,settings);
  const store=createPostgresSnapshotStore({connectionString:'postgresql://fixture:fixture@127.0.0.1:5432/fixture',namespace:'fixture-private',pool,ssl:false});t.after(()=>store.close());
  return {...f,snapshot,attempts,rows,pool,store,options:{...f.options,store,namespace:'fixture-private'}};
}
test('Postgres replacement row-locks only the selected private snapshot and preserves other namespaces and rate limits',async t=>{
  const f=await postgresFixture(t),before=state(f.db),result=await replacePostgresStoreAccounts(f.options);assert.equal(result.replacedAccounts,4);
  assert.deepEqual(f.rows.get('foreign-private').snapshot,f.snapshot);assert.deepEqual(f.rows.get('fixture-private').attempts,f.attempts);
  assert.ok(f.pool.events.some(event=>event.sql.endsWith('WHERE namespace=$1 FOR UPDATE')));assert.ok(f.pool.events.filter(event=>event.sql.startsWith('UPDATE ')).every(event=>event.values[0]==='fixture-private'));
  const file=path.join(f.directory,'persisted.sqlite');await fs.writeFile(file,f.rows.get('fixture-private').snapshot,{mode:0o600});const after=new DatabaseSync(file,{readOnly:true});try{assertPreserved(before,state(after),f.stores[0].id)}finally{after.close()}
  const saved=new DatabaseSync(f.backupFile,{readOnly:true});try{assert.deepEqual(state(saved),before)}finally{saved.close()}
});

test('a failed PostgreSQL commit keeps every old account and snapshot and an immutable backup without exposing a claimable store',async t=>{
  const f=await postgresFixture(t,{failCommit:true});await assert.rejects(replacePostgresStoreAccounts(f.options),/commit failure/);
  assert.deepEqual(f.rows.get('fixture-private').snapshot,f.snapshot);assert.deepEqual(f.rows.get('foreign-private').snapshot,f.snapshot);assert.deepEqual(f.rows.get('fixture-private').attempts,f.attempts);assert.equal((await fs.stat(f.backupFile)).mode&0o777,0o600);
  await assert.rejects(replacePostgresStoreAccounts({...f.options,namespace:'public-demo-visitor',backupFile:path.join(f.directory,'public.sqlite')}),/ผู้ทดลองสาธารณะ/);
});

test('a replacement admin remains editable through the actual Vercel account user route across persisted requests',async t=>{
  const f=await postgresFixture(t),result=await replacePostgresStoreAccounts(f.options);
  const hosted={handler:createVercelDemoHandler({store:f.store,emailAuth:null,environment:{ORDER_HUB_PUBLIC_ORIGIN:'https://accounts-fixture.example',VERCEL_ENV:'preview',VERCEL_GIT_COMMIT_REF:'vercel-demo'}})};
  const login=await request(hosted,'/api/account/auth/login',{method:'POST',body:{storeCode:'fixture-one',username:'owner',password:newPassword}});assert.equal(login.status,200);assert.equal(login.j.user.id,result.userId);
  const cookie=login.headers['set-cookie'].split(';')[0],patched=await request(hosted,'/api/account/users/'+result.userId,{method:'PATCH',body:{name:'Edited fixture admin'},cookie,csrf:login.j.csrf});assert.equal(patched.status,200);assert.equal(patched.j.ok,true);
  const members=await request(hosted,'/api/account/users',{cookie});assert.equal(members.status,200);assert.equal(members.j.users.length,1);assert.equal(members.j.users[0].id,result.userId);assert.equal(members.j.users[0].name,'Edited fixture admin');assert.equal(members.j.users[0].role,'admin');
  const after=await request(hosted,'/api/account/state',{cookie});assert.equal(after.status,200);assert.equal(after.j.store.id,f.stores[0].id);assert.equal(after.j.data.products[0].stock,57);
});

test('wizard replacement displays and rechecks store/count, asks a separate typed confirmation and creates a fresh owner while keeping secrets hidden',async t=>{
  const f=await postgresFixture(t),output={value:'',write(value){this.value+=value}},connectionString='postgresql://fixture:private-fixture@example.neon.test/fixture',visible=['1','fixture-one/owner','fixture-one/RESET-ACCOUNTS','fresh-owner','Fresh fixture owner'],hidden=[newPassword,newPassword];let supplied;
  assert.deepEqual(parseWizardArguments(['--replace-accounts','--store','fixture-one','--username','owner']),{replaceAccounts:true,storeCode:'fixture-one',username:'owner'});
  const result=await runOwnerRecoveryWizard(['--replace-accounts','--store','fixture-one','--username','owner'],{input:{isTTY:true},output,environment:{DATABASE_URL:connectionString},createPool:async()=>f.pool,promptText:async()=>{assert.ok(visible.length);return visible.shift()},promptHidden:async()=>{assert.ok(hidden.length);return hidden.shift()},temporaryDirectory:f.directory,ensureBackupDirectory:async()=>f.directory,recoverOwner:async options=>{supplied=options;return recoverPostgresOwner({...options,store:f.store})}});
  assert.equal(result.username,'fresh-owner');assert.equal(result.replacedAccounts,4);assert.equal(supplied.expectedAccountsCount,4);assert.equal(supplied.expectedStoreName,'Fixture existing store');assert.equal(supplied.accountsConfirmation,'fixture-one/RESET-ACCOUNTS');
  assert.match(output.value,/Fixture existing store/);assert.match(output.value,/จำนวนบัญชีทั้งหมดในร้าน: 4/);assert.equal(output.value.includes(newPassword),false);assert.equal(output.value.includes(connectionString),false);
  for(const answers of [['1','fixture-one/owner','no'],['1','fixture-one/owner','fixture-one/RESET-ACCOUNTS','bad user','Owner']]){
    let calls=0;await assert.rejects(runOwnerRecoveryWizard(['--replace-accounts','--store','fixture-one','--username','owner'],{input:{isTTY:true},output,environment:{DATABASE_URL:connectionString},createPool:async()=>fixturePool(new Map([['fixture-private',{snapshot:f.snapshot,attempts:[]}]])),promptText:async()=>answers.shift(),promptHidden:async()=>{throw new Error('must not prompt password')},temporaryDirectory:f.directory,recoverOwner:async()=>{calls++}}));assert.equal(calls,0);
  }
  const args=['--sqlite',f.dbPath,'--store','fixture-one','--username','owner','--backup-file',f.backupFile,'--replace-accounts','--new-username','new-owner','--new-name','New owner','--confirm','fixture-one/owner','--confirm-accounts','fixture-one/RESET-ACCOUNTS'];assert.equal(parseRecoveryArguments(args).replaceAccounts,true);
  assert.throws(()=>parseRecoveryArguments(args.filter(value=>value!=='--replace-accounts')));
});

test('the no-argument Mac wizard offers both operations and cancelling the operation menu makes no change',async t=>{
  const f=await postgresFixture(t),before=Buffer.from(f.snapshot),answers=['fixture-one','owner','1','fixture-one/owner',''],output={value:'',write(value){this.value+=value}};let calls=0;
  await assert.rejects(runOwnerRecoveryWizard([],{input:{isTTY:true},output,environment:{DATABASE_URL:'postgresql://fixture:private-fixture@example.neon.test/fixture'},createPool:async()=>f.pool,promptText:async()=>{assert.ok(answers.length);return answers.shift()},promptHidden:async()=>{throw new Error('cancelled operation must not request password')},temporaryDirectory:f.directory,recoverOwner:async()=>{calls++}}),/ยกเลิก/);
  assert.equal(calls,0);assert.deepEqual(f.rows.get('fixture-private').snapshot,before);assert.ok(f.pool.events.every(event=>!/^\s*(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)/i.test(event.sql)));assert.match(output.value,/1\. เปลี่ยนรหัส/);assert.match(output.value,/2\. ล้างบัญชี/);
});

test('CLI replacement previews exact store/account count, reads a private password file, and rejects a wrong reset confirmation without changes',async t=>{
  const f=await fixture(t),before=state(f.db),passwordFile=path.join(f.directory,'chosen-password.txt');await fs.writeFile(passwordFile,newPassword+'\n',{mode:0o600});
  const args=['--sqlite',f.dbPath,'--store','fixture-one','--username','owner','--backup-file',f.backupFile,'--replace-accounts','--new-username','fresh-owner','--new-name','Fresh owner','--password-file',passwordFile,'--confirm','fixture-one/owner','--confirm-accounts','fixture-one/RESET-ACCOUNTS'],output={value:'',write(value){this.value+=value}};
  await assert.rejects(runOwnerRecovery([...args.slice(0,-1),'wrong-store/RESET-ACCOUNTS'],{input:{isTTY:false},output,environment:{}}),/ยกเลิก/);assert.deepEqual(state(f.db),before);await assert.rejects(fs.stat(f.backupFile),{code:'ENOENT'});
  const result=await runOwnerRecovery(args,{input:{isTTY:false},output,environment:{}});assert.equal(result.username,'fresh-owner');assert.equal(result.replacedAccounts,4);assertPreserved(before,state(f.db),f.stores[0].id);
  assert.match(output.value,/ร้าน: Fixture existing store \(fixture-one\)/);assert.match(output.value,/จำนวนบัญชีทั้งหมดที่จะล้าง: 4/);assert.equal(output.value.includes(newPassword),false);
});
