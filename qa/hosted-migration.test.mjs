import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {randomBytes,createHash} from 'node:crypto';
import {DatabaseSync,backup} from 'node:sqlite';
import {Pool} from 'pg';
import {initializeStorage,insertStore} from '../server/storage.mjs';
import {createPostgresSnapshotStore} from '../server/demo-postgres.mjs';
import {createVercelDemoHandler} from '../server/vercel-demo.mjs';
import {recoveryPasswordHash} from '../scripts/recover-owner.mjs';

const connectionString=process.env.ORDER_HUB_TEST_POSTGRES_URL;
const integration={skip:!connectionString&&'Set ORDER_HUB_TEST_POSTGRES_URL to an isolated loopback PostgreSQL fixture.'};
const origin='https://order-hub-migration-fixture.example';

async function inspect(snapshot,work){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'order-hub-inspect-migration-'));let db;
  try{
    await fs.chmod(directory,0o700);const file=path.join(directory,'saved.sqlite');await fs.writeFile(file,snapshot,{mode:0o600});db=new DatabaseSync(file,{readOnly:true});
    return work(db);
  }finally{try{db?.close()}finally{await fs.rm(directory,{recursive:true,force:true})}}
}

async function schemaThreeFixture(t){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'order-hub-schema-three-'));await fs.chmod(directory,0o700);let db;
  try{
    const file=path.join(directory,'legacy.sqlite');db=new DatabaseSync(file);initializeStorage(db);
    const store=insertStore(db,{name:'Schema three fixture owner',code:'fixture-existing'}),id=randomBytes(16).toString('hex'),hash=await recoveryPasswordHash('Fixture-owned-legacy-password');
    db.prepare('INSERT INTO users(id,tenant_id,username,name,password_hash,role,active,created_at) VALUES(?,?,?,?,?,?,?,?)').run(id,store.id,'existing_owner','Fixture owner',hash,'admin',1,new Date().toISOString());
    const token=randomBytes(32).toString('hex'),csrf=randomBytes(24).toString('hex');db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(createHash('sha256').update(token).digest('hex'),id,csrf,Date.now()+3_600_000);
    const state=db.prepare('SELECT data FROM tenant_state WHERE tenant_id=?').get(store.id).data;
    db.exec('DROP TABLE email_challenges; DROP TABLE email_rate_limits; ALTER TABLE users DROP COLUMN email; ALTER TABLE users DROP COLUMN email_verified_at; DELETE FROM schema_migrations WHERE version=4; PRAGMA user_version=3;');
    const saved=path.join(directory,'before.sqlite');await backup(db,saved);
    return {snapshot:await fs.readFile(saved),id,hash,store,state,cookie:'oh_session='+token,csrf};
  }finally{try{db?.close()}finally{await fs.rm(directory,{recursive:true,force:true})}}
}

async function hostedFixture(t){
  const namespace='qa-migration-'+randomBytes(12).toString('hex'),otherNamespace=namespace+'-other';
  const rawPool=new Pool({connectionString,ssl:false,max:3});let failCommit=false,failedCommits=0;
  const pool={
    async connect(){
      const client=await rawPool.connect();let updated=false;
      return {async query(...args){
        const sql=args[0];if(sql==='BEGIN')updated=false;
        if(sql.startsWith('UPDATE order_hub_demo_snapshots'))updated=true;
        if(sql==='COMMIT'&&updated&&failCommit){failCommit=false;failedCommits++;throw new Error('Fixture commit unavailable')}
        return client.query(...args);
      },release(error){client.release(error)}};
    },async end(){await rawPool.end()}
  };
  const store=createPostgresSnapshotStore({connectionString,namespace,pool,ssl:false});
  t.after(async()=>{
    try{
      await rawPool.query('DELETE FROM order_hub_demo_schema_backups WHERE namespace=ANY($1::text[])',[[namespace,otherNamespace]]);
      await rawPool.query('DELETE FROM order_hub_demo_snapshots WHERE namespace=ANY($1::text[])',[[namespace,otherNamespace]]);
    }finally{await store.close()}
  });
  const legacy=await schemaThreeFixture(t);
  await store.transaction(async()=>({snapshot:legacy.snapshot,attempts:[],result:null}));
  await rawPool.query('INSERT INTO order_hub_demo_snapshots(namespace,snapshot) VALUES($1,$2)',[otherNamespace,legacy.snapshot]);
  let handler=createVercelDemoHandler({store,environment:{ORDER_HUB_PUBLIC_ORIGIN:origin,VERCEL_ENV:'preview',VERCEL_GIT_COMMIT_REF:'vercel-demo'}});
  const server=http.createServer((req,res)=>handler(req,res));
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const request=(route='/api/account/auth/status')=>new Promise((resolve,reject)=>{
    const req=http.request({hostname:'127.0.0.1',port:server.address().port,path:route,headers:{Host:new URL(origin).host,Cookie:legacy.cookie}},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(Buffer.concat(chunks).toString()),cookie:res.headers['set-cookie']}));
    });req.on('error',reject);req.end();
  });
  return {legacy,namespace,otherNamespace,store,pool:rawPool,request,restart(){handler=createVercelDemoHandler({store,environment:{ORDER_HUB_PUBLIC_ORIGIN:origin,VERCEL_ENV:'preview',VERCEL_GIT_COMMIT_REF:'vercel-demo'}})},failNextCommit(){failCommit=true},get failedCommits(){return failedCommits}};
}

