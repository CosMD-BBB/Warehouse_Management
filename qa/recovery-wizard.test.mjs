import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {EventEmitter} from 'node:events';
import {DatabaseSync,backup} from 'node:sqlite';
import {randomBytes,scrypt,timingSafeEqual} from 'node:crypto';
import {promisify} from 'node:util';
import {initializeStorage,insertStore} from '../server/storage.mjs';
import {createPostgresSnapshotStore} from '../server/demo-postgres.mjs';
import {recoverPostgresOwner,recoveryPasswordHash,promptHiddenPassword} from '../scripts/recover-owner.mjs';
import {parseWizardArguments,postgresRecoveryConfiguration,discoverOwnerSnapshots,ensurePrivateBackupDirectory,runOwnerRecoveryWizard} from '../scripts/recover-owner-wizard.mjs';

const target={storeCode:'fixture-one',username:'owner'},newPassword='Fix6!!';
const scryptAsync=promisify(scrypt);let initialHash;
const connectionString='postgresql://fixture:'+randomBytes(16).toString('hex')+'@example.neon.test/fixture?sslmode=disable&SSLCERT=untrusted&application_name=wizard-fixture';

async function matches(password,stored){const [salt,hex]=stored.split(':');return timingSafeEqual(await scryptAsync(password,salt,64,{N:32768,r:8,p:1,maxmem:64*1024*1024}),Buffer.from(hex,'hex'))}
function state(db){return {users:db.prepare('SELECT * FROM users ORDER BY id').all(),sessions:db.prepare('SELECT * FROM sessions ORDER BY user_id').all(),challenges:db.prepare('SELECT * FROM email_challenges ORDER BY id').all(),tenants:db.prepare('SELECT * FROM tenants ORDER BY id').all(),states:db.prepare('SELECT * FROM tenant_state ORDER BY tenant_id').all(),audit:db.prepare('SELECT * FROM security_audit ORDER BY id').all()}}
async function fixture(t,{ownerRole='admin',ownerActive=1,storeActive=1,version=4,publicMarker=false}={}){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'order-hub-wizard-fixture-'));await fs.chmod(directory,0o700);t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const file=path.join(directory,'fixture.sqlite'),db=new DatabaseSync(file);initializeStorage(db);initialHash||=await recoveryPasswordHash('Fixture-original-owner-password');
  const stores=[insertStore(db,{name:'Fixture one',code:'fixture-one'}),insertStore(db,{name:'Fixture two',code:'fixture-two'})];
  const users=[{id:'owner-one',tenant:stores[0].id,username:'owner',role:ownerRole,active:ownerActive},{id:'owner-two',tenant:stores[1].id,username:'owner',role:'admin',active:1}];
  for(const user of users){
    db.prepare('INSERT INTO users(id,tenant_id,username,name,password_hash,role,active,created_at) VALUES(?,?,?,?,?,?,?,?)').run(user.id,user.tenant,user.username,user.username,initialHash,user.role,user.active,new Date().toISOString());
    db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(user.id+'-session',user.id,'fixture-csrf',Date.now()+60000);
    db.prepare("INSERT INTO email_challenges(id,purpose,scope_hash,email,tenant_id,user_id,account_version,code_hash,expires_at,created_at) VALUES(?,'reset',?,?,?,?,?,?,?,?)").run(user.id+'-challenge','a'.repeat(64),'fixture@example.test',user.tenant,user.id,'b'.repeat(64),'c'.repeat(64),Date.now()+60000,Date.now());
  }
  db.prepare('UPDATE tenants SET active=? WHERE id=?').run(storeActive,stores[0].id);db.exec('PRAGMA user_version='+version);
  if(publicMarker)db.exec("CREATE TABLE public_demo_meta(marker TEXT PRIMARY KEY); INSERT INTO public_demo_meta VALUES('synthetic-guest-v1');");
  const before=state(db),exportFile=path.join(directory,'snapshot.sqlite');await backup(db,exportFile);db.close();const snapshot=await fs.readFile(exportFile);
  return {directory,snapshot,before,stores};
}
function fixturePool(rows,{queryFailure,commitFailure}={}){
  const events=[];let closed=0;
  return {events,get closed(){return closed},async connect(){let pending;return {async query(sql,values=[]){
    events.push({sql,values});if(queryFailure)throw new Error(queryFailure);
    if(/^SELECT count\(/i.test(sql))return {rows:[{count:String(rows.size),max_bytes:Math.max(0,...[...rows.values()].map(row=>row.snapshot?.length||0))}]};
    if(sql.startsWith('SELECT namespace, octet_length(snapshot)'))return {rows:[...rows].sort(([a],[b])=>a.localeCompare(b)).map(([namespace,row])=>({namespace,snapshot_bytes:row.snapshot?.length??null,updated_at:new Date('2026-10-08T05:00:00.000Z')}))};
    if(sql.startsWith('SELECT namespace, snapshot, updated_at'))return {rows:[...rows].filter(([namespace])=>!values.length||namespace===values[0]).sort(([a],[b])=>a.localeCompare(b)).map(([namespace,row])=>({namespace,snapshot:row.snapshot,updated_at:new Date('2026-10-08T05:00:00.000Z')}))};
    if(sql.startsWith('SELECT snapshot,attempts FROM order_hub_demo_snapshots')){const row=rows.get(values[0]);return {rows:row?[{snapshot:row.snapshot,attempts:structuredClone(row.attempts||[])}]:[]}}
    if(sql.startsWith('UPDATE order_hub_demo_snapshots')){pending={namespace:values[0],snapshot:Buffer.from(values[1]),attempts:JSON.parse(values[2])};return {rowCount:1}}
    if(sql==='COMMIT'&&pending){if(commitFailure)throw new Error(commitFailure);rows.set(pending.namespace,pending);pending=undefined}
    if(sql==='ROLLBACK')pending=undefined;
    return {rows:[],rowCount:1};
  },release(){events.push({sql:'RELEASE',values:[]})}}},async end(){closed++}};
}
function prompts(textAnswers,hiddenAnswers){return {promptText:async()=>{assert.ok(textAnswers.length,'unexpected visible prompt');return textAnswers.shift()},promptHidden:async()=>{assert.ok(hiddenAnswers.length,'unexpected hidden prompt');return hiddenAnswers.shift()}}}
function capture(){let value='';return {output:{write:message=>{value+=message}},get value(){return value}}}
function noSecrets(output,...values){for(const value of values)assert.equal(output.includes(value),false,'a private fixture value escaped into output')}
async function inspectSnapshot(directory,name,snapshot){const file=path.join(directory,name);await fs.writeFile(file,snapshot,{mode:0o600});const db=new DatabaseSync(file,{readOnly:true});try{return state(db)}finally{db.close()}}

test('wizard accepts explicit identity only and uses certificate-verified PostgreSQL TLS after removing URL SSL overrides',()=>{
  assert.deepEqual(parseWizardArguments(['--store','fixture-one','--username','owner']),target);
  for(const args of [['--store','fixture-one'],['--username','owner'],['--password',newPassword],['--connection-string',connectionString],['--store','fixture-one','--username','owner','--store','other']])assert.throws(()=>parseWizardArguments(args));
  const config=postgresRecoveryConfiguration(connectionString),url=new URL(config.connectionString);assert.deepEqual(config.ssl,{rejectUnauthorized:true});assert.equal(url.searchParams.get('application_name'),'wizard-fixture');assert.ok([...url.searchParams.keys()].every(name=>!name.toLowerCase().startsWith('ssl')));
  for(const value of ['https://example.test/db','postgres://user@example.test/db','postgres://user:password@example.test/','postgres://user:password@example.test/db#private','postgres://user:password@example.test/db\\unsafe']){
    let error;try{postgresRecoveryConfiguration(value)}catch(caught){error=caught}assert.ok(error,'invalid URI accepted');assert.equal(error.message.includes(value),false);
  }
});

test('discovery uses a read-only transaction and returns only the exact active admin/store while excluding public visitors',async t=>{
  const active=await fixture(t),warehouse=await fixture(t,{ownerRole:'warehouse'}),disabled=await fixture(t,{ownerActive:0}),inactive=await fixture(t,{storeActive:0}),publicDb=await fixture(t,{publicMarker:true}),legacy=await fixture(t,{version:3});
  const rows=new Map([['private-current',{snapshot:active.snapshot}],['private-legacy',{snapshot:legacy.snapshot}],['private-warehouse',{snapshot:warehouse.snapshot}],['private-disabled',{snapshot:disabled.snapshot}],['private-inactive',{snapshot:inactive.snapshot}],['private-public-marker',{snapshot:publicDb.snapshot}],['public-demo-visitor',{snapshot:active.snapshot}],['private-empty',{snapshot:null}]]),pool=fixturePool(rows);
  const before=new Map([...rows].map(([name,row])=>[name,row.snapshot&&Buffer.from(row.snapshot)])),matches=await discoverOwnerSnapshots({pool,...target,temporaryDirectory:active.directory});
  assert.deepEqual(matches.map(item=>item.namespace),['private-current','private-legacy']);assert.ok(matches.every(item=>item.storeCode===target.storeCode&&item.username===target.username));
  assert.ok(pool.events.some(item=>/^BEGIN.*READ ONLY/.test(item.sql)));assert.ok(pool.events.some(item=>item.sql==='COMMIT'));
  assert.ok(pool.events.every(item=>!/\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|FOR UPDATE)\b/i.test(item.sql)));
  for(const [name,row]of rows)assert.deepEqual(row.snapshot,before.get(name));
  assert.deepEqual(await discoverOwnerSnapshots({pool,...target,username:'owner-other',temporaryDirectory:active.directory}),[]);
  assert.deepEqual(await discoverOwnerSnapshots({pool,...target,storeCode:'missing-store',temporaryDirectory:active.directory}),[]);
});

