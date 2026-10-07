import test from 'node:test';
import assert from 'node:assert/strict';
import {createPostgresSnapshotStore} from '../server/demo-postgres.mjs';

const databaseURL='postgresql://fixture:fixture@127.0.0.1:5432/order_hub_fixture';
const sqlite=()=>Buffer.concat([Buffer.from('SQLite format 3\0'),Buffer.alloc(4080)]);
const attemptKey='a'.repeat(64),attempts=[[attemptKey,{count:2,at:1700000000000}]];
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}};

function mockPool({hook}={}){
  const rows=new Map(),events=[],releases=[];
  let ended=0;
  const pool={
    rows,events,releases,get ended(){return ended},
    async connect(){
      let pending;
      return {
        async query(sql,values=[]){
          events.push({sql,values});
          if(hook)await hook(sql,values,{pending});
          if(sql.startsWith('SELECT snapshot,attempts')){
            const row=rows.get(values[0])||{snapshot:null,attempts:[]};
            return {rows:[{snapshot:row.snapshot&&Buffer.from(row.snapshot),attempts:structuredClone(row.attempts)}]};
          }
          if(sql.startsWith('UPDATE order_hub_demo_snapshots')){
            pending={namespace:values[0],snapshot:Buffer.from(values[1]),attempts:JSON.parse(values[2])};
            return {rowCount:1,rows:[]};
          }
          if(sql==='COMMIT'&&pending){rows.set(pending.namespace,pending);pending=undefined}
          if(sql==='ROLLBACK')pending=undefined;
          return {rows:[],rowCount:1};
        },
        release(error){releases.push(error)}
      };
    },
    async end(){ended++}
  };
  return pool;
}

function store(pool,namespace='fixture-preview'){
  return createPostgresSnapshotStore({connectionString:databaseURL,namespace,pool,ssl:false});
}

test('demo transport rejects unsafe database configuration before opening a connection and never includes credentials in errors',()=>{
  const pool=mockPool(),base={connectionString:databaseURL,namespace:'fixture-preview',pool};
  for(const namespace of ['',undefined,'ab','*','preview/*','x'.repeat(81),'ร้านทดลอง']){
    assert.throws(()=>createPostgresSnapshotStore({...base,namespace}),/namespace/);
  }
  for(const connectionString of [undefined,'http://fixture:keep-this-secret@localhost/db','postgresql://fixture:keep-this-secret@localhost/','postgresql://fixture@localhost/db','postgresql://fixture:keep-this-secret@localhost/db#fragment','postgresql://fixture:keep-this-secret@localhost/db\n']){
    assert.throws(()=>createPostgresSnapshotStore({...base,connectionString}),error=>{
      assert.match(error.message,/PostgreSQL/);assert.doesNotMatch(error.message,/keep-this-secret/);return true;
    });
  }
  for(const ssl of [{rejectUnauthorized:false},{rejectUnauthorized:true,checkServerIdentity:()=>{}},'disable',null]){
    assert.throws(()=>createPostgresSnapshotStore({...base,ssl}),/TLS/);
  }
  assert.throws(()=>createPostgresSnapshotStore({...base,connectionString:'postgresql://fixture:fixture@db.example/db',ssl:false}),/injected loopback/);
  assert.throws(()=>createPostgresSnapshotStore({...base,pool:undefined,ssl:false}),/injected loopback/);
  assert.equal(pool.events.length,0);
});

test('demo transport locks before loading state and returns the buffered response only after COMMIT',async()=>{
  const committing=deferred(),permitCommit=deferred();
  const pool=mockPool({hook:async(sql,_values,{pending})=>{
    if(sql==='COMMIT'&&pending){committing.resolve();await permitCommit.promise}
  }}),s=store(pool),reply={status:201,cookie:'fixture-cookie'};
  let resolved=false;
  const operation=s.transaction(async state=>{
    assert.equal(state.snapshot,null);assert.deepEqual(state.attempts,[]);
    assert.match(pool.events.at(-1).sql,/FOR UPDATE$/);
    return {snapshot:sqlite(),attempts,result:reply};
  }).then(value=>{resolved=true;return value});
  await committing.promise;
  assert.equal(resolved,false,'session response must remain hidden before commit');
  assert.equal(pool.rows.has('fixture-preview'),false,'new state must not become durable before commit');
  permitCommit.resolve();
  assert.equal(await operation,reply);
  assert.deepEqual(pool.rows.get('fixture-preview').attempts,attempts);
  assert.equal(pool.events.filter(e=>e.sql.includes('pg_advisory_xact_lock')).length,1);
  assert.equal(pool.events.filter(e=>e.sql==='COMMIT').length,2,'schema and state commit separately');
  assert.equal(pool.releases.length,2);assert.ok(pool.releases.every(error=>error===undefined));
  await s.close();assert.equal(pool.ended,1);
  await assert.rejects(s.transaction(()=>{}),/closed/);
});

