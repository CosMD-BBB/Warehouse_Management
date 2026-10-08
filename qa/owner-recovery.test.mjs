import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {EventEmitter} from 'node:events';
import {DatabaseSync,backup} from 'node:sqlite';
import {scrypt,timingSafeEqual} from 'node:crypto';
import {promisify} from 'node:util';
import {initializeStorage,insertStore} from '../server/storage.mjs';
import {createPostgresSnapshotStore} from '../server/demo-postgres.mjs';
import {recoverSqliteOwner,recoverPostgresOwner,recoveryPasswordHash,readRecoveryPasswordFile,promptHiddenPassword,parseRecoveryArguments,runOwnerRecovery} from '../scripts/recover-owner.mjs';

const oldPassword='Fixture-original-owner-password',newPassword='Fix6!!';
const scryptAsync=promisify(scrypt);let initialHash;
const rootDir=path.resolve('.');
async function matches(password,stored){const [salt,hex]=stored.split(':');const value=await scryptAsync(password,salt,64,{N:32768,r:8,p:1,maxmem:64*1024*1024});return timingSafeEqual(value,Buffer.from(hex,'hex'))}
async function fixture(t){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'order-hub-owner-fixture-'));await fs.chmod(directory,0o700);
  const dbPath=path.join(directory,'account.sqlite'),db=new DatabaseSync(dbPath);initializeStorage(db);
  initialHash||=await recoveryPasswordHash(oldPassword);
  const stores=[insertStore(db,{name:'Fixture one',code:'fixture-one'}),insertStore(db,{name:'Fixture two',code:'fixture-two'})];
  const users=[{id:'owner-one',tenant:stores[0].id,username:'owner',role:'admin',active:1},{id:'owner-two',tenant:stores[1].id,username:'owner',role:'admin',active:1},{id:'warehouse',tenant:stores[0].id,username:'warehouse',role:'warehouse',active:1},{id:'finance',tenant:stores[0].id,username:'finance',role:'finance',active:1},{id:'inactive',tenant:stores[0].id,username:'disabled',role:'admin',active:0}];
  for(const user of users){
    db.prepare('INSERT INTO users(id,tenant_id,username,name,password_hash,role,active,created_at) VALUES(?,?,?,?,?,?,?,?)').run(user.id,user.tenant,user.username,user.username,initialHash,user.role,user.active,new Date().toISOString());
    db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(user.id+'-session',user.id,'fixture-csrf',Date.now()+60000);
    db.prepare("INSERT INTO email_challenges(id,purpose,scope_hash,email,tenant_id,user_id,account_version,code_hash,expires_at,created_at) VALUES(?,'reset',?,?,?,?,?,?,?,?)").run(user.id+'-challenge','a'.repeat(64),'fixture@example.test',user.tenant,user.id,'b'.repeat(64),'c'.repeat(64),Date.now()+60000,Date.now());
  }
  const backupFile=path.join(directory,'before.sqlite');
  t.after(async()=>{try{db.close()}catch{}await fs.rm(directory,{recursive:true,force:true})});
  return {db,dbPath,directory,backupFile,stores,users,options:{dbPath,backupFile,storeCode:'fixture-one',username:'owner',confirmation:'fixture-one/owner',password:newPassword}};
}
function selected(db){return {users:db.prepare('SELECT * FROM users ORDER BY id').all(),sessions:db.prepare('SELECT * FROM sessions ORDER BY user_id').all(),challenges:db.prepare('SELECT * FROM email_challenges ORDER BY id').all(),states:db.prepare('SELECT * FROM tenant_state ORDER BY tenant_id').all(),audit:db.prepare('SELECT * FROM security_audit').all()}}