test('discovery fails closed for malformed snapshots, unsupported schema and an excessive namespace list without mutating rows',async t=>{
  const item=await fixture(t),unsupported=await fixture(t,{version:2});
  for(const snapshot of [Buffer.from('not SQLite'),Buffer.concat([Buffer.from('SQLite format 3\0'),Buffer.alloc(512)]),unsupported.snapshot]){
    const rows=new Map([['private-invalid',{snapshot}]]),pool=fixturePool(rows);await assert.rejects(discoverOwnerSnapshots({pool,...target,temporaryDirectory:item.directory}));assert.deepEqual(rows.get('private-invalid').snapshot,snapshot);assert.ok(pool.events.some(event=>event.sql==='ROLLBACK'));assert.ok(pool.events.every(event=>!/^\s*(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)/i.test(event.sql)));
  }
  const rows=new Map(Array.from({length:101},(_,index)=>['private-'+index,{snapshot:item.snapshot}])),pool=fixturePool(rows);await assert.rejects(discoverOwnerSnapshots({pool,...target,temporaryDirectory:item.directory}));assert.ok(!pool.events.some(event=>event.sql.startsWith('SELECT namespace, snapshot')));
});

test('wizard never auto-selects an ambiguous namespace and cancellation, incorrect confirmation or mismatched passwords never call recovery',async t=>{
  const item=await fixture(t),rows=new Map([['private-first',{snapshot:item.snapshot}],['private-second',{snapshot:item.snapshot}]]);
  for(const [visible,hidden]of [[[''],[]],[['0'],[]],[['3'],[]],[['1','not-confirmed'],[]],[['2','fixture-one/owner'],[newPassword,'Other6!']]]){
    const pool=fixturePool(rows),printed=capture();let recoverCalls=0;
    await assert.rejects(runOwnerRecoveryWizard(['--store',target.storeCode,'--username',target.username],{input:{isTTY:true},environment:{DATABASE_URL:connectionString},createPool:async()=>pool,...prompts([...visible],[...hidden]),output:printed.output,temporaryDirectory:item.directory,ensureBackupDirectory:async()=>item.directory,recoverOwner:async()=>{recoverCalls++;throw new Error('unexpected recovery')}}));
    assert.equal(recoverCalls,0);assert.equal(pool.closed,1);assert.ok(pool.events.every(event=>!/^\s*(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)/i.test(event.sql)));noSecrets(printed.value,connectionString,newPassword);
  }
  const singlePool=fixturePool(new Map([['private-only',{snapshot:item.snapshot}]]));let singleCalls=0;
  await assert.rejects(runOwnerRecoveryWizard(['--store',target.storeCode,'--username',target.username],{input:{isTTY:true},environment:{DATABASE_URL:connectionString},createPool:async()=>singlePool,...prompts([''],[]),output:capture().output,temporaryDirectory:item.directory,recoverOwner:async()=>{singleCalls++}}));assert.equal(singleCalls,0);assert.equal(singlePool.closed,1);
});