function assertLegacyIdentity(db,legacy,version){
  assert.equal(db.prepare('PRAGMA user_version').get().user_version,version);
  const owner=db.prepare('SELECT * FROM users WHERE id=?').get(legacy.id);assert.equal(owner.id,legacy.id);assert.equal(owner.password_hash,legacy.hash);assert.equal(owner.tenant_id,legacy.store.id);assert.equal(owner.username,'existing_owner');
  assert.equal(db.prepare('SELECT data FROM tenant_state WHERE tenant_id=?').get(legacy.store.id).data,legacy.state);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sessions WHERE user_id=?').get(legacy.id).n,1);
  assert.equal(db.prepare('PRAGMA quick_check').get().quick_check,'ok');
}

test('hosted schema migration durably backs up the original account before upgrading, keeps sessions/tenant state and never replaces the backup on cold requests',integration,async t=>{
  const f=await hostedFixture(t);let response=await f.request();assert.equal(response.status,200);assert.equal(response.data.needsSetup,false);assert.equal(response.data.user.id,f.legacy.id);assert.equal(response.data.store.id,f.legacy.store.id);
  const primary=await f.pool.query('SELECT snapshot FROM order_hub_demo_snapshots WHERE namespace=$1',[f.namespace]);
  await inspect(primary.rows[0].snapshot,db=>{assertLegacyIdentity(db,f.legacy,4);const user=db.prepare('SELECT email,email_verified_at FROM users WHERE id=?').get(f.legacy.id);assert.equal(user.email,null);assert.equal(user.email_verified_at,null);assert.ok(db.prepare('PRAGMA table_info(users)').all().some(column=>column.name==='email'));});
  const firstBackup=await f.pool.query('SELECT * FROM order_hub_demo_schema_backups WHERE namespace=$1',[f.namespace]);assert.equal(firstBackup.rows.length,1);assert.equal(firstBackup.rows[0].from_version,3);assert.equal(firstBackup.rows[0].to_version,4);
  await inspect(firstBackup.rows[0].snapshot,db=>{assertLegacyIdentity(db,f.legacy,3);assert.equal(db.prepare('PRAGMA table_info(users)').all().some(column=>column.name==='email'),false)});
  f.restart();response=await f.request('/api/account/state');assert.equal(response.status,200);assert.equal(response.data.user.id,f.legacy.id);
  const repeated=await f.pool.query('SELECT * FROM order_hub_demo_schema_backups WHERE namespace=$1',[f.namespace]);assert.equal(repeated.rows.length,1);assert.deepEqual(repeated.rows[0].snapshot,firstBackup.rows[0].snapshot);assert.deepEqual(repeated.rows[0].created_at,firstBackup.rows[0].created_at);
  const other=await f.pool.query('SELECT snapshot FROM order_hub_demo_snapshots WHERE namespace=$1',[f.otherNamespace]);assert.deepEqual(other.rows[0].snapshot,f.legacy.snapshot);assert.equal((await f.pool.query('SELECT COUNT(*)::integer n FROM order_hub_demo_schema_backups WHERE namespace=$1',[f.otherNamespace])).rows[0].n,0);
});

test('a failed hosted commit rolls back both migration backup and upgraded snapshot, emits no successful response/cookie and safely retries',integration,async t=>{
  const f=await hostedFixture(t);f.failNextCommit();const failure=await f.request();assert.equal(failure.status,503);assert.equal(failure.cookie,undefined);assert.equal(f.failedCommits,1);assert.doesNotMatch(JSON.stringify(failure.data),/Fixture commit unavailable|postgresql|password_hash/);
  const unchanged=await f.pool.query('SELECT snapshot FROM order_hub_demo_snapshots WHERE namespace=$1',[f.namespace]);assert.deepEqual(unchanged.rows[0].snapshot,f.legacy.snapshot);
  assert.equal((await f.pool.query('SELECT COUNT(*)::integer n FROM order_hub_demo_schema_backups WHERE namespace=$1',[f.namespace])).rows[0].n,0);
  f.restart();const retry=await f.request();assert.equal(retry.status,200);assert.equal(retry.data.user.id,f.legacy.id);
  const saved=await f.pool.query('SELECT snapshot,from_version,to_version FROM order_hub_demo_schema_backups WHERE namespace=$1',[f.namespace]);assert.equal(saved.rows.length,1);assert.equal(saved.rows[0].from_version,3);assert.equal(saved.rows[0].to_version,4);
  await inspect(saved.rows[0].snapshot,db=>assertLegacyIdentity(db,f.legacy,3));
});