test('offline SQLite recovery backs up committed WAL and atomically changes one admin, revokes its sessions/proofs and preserves other tenants and email',async t=>{
  const fixtureValue=await fixture(t),{db,options,backupFile}=fixtureValue,before=selected(db);
  const result=await recoverSqliteOwner(options);assert.equal(result.userId,'owner-one');
  const after=selected(db),owner=after.users.find(user=>user.id==='owner-one');
  assert.equal(await matches(newPassword,owner.password_hash),true);assert.equal(await matches(oldPassword,owner.password_hash),false);assert.equal(owner.email,null);assert.equal(owner.email_verified_at,null);
  for(const original of before.users.filter(user=>user.id!=='owner-one'))assert.deepEqual(after.users.find(user=>user.id===original.id),original);
  assert.deepEqual(after.states,before.states);assert.deepEqual(after.sessions,before.sessions.filter(session=>session.user_id!=='owner-one'));
  assert.ok(after.challenges.find(item=>item.user_id==='owner-one').used_at);
  assert.deepEqual(after.challenges.filter(item=>item.user_id!=='owner-one'),before.challenges.filter(item=>item.user_id!=='owner-one'));
  assert.equal(after.audit.length,1);assert.equal(after.audit[0].action,'owner_operator_recovery');assert.equal(after.audit[0].actor_id,null);assert.equal(after.audit[0].tenant_id,fixtureValue.stores[0].id);
  const saved=new DatabaseSync(backupFile,{readOnly:true});try{assert.deepEqual(selected(saved),before)}finally{saved.close()}
  assert.equal((await fs.stat(backupFile)).mode&0o777,0o600);
});

test('wrong store/account, non-admin, disabled owner and public guest databases never get changed or backed up',async t=>{
  const {db,options,backupFile}=await fixture(t),before=selected(db);
  for(const target of [{storeCode:'missing-store',username:'owner'},{storeCode:'fixture-one',username:'missing'},{storeCode:'fixture-one',username:'warehouse'},{storeCode:'fixture-one',username:'finance'},{storeCode:'fixture-one',username:'disabled'}]){
    await assert.rejects(recoverSqliteOwner({...options,...target,confirmation:target.storeCode+'/'+target.username}),/Admin/);assert.deepEqual(selected(db),before);
    await assert.rejects(fs.stat(backupFile),{code:'ENOENT'});
  }
  db.exec("CREATE TABLE public_demo_meta(marker TEXT PRIMARY KEY); INSERT INTO public_demo_meta VALUES('synthetic-guest-v1');");
  await assert.rejects(recoverSqliteOwner(options),/ผู้ทดลองสาธารณะ/);assert.deepEqual(selected(db),before);await assert.rejects(fs.stat(backupFile),{code:'ENOENT'});
});

test('recovery cancellation, unsafe paths and backup collisions preserve the original account',async t=>{
  const {db,options,backupFile,directory}=await fixture(t),before=selected(db);
  await assert.rejects(recoverSqliteOwner({...options,confirmation:'no'}),/ยกเลิก/);
  for(const password of [undefined,'short','x'.repeat(129),'valid-length\npassword'])await assert.rejects(recoverSqliteOwner({...options,password}),/รหัสผ่าน/);
  await fs.writeFile(backupFile,'keep-existing-backup',{mode:0o600});await assert.rejects(recoverSqliteOwner(options),/มีอยู่แล้ว/);assert.equal(await fs.readFile(backupFile,'utf8'),'keep-existing-backup');
  await fs.rm(backupFile);const link=path.join(directory,'account-link.sqlite');await fs.symlink(options.dbPath,link);await assert.rejects(recoverSqliteOwner({...options,dbPath:link}),/symlink/);
  await fs.chmod(directory,0o755);await assert.rejects(recoverSqliteOwner(options),/0700/);await fs.chmod(directory,0o700);
  assert.deepEqual(selected(db),before);
});

test('a mutation or audit failure rolls back password/session/proofs together and leaves a usable before-image backup',async t=>{
  const {db,options,backupFile}=await fixture(t);db.exec("CREATE TRIGGER fixture_fail_recovery BEFORE INSERT ON security_audit BEGIN SELECT RAISE(ABORT,'fixture audit failure'); END;");const before=selected(db);
  await assert.rejects(recoverSqliteOwner(options),/fixture audit failure/);assert.deepEqual(selected(db),before);
  const saved=new DatabaseSync(backupFile,{readOnly:true});try{assert.deepEqual(selected(saved),before)}finally{saved.close()}
});