test('wizard keeps URI and errors hidden, strips SSL overrides before pool creation and closes its pool on failure',async t=>{
  const item=await fixture(t),rawFailure='fixture-raw-error '+connectionString+' '+newPassword;
  const printed=capture();let receivedConfig,hiddenOptions;
  await assert.rejects(runOwnerRecoveryWizard(['--store',target.storeCode,'--username',target.username],{input:{isTTY:true},environment:{},output:printed.output,temporaryDirectory:item.directory,promptText:async()=>{throw new Error('unexpected visible prompt')},promptHidden:async options=>{hiddenOptions=options;return connectionString},createPool:async config=>{receivedConfig=config;throw new Error(rawFailure)}}),error=>{noSecrets(error.message,connectionString,newPassword,'fixture-raw-error');return true});
  assert.equal(hiddenOptions.maxLength,4096);assert.deepEqual(receivedConfig.ssl,{rejectUnauthorized:true});assert.ok([...new URL(receivedConfig.connectionString).searchParams.keys()].every(name=>!name.toLowerCase().startsWith('ssl')));noSecrets(printed.value,connectionString,newPassword,'fixture-raw-error');
  const pool=fixturePool(new Map([['private-fixture',{snapshot:item.snapshot}]]),{queryFailure:rawFailure}),other=capture();
  await assert.rejects(runOwnerRecoveryWizard(['--store',target.storeCode,'--username',target.username],{input:{isTTY:true},environment:{POSTGRES_URL:connectionString},output:other.output,createPool:async()=>pool,...prompts([],[]),temporaryDirectory:item.directory}),error=>{noSecrets(error.message,connectionString,newPassword,'fixture-raw-error');return true});assert.equal(pool.closed,1);noSecrets(other.value,connectionString,newPassword,'fixture-raw-error');
  const recoveryPool=fixturePool(new Map([['private-fixture',{snapshot:item.snapshot}]])),recoveryOutput=capture();
  await assert.rejects(runOwnerRecoveryWizard(['--store',target.storeCode,'--username',target.username],{input:{isTTY:true},environment:{DATABASE_URL:connectionString},output:recoveryOutput.output,createPool:async()=>recoveryPool,...prompts(['1','fixture-one/owner'],[newPassword,newPassword]),temporaryDirectory:item.directory,ensureBackupDirectory:async()=>item.directory,recoverOwner:async()=>{throw new Error(rawFailure)}}),error=>{noSecrets(error.message,connectionString,newPassword,'fixture-raw-error');return true});assert.equal(recoveryPool.closed,1);noSecrets(recoveryOutput.value,connectionString,newPassword,'fixture-raw-error');assert.doesNotMatch(recoveryOutput.value,/กู้รหัสผ่านแล้ว/);
});

