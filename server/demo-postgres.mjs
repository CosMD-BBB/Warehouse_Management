// Durable transport for the low-volume Vercel demo. The local application never
// imports pg, and this transport never reads a user's local database.
import {createHash} from 'node:crypto';
const maxSnapshotBytes=10*1024*1024,sqliteHeader=Buffer.from('SQLite format 3\0');
const maxPublicSnapshotBytes=2*1024*1024,maxPublicVisitors=100;
const namespacePattern=/^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$/;

function configuration({connectionString,namespace,ssl,pool}){
  if(typeof namespace!=='string'||!namespacePattern.test(namespace))throw new Error('Demo database namespace must contain 3–80 ASCII letters, digits, dots, hyphens or underscores');
  let url;
  try{
    if(typeof connectionString!=='string'||/\s|\\/.test(connectionString))throw new Error();
    url=new URL(connectionString);
    if(!['postgres:','postgresql:'].includes(url.protocol)||!url.hostname||url.hostname.includes('*')||!url.username||!url.password||url.pathname.length<2||url.hash)throw new Error();
    if(/[\u0000-\u001f\u007f]/.test(decodeURIComponent(url.username)+decodeURIComponent(url.password)+decodeURIComponent(url.pathname)))throw new Error();
  }catch{throw new Error('Demo database must use a PostgreSQL connection URL with credentials and a database name')}
  // pg connection-string SSL options override the separate ssl configuration.
  // Remove them before supplying certificate-verified TLS explicitly.
  for(const name of [...url.searchParams.keys()])if(name.toLowerCase().startsWith('ssl'))url.searchParams.delete(name);
  const loopback=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  let tls;
  if(ssl===false){
    if(!pool||!loopback)throw new Error('Unencrypted demo database connections are permitted only with an injected loopback test pool');
    tls=false;
  }else{
    if(ssl!==undefined&&ssl!==true&&(typeof ssl!=='object'||ssl===null||ssl.rejectUnauthorized!==true||Object.keys(ssl).some(k=>!['rejectUnauthorized','ca'].includes(k))))throw new Error('Demo database TLS must verify the server certificate');
    tls={rejectUnauthorized:true,...(typeof ssl==='object'&&ssl?.ca!==undefined?{ca:ssl.ca}:{})};
  }
  if(pool&&(!pool.connect||!pool.end))throw new Error('Injected demo database pool must provide connect and end');
  return {connectionString:url.toString(),namespace,ssl:tls};
}

function snapshotValue(value,{nullable=false}={}){
  if(nullable&&value===null)return null;
  if(!Buffer.isBuffer(value)||value.length<sqliteHeader.length||value.length>maxSnapshotBytes||!value.subarray(0,sqliteHeader.length).equals(sqliteHeader))throw new Error('Demo database snapshot is invalid or exceeds 10 MiB');
  return value;
}

function attemptValues(value){
  if(!Array.isArray(value)||value.length>10000)throw new Error('Demo login attempt data is invalid');
  const keys=new Set();
  for(const entry of value){
    if(!Array.isArray(entry)||entry.length!==2||typeof entry[0]!=='string'||!/^[a-f0-9]{64}$/.test(entry[0])||keys.has(entry[0]))throw new Error('Demo login attempt data is invalid');
    const item=entry[1];
    if(!item||typeof item!=='object'||Array.isArray(item)||Object.keys(item).some(k=>!['count','at'].includes(k))||!Number.isSafeInteger(item.count)||item.count<1||!Number.isSafeInteger(item.at)||item.at<0)throw new Error('Demo login attempt data is invalid');
    keys.add(entry[0]);
  }
  return value;
}

async function begin(client){
  await client.query('BEGIN');
  await client.query("SET LOCAL lock_timeout = '5s'");
  await client.query("SET LOCAL statement_timeout = '20s'");
  await client.query("SET LOCAL idle_in_transaction_session_timeout = '30s'");
}

async function withClientTransaction(pool,work){
  const client=await pool.connect();
  let destroy;
  try{
    await begin(client);
    const result=await work(client);
    await client.query('COMMIT');
    return result;
  }catch(error){
    try{await client.query('ROLLBACK')}catch(rollbackError){destroy=rollbackError}
    throw error;
  }finally{client.release(destroy)}
}