test('only owner-controlled private password files are accepted, and CLI has no default account/password or plaintext-password arguments',async t=>{
  const {directory}=await fixture(t),file=path.join(directory,'password.txt');await fs.writeFile(file,newPassword+'\n',{mode:0o600});
  assert.equal(await readRecoveryPasswordFile(file),newPassword);
  await fs.chmod(file,0o644);await assert.rejects(readRecoveryPasswordFile(file),/0600/);await fs.chmod(file,0o600);
  const symlink=path.join(directory,'password-link.txt');await fs.symlink(file,symlink);await assert.rejects(readRecoveryPasswordFile(symlink),/symlink/);
  const hardlink=path.join(directory,'password-hardlink.txt');await fs.link(file,hardlink);await assert.rejects(readRecoveryPasswordFile(file),/hardlink/);await fs.rm(hardlink);
  await fs.writeFile(file,newPassword+'\nextra',{mode:0o600});await assert.rejects(readRecoveryPasswordFile(file),/รหัสผ่าน/);
  for(const args of [[],['--sqlite','/private/account.sqlite'],['--password',newPassword],['--postgres','--store','fixture-one','--username','owner','--backup-file','/private/before.sqlite'],['--sqlite','/private/account.sqlite','--store','fixture-one','--username','owner','--backup-file','/private/before.sqlite','--password-file',file]])assert.throws(()=>parseRecoveryArguments(args));
  let printed='';await runOwnerRecovery(['--help'],{environment:{ORDER_HUB_PASSWORD:'never-use-or-print-this'},output:{write:message=>{printed+=message}}});assert.doesNotMatch(printed,/never-use-or-print-this/);assert.match(printed,/ACCOUNT_RECOVERY/);
  assert.equal(rootDir,path.resolve('.'),'utility import does not change working directory');
});

test('hidden password prompts never echo characters and restore terminal state on completion or cancellation',async()=>{
  class Terminal extends EventEmitter{isTTY=true;isRaw=false;paused=true;isPaused(){return this.paused}pause(){this.paused=true}resume(){this.paused=false}setRawMode(value){this.isRaw=value}}
  const input=new Terminal();let printed='';const output={write:value=>{printed+=value}};
  const first=promptHiddenPassword({input,output});input.emit('data',Buffer.from(newPassword+'\r'));assert.equal(await first,newPassword);assert.equal(input.isRaw,false);assert.equal(input.paused,true);assert.equal(printed.includes(newPassword),false);
  const unicode=promptHiddenPassword({input,output}),bytes=Buffer.from('รหัสผ่านภาษาไทย');input.emit('data',bytes.subarray(0,1));input.emit('data',Buffer.concat([bytes.subarray(1),Buffer.from('\r')]));assert.equal(await unicode,'รหัสผ่านภาษาไทย');assert.doesNotMatch(printed,/รหัสผ่านภาษาไทย/);
  const cancelled=promptHiddenPassword({input,output});input.emit('data',Buffer.from('\u0003'));await assert.rejects(cancelled,/ยกเลิก/);assert.equal(input.isRaw,false);assert.equal(input.listenerCount('data'),0);assert.equal(input.listenerCount('end'),0);
});

function postgresFixturePool(rows,{failCommit=false}={}){
  const events=[];return {events,async connect(){let pending;return {async query(sql,values=[]){
    events.push({sql,values});
    if(sql.startsWith('SELECT snapshot,attempts FROM order_hub_demo_snapshots')){const row=rows.get(values[0]);return {rows:[{snapshot:row?.snapshot?Buffer.from(row.snapshot):null,attempts:structuredClone(row?.attempts||[])}]}}
    if(sql.startsWith('UPDATE order_hub_demo_snapshots')){pending={namespace:values[0],snapshot:Buffer.from(values[1]),attempts:JSON.parse(values[2])};return {rowCount:1}}
    if(sql==='COMMIT'&&pending){if(failCommit)throw new Error('fixture PG commit failure');rows.set(pending.namespace,pending);pending=undefined}
    if(sql==='ROLLBACK')pending=undefined;return {rows:[],rowCount:1};
  },release(){}}},async end(){}};
}
async function postgresFixture(t,{failCommit=false}={}){
  const item=await fixture(t),exportFile=path.join(item.directory,'fixture-export.sqlite');await backup(item.db,exportFile);const snapshot=await fs.readFile(exportFile);
  const attempts=[['a'.repeat(64),{count:2,at:Date.now()}]],rows=new Map([['fixture-private',{snapshot,attempts}],['another-private',{snapshot:Buffer.from(snapshot),attempts:[]}]]),pool=postgresFixturePool(rows,{failCommit});
  const store=createPostgresSnapshotStore({connectionString:'postgresql://fixture:fixture@127.0.0.1:5432/fixture',namespace:'fixture-private',pool,ssl:false});t.after(()=>store.close());
  return {...item,snapshot,attempts,rows,pool,store,options:{...item.options,store,namespace:'fixture-private'}};
}