test('hidden input accepts a long connection URI without echo and restores terminal raw mode when cancelled',async()=>{
  class Terminal extends EventEmitter{isTTY=true;isRaw=false;paused=true;isPaused(){return this.paused}pause(){this.paused=true}resume(){this.paused=false}setRawMode(value){this.isRaw=value}}
  const input=new Terminal(),printed=capture(),secret=connectionString+'&options='+randomBytes(140).toString('hex');
  const first=promptHiddenPassword({input,output:printed.output,maxLength:4096,label:'Connection URI: '});input.emit('data',Buffer.from(secret+'\r'));assert.equal(await first,secret);noSecrets(printed.value,secret,connectionString);assert.equal(input.isRaw,false);assert.equal(input.paused,true);
  const cancelled=promptHiddenPassword({input,output:printed.output,maxLength:4096});input.emit('data',Buffer.from(secret));input.emit('data',Buffer.from('\u0003'));await assert.rejects(cancelled);noSecrets(printed.value,secret,connectionString);assert.equal(input.isRaw,false);assert.equal(input.listenerCount('data'),0);
});

test('default backups are durable private 0700 folders and reject repository, temporary and symlink paths',async t=>{
  const repositoryRoot=path.resolve('.'),homeDirectory=await fs.mkdtemp('/workspace/order-hub-wizard-home-');await fs.chmod(homeDirectory,0o700);t.after(()=>fs.rm(homeDirectory,{recursive:true,force:true}));
  const backupDirectory=await ensurePrivateBackupDirectory({homeDirectory,repositoryRoot});assert.ok(path.isAbsolute(backupDirectory));assert.equal((await fs.stat(backupDirectory)).mode&0o777,0o700);assert.ok(!backupDirectory.startsWith(repositoryRoot+path.sep));assert.ok(!backupDirectory.startsWith(os.tmpdir()+path.sep));
  await assert.rejects(ensurePrivateBackupDirectory({homeDirectory:os.tmpdir(),repositoryRoot}));await assert.rejects(ensurePrivateBackupDirectory({homeDirectory:repositoryRoot,repositoryRoot}));
  await fs.rm(backupDirectory,{recursive:true});const outside=await fs.mkdtemp('/workspace/order-hub-wizard-link-');t.after(()=>fs.rm(outside,{recursive:true,force:true}));await fs.symlink(outside,backupDirectory);await assert.rejects(ensurePrivateBackupDirectory({homeDirectory,repositoryRoot}));
});