export function createPostgresSnapshotStore(options){
  const config=configuration(options||{});
  const publicProject=createHash('sha256').update('public-demo-v1|'+config.namespace).digest('hex');
  let poolPromise,schemaPromise,closed=false;
  async function pool(){
    if(closed)throw new Error('Demo database store is closed');
    if(!poolPromise){
      poolPromise=options.pool?Promise.resolve(options.pool):import('pg').then(module=>{
        const Pool=module.Pool||module.default?.Pool;
        const value=new Pool({connectionString:config.connectionString,ssl:config.ssl,max:1,connectionTimeoutMillis:5000,idleTimeoutMillis:10000,application_name:'order-hub-demo'});
        // An idle connection failure must not crash a function process. The next
        // transaction still has to establish its own working connection.
        value.on('error',()=>{});
        return value;
      });
      poolPromise.catch(()=>{poolPromise=undefined});
    }
    return poolPromise;
  }
  async function schema(value){
    if(!schemaPromise){
      schemaPromise=withClientTransaction(value,async client=>{
        // Serialize CREATE TABLE across cold starts, including different demo
        // namespaces. PostgreSQL releases this lock with the transaction.
        await client.query('SELECT pg_advisory_xact_lock(1936615791,1735289200)');
        await client.query(`CREATE TABLE IF NOT EXISTS order_hub_demo_snapshots (
          namespace TEXT PRIMARY KEY,
          snapshot BYTEA,
          attempts JSONB NOT NULL DEFAULT '[]'::jsonb,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
        await client.query(`CREATE TABLE IF NOT EXISTS order_hub_public_demo_snapshots (
          project_key TEXT NOT NULL,
          visitor_hash TEXT NOT NULL,
          snapshot BYTEA,
          attempts JSONB NOT NULL DEFAULT '[]'::jsonb,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '24 hours',
          PRIMARY KEY(project_key,visitor_hash)
        )`);
        await client.query('CREATE INDEX IF NOT EXISTS order_hub_public_demo_expiry ON order_hub_public_demo_snapshots(project_key,expires_at)');
      });
      schemaPromise.catch(()=>{schemaPromise=undefined});
    }
    await schemaPromise;
  }
  return {
    async transaction(callback,{visitor,allowCreate=false}={}){
      if(typeof callback!=='function')throw new Error('Demo database transaction requires a callback');
      if(visitor!==undefined&&(typeof visitor!=='string'||!/^[a-f0-9]{64}$/.test(visitor)||typeof allowCreate!=='boolean'))throw new Error('Invalid public demo visitor');
      const value=await pool();
      await schema(value);
      return withClientTransaction(value,async client=>{
        if(visitor!==undefined){
          const parameters=[publicProject,visitor];
          const select=()=>client.query('SELECT snapshot,attempts FROM order_hub_public_demo_snapshots WHERE project_key=$1 AND visitor_hash=$2 AND expires_at>NOW() FOR UPDATE',parameters);
          let selected=await select();
          if(!selected.rows.length){
            if(!allowCreate)throw Object.assign(new Error('Public demo session expired'),{code:'PUBLIC_DEMO_EXPIRED',status:401});
            // Only allocations share this project lock; existing visitors lock
            // their own row. The count and insert cannot race across cold starts.
            await client.query('SELECT pg_advisory_xact_lock(hashtext($1),1936615792)',[publicProject]);
            await client.query('DELETE FROM order_hub_public_demo_snapshots WHERE project_key=$1 AND expires_at<=NOW()',[publicProject]);
            selected=await select();
            if(!selected.rows.length){
              const count=await client.query('SELECT COUNT(*)::integer AS n FROM order_hub_public_demo_snapshots WHERE project_key=$1',[publicProject]);
              if(count.rows[0].n>=maxPublicVisitors)throw Object.assign(new Error('Public demo visitor capacity reached'),{code:'PUBLIC_DEMO_CAPACITY'});
              await client.query('INSERT INTO order_hub_public_demo_snapshots(project_key,visitor_hash) VALUES($1,$2)',parameters);
              selected=await select();
            }
          }
          if(selected.rows.length!==1)throw new Error('Public demo visitor could not be locked');
          const row=selected.rows[0],snapshot=snapshotValue(row.snapshot,{nullable:true});
          if(snapshot&&snapshot.length>maxPublicSnapshotBytes)throw new Error('Public demo snapshot exceeds 2 MiB');
          const output=await callback({snapshot,attempts:attemptValues(row.attempts)});
          if(!output||typeof output!=='object')throw new Error('Demo database callback must return its updated state');
          const nextSnapshot=snapshotValue(output.snapshot),nextAttempts=attemptValues(output.attempts);
          if(nextSnapshot.length>maxPublicSnapshotBytes)throw Object.assign(new Error('Public demo snapshot exceeds 2 MiB'),{code:'PUBLIC_DEMO_SIZE'});
          const updated=await client.query("UPDATE order_hub_public_demo_snapshots SET snapshot=$3,attempts=$4::jsonb,updated_at=NOW(),expires_at=NOW()+INTERVAL '24 hours' WHERE project_key=$1 AND visitor_hash=$2",[...parameters,nextSnapshot,JSON.stringify(nextAttempts)]);
          if(updated.rowCount!==1)throw new Error('Public demo snapshot could not be saved');
          return output.result;
        }
        await client.query('INSERT INTO order_hub_demo_snapshots(namespace) VALUES($1) ON CONFLICT(namespace) DO NOTHING',[config.namespace]);
        const selected=await client.query('SELECT snapshot,attempts FROM order_hub_demo_snapshots WHERE namespace=$1 FOR UPDATE',[config.namespace]);
        if(selected.rows.length!==1)throw new Error('Demo database namespace could not be locked');
        const row=selected.rows[0];
        const output=await callback({snapshot:snapshotValue(row.snapshot,{nullable:true}),attempts:attemptValues(row.attempts)});
        if(!output||typeof output!=='object')throw new Error('Demo database callback must return its updated state');
        const nextSnapshot=snapshotValue(output.snapshot),nextAttempts=attemptValues(output.attempts);
        const updated=await client.query('UPDATE order_hub_demo_snapshots SET snapshot=$2,attempts=$3::jsonb,updated_at=NOW() WHERE namespace=$1',[config.namespace,nextSnapshot,JSON.stringify(nextAttempts)]);
        if(updated.rowCount!==1)throw new Error('Demo database snapshot could not be saved');
        return output.result;
      });
    },
    async close(){
      closed=true;
      if(poolPromise)await (await poolPromise).end();
    }
  };
}