test('Postgres recovery writes a durable private before-image before row-locked commit and keeps other namespace and rate limits intact',async t=>{
  const {db,options,snapshot,attempts,rows,pool,backupFile,directory}=await postgresFixture(t),before=selected(db);
  const result=await recoverPostgresOwner(options);assert.equal(result.userId,'owner-one');assert.equal(pool.events.filter(event=>event.sql==='COMMIT').length,2);
  assert.ok(pool.events.some(event=>event.sql==='SELECT snapshot,attempts FROM order_hub_demo_snapshots WHERE namespace=$1 FOR UPDATE'));
  assert.ok(pool.events.filter(event=>event.sql.startsWith('UPDATE ')).every(event=>event.values[0]==='fixture-private'));
  assert.deepEqual(rows.get('another-private').snapshot,snapshot);assert.deepEqual(rows.get('fixture-private').attempts,attempts);
  const saved=new DatabaseSync(backupFile,{readOnly:true});try{assert.deepEqual(selected(saved),before)}finally{saved.close()}
  const afterPath=path.join(directory,'persisted.sqlite');await fs.writeFile(afterPath,rows.get('fixture-private').snapshot,{mode:0o600});const after=new DatabaseSync(afterPath,{readOnly:true});try{assert.equal(await matches(newPassword,after.prepare("SELECT password_hash FROM users WHERE id='owner-one'").get().password_hash),true);assert.deepEqual(selected(after).states,before.states)}finally{after.close()}
});

test('Postgres commit failure retains prior account snapshot plus backup; unknown namespace and public guest snapshot never overwrite data',async t=>{
  const {options,rows,snapshot,backupFile,directory}=await postgresFixture(t,{failCommit:true});
  await assert.rejects(recoverPostgresOwner(options),/commit failure/);assert.deepEqual(rows.get('fixture-private').snapshot,snapshot);assert.equal((await fs.stat(backupFile)).mode&0o777,0o600);
  const unknownBackup=path.join(directory,'unknown-before.sqlite');rows.set('fixture-private',{snapshot:null,attempts:[]});await assert.rejects(recoverPostgresOwner({...options,backupFile:unknownBackup}),/ไม่พบบัญชีเดิม/);await assert.rejects(fs.stat(unknownBackup),{code:'ENOENT'});
  await assert.rejects(recoverPostgresOwner({...options,namespace:'public-demo-visitor',backupFile:unknownBackup}),/ผู้ทดลองสาธารณะ/);
  const publicPath=path.join(directory,'public.sqlite');await fs.writeFile(publicPath,snapshot,{mode:0o600});const publicDb=new DatabaseSync(publicPath);publicDb.exec("CREATE TABLE public_demo_meta(marker TEXT PRIMARY KEY); INSERT INTO public_demo_meta VALUES('synthetic-guest-v1');");const publicBackup=path.join(directory,'public-export.sqlite');await backup(publicDb,publicBackup);publicDb.close();const publicSnapshot=await fs.readFile(publicBackup);rows.set('fixture-private',{snapshot:publicSnapshot,attempts:[]});
  await assert.rejects(recoverPostgresOwner({...options,backupFile:unknownBackup}),/ผู้ทดลองสาธารณะ/);assert.deepEqual(rows.get('fixture-private').snapshot,publicSnapshot);await assert.rejects(fs.stat(unknownBackup),{code:'ENOENT'});
});