test('explicitly selected wizard recovery changes only that namespace/admin using a six-character fixture password and saves the complete before-image',async t=>{
  const item=await fixture(t),attempts=[['a'.repeat(64),{count:2,at:Date.now()}]],rows=new Map([['private-first',{snapshot:Buffer.from(item.snapshot),attempts:structuredClone(attempts)}],['private-second',{snapshot:Buffer.from(item.snapshot),attempts:structuredClone(attempts)}]]),pool=fixturePool(rows),printed=capture();let selected;
  const result=await runOwnerRecoveryWizard(['--store',target.storeCode,'--username',target.username],{input:{isTTY:true},environment:{ORDER_HUB_DEMO_DATABASE_URL:connectionString},output:printed.output,createPool:async()=>pool,...prompts(['2','fixture-one/owner'],[newPassword,newPassword]),temporaryDirectory:item.directory,ensureBackupDirectory:async()=>item.directory,recoverOwner:async options=>{
    selected=options;const store=createPostgresSnapshotStore({connectionString:options.connectionString,namespace:options.namespace,pool});return recoverPostgresOwner({...options,store});
  }});
  assert.equal(selected.namespace,'private-second');assert.equal(result.userId,'owner-one');assert.equal(selected.password.length,6);assert.equal(pool.closed,1);noSecrets(printed.value,newPassword,connectionString);
  assert.deepEqual(rows.get('private-first').snapshot,item.snapshot);assert.deepEqual(rows.get('private-first').attempts,attempts);assert.deepEqual(rows.get('private-second').attempts,attempts);assert.ok(pool.events.filter(event=>event.sql.startsWith('UPDATE ')).every(event=>event.values[0]==='private-second'));
  assert.equal((await fs.stat(result.backupFile)).mode&0o777,0o600);const saved=new DatabaseSync(result.backupFile,{readOnly:true});try{assert.deepEqual(state(saved),item.before)}finally{saved.close()}
  const after=await inspectSnapshot(item.directory,'recovered.sqlite',rows.get('private-second').snapshot),owner=after.users.find(user=>user.id==='owner-one');assert.equal(await matches(newPassword,owner.password_hash),true);assert.equal(owner.email,null);assert.equal(owner.email_verified_at,null);
  for(const before of item.before.users.filter(user=>user.id!=='owner-one'))assert.deepEqual(after.users.find(user=>user.id===before.id),before);assert.deepEqual(after.tenants,item.before.tenants);assert.deepEqual(after.states,item.before.states);assert.deepEqual(after.sessions,item.before.sessions.filter(session=>session.user_id!=='owner-one'));assert.ok(after.challenges.find(item=>item.user_id==='owner-one').used_at);assert.deepEqual(after.challenges.filter(item=>item.user_id!=='owner-one'),item.before.challenges.filter(item=>item.user_id!=='owner-one'));assert.equal(after.audit.length,1);assert.equal(after.audit[0].action,'owner_operator_recovery');
});