test('callback failure or invalid snapshot/attempt data rolls back without publishing a result',async()=>{
  const pool=mockPool(),s=store(pool),failure=new Error('fixture callback failure');
  await assert.rejects(s.transaction(()=>{throw failure}),error=>error===failure);
  for(const invalid of [
    {snapshot:Buffer.from('not SQLite'),attempts:[]},
    {snapshot:Buffer.alloc(10*1024*1024+1),attempts:[]},
    {snapshot:sqlite(),attempts:[[attemptKey,{count:0,at:1}]]},
    {snapshot:sqlite(),attempts:[[attemptKey,{count:1,at:1}],[attemptKey,{count:1,at:1}]]},
    {snapshot:sqlite(),attempts:[['not-a-hash',{count:1,at:1}]]},
    {snapshot:sqlite(),attempts:[[attemptKey,{count:1,at:NaN}]]}
  ])await assert.rejects(s.transaction(()=>({...invalid,result:'must not return'})),/snapshot|attempt/);
  assert.equal(pool.events.filter(e=>e.sql.startsWith('UPDATE ')).length,0);
  assert.equal(pool.events.filter(e=>e.sql==='ROLLBACK').length,7);
  assert.equal(pool.rows.size,0);
  await s.close();
});

test('failed durable commit rejects the success response and rolls back snapshot and login attempts',async()=>{
  const failure=new Error('fixture durable commit failure');
  const pool=mockPool({hook:async(sql,_values,{pending})=>{if(sql==='COMMIT'&&pending)throw failure}}),s=store(pool);
  await assert.rejects(s.transaction(()=>({snapshot:sqlite(),attempts,result:{cookie:'must not escape'}})),error=>error===failure);
  assert.equal(pool.rows.size,0);
  assert.equal(pool.events.at(-1).sql,'ROLLBACK');
  assert.ok(pool.releases.every(error=>error===undefined));
  await s.close();
});

test('rollback connection failure destroys the client and preserves the original transaction error',async()=>{
  const failure=new Error('fixture application failure'),rollbackFailure=new Error('fixture connection lost');
  const pool=mockPool({hook:async sql=>{if(sql==='ROLLBACK')throw rollbackFailure}}),s=store(pool);
  await assert.rejects(s.transaction(()=>{throw failure}),error=>error===failure);
  assert.equal(pool.releases.at(-1),rollbackFailure);
  await s.close();
});

test('schema failure can be retried and namespaces keep independent durable snapshots and attempts',async()=>{
  let failSchema=true;
  const pool=mockPool({hook:async sql=>{
    if(sql.startsWith('CREATE TABLE')&&failSchema){failSchema=false;throw new Error('fixture schema interruption')}
  }}),preview=store(pool,'fixture-preview'),production=store(pool,'fixture-production');
  await assert.rejects(preview.transaction(()=>({snapshot:sqlite(),attempts:[],result:'never'})),/interruption/);
  assert.equal(await preview.transaction(()=>({snapshot:sqlite(),attempts,result:'preview'})),'preview');
  assert.equal(await production.transaction(state=>{
    assert.equal(state.snapshot,null);assert.deepEqual(state.attempts,[]);
    return {snapshot:sqlite(),attempts:[],result:'production'};
  }),'production');
  assert.equal(await preview.transaction(state=>{
    assert.ok(Buffer.isBuffer(state.snapshot));assert.deepEqual(state.attempts,attempts);
    return {...state,result:'still-preview'};
  }),'still-preview');
  assert.equal(pool.rows.size,2);
  assert.equal(pool.events.filter(e=>e.sql.includes('pg_advisory_xact_lock')).length,3,'retry schema initialization and provision each independent store safely');
  const selects=pool.events.filter(e=>e.sql.startsWith('SELECT snapshot,attempts'));
  assert.ok(selects.every(e=>e.sql.includes('namespace=$1 FOR UPDATE')&&e.values.length===1));
  await preview.close();
});
