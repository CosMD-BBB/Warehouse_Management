import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {DatabaseSync,backup} from 'node:sqlite';
import {Readable} from 'node:stream';
import {createApp} from '../server/index.mjs';
import {createEmailFixture} from './email-fixture.mjs';
import {Pool} from 'pg';
import {createVercelDemoHandler,publicDemoEnabled} from '../server/vercel-demo.mjs';
import {createPostgresSnapshotStore} from '../server/demo-postgres.mjs';

const origin='https://order-hub-public-fixture.example';
const publicEnvironment={ORDER_HUB_PUBLIC_ORIGIN:origin,VERCEL_ENV:'preview',VERCEL_GIT_COMMIT_REF:'vercel-demo'};
const configured={ORDER_HUB_PUBLIC_ORIGIN:origin};
const digest=value=>createHash('sha256').update(value).digest('hex');
const copy=value=>({snapshot:value.snapshot&&Buffer.from(value.snapshot),attempts:structuredClone(value.attempts)});

function fixtureStore(){
  const rows=new Map(),tails=new Map();
  const store={rows,calls:[],failCommit:false,
    transaction(callback,options={}){
      const key=options.visitor===undefined?'private':options.visitor;
      const operation=(tails.get(key)||Promise.resolve()).then(async()=>{
        store.calls.push(options);
        if(!rows.has(key)&&options.visitor!==undefined&&!options.allowCreate)throw Object.assign(new Error('expired'),{status:401});
        const output=await callback(copy(rows.get(key)||{snapshot:null,attempts:[]}));
        if(store.failCommit)throw Error('fixture commit failed');
        rows.set(key,copy(output));return output.result;
      });
      tails.set(key,operation.catch(()=>{}));return operation;
    }
  };
  return store;
}

async function fixture(t,{store=fixtureStore(),environment=publicEnvironment}={}){
  const email=createEmailFixture();
  let handlers=[0,1].map(()=>createVercelDemoHandler({store,environment,emailAuth:email.emailAuth}));
  const server=http.createServer((req,res)=>handlers[req.headers['x-instance']==='1'?1:0](req,res));
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const request=(route,{method='GET',body,session,headers={},instance=0}={})=>{
    const h={Host:new URL(origin).host,'X-Instance':instance};
    if(!['GET','HEAD'].includes(method)){h.Origin=origin;h['Content-Type']='application/json'}
    if(session){h.Cookie=session.cookie;h['X-CSRF-Token']=session.csrf;h['X-Store-Id']=session.store?.id}
    Object.assign(h,headers);for(const key of Object.keys(h))if(h[key]===undefined)delete h[key];
    return new Promise((resolve,reject)=>{
      const req=http.request({hostname:'127.0.0.1',port:server.address().port,path:route,method,headers:h},res=>{
        const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>{
          const text=Buffer.concat(chunks).toString();let json;try{json=JSON.parse(text)}catch{}
          resolve({status:res.statusCode,json,text,headers:res.headers,cookies:res.headers['set-cookie']||[]});
        });
      });req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));
    });
  };
  return {store,request,signup:fields=>email.signup((route,body)=>request(route,{method:'POST',body}),fields),restart(){handlers=[0,1].map(()=>createVercelDemoHandler({store,environment,emailAuth:email.emailAuth}))}};
}
function asSession(reply,previous){
  const cookies=new Map((previous?.cookie||'').split('; ').filter(Boolean).map(value=>value.split('=')));
  for(const value of reply.cookies){const pair=value.split(';')[0].split('=');cookies.set(...pair)}
  return {cookie:[...cookies].map(pair=>pair.join('=')).join('; '),csrf:reply.json.csrf,store:reply.json.store,user:reply.json.user};
}
const seedStock=(state,sku='CLN-100')=>state.products.find(product=>product.sku===sku).stock;
const stateOf=async(f,session,instance=0)=>(await f.request('/api/state',{session,instance})).json.data;
const action=(f,session,action,input={},instance=0)=>f.request('/api/actions',{method:'POST',body:{action,...input},session,instance});

async function snapshot(change){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'public-demo-test-'));let db;
  try{
    const file=path.join(directory,'fixture.sqlite');if(change.source)fs.writeFileSync(file,change.source);
    db=new DatabaseSync(file);await change.work?.(db);
    const output=path.join(directory,'saved.sqlite');await backup(db,output);return fs.readFileSync(output);
  }finally{db?.close();fs.rmSync(directory,{recursive:true,force:true})}
}

test('login-free mode is gated to the exact trusted Vercel preview branch; other targets retain login',async t=>{
  assert.equal(publicDemoEnabled(publicEnvironment),true);
  for(const environment of [{},{VERCEL_ENV:'production',VERCEL_GIT_COMMIT_REF:'vercel-demo'},{VERCEL_ENV:'development',VERCEL_GIT_COMMIT_REF:'vercel-demo'},{VERCEL_ENV:'preview'},{VERCEL_ENV:'preview',VERCEL_GIT_COMMIT_REF:'main'},{VERCEL_ENV:'preview',VERCEL_GIT_COMMIT_REF:'VERCEL-DEMO'},{ORDER_HUB_PUBLIC_DEMO:'true'}]){
    assert.equal(publicDemoEnabled(environment),false);
    const f=await fixture(t,{environment:{...configured,...environment}}),r=await f.request('/api/auth/status');
    assert.equal(r.status,200);assert.equal(r.json.needsSetup,true);assert.equal(r.json.user,null);assert.equal(r.json.publicDemo,undefined);assert.equal(r.cookies.length,0);
    assert.equal((await f.request('/api/state')).status,401);
    assert.equal((await f.request('/api/auth/demo-reset',{method:'POST',body:{}})).status,404);
  }
});

test('public visitors receive durable private guest sandboxes, exact authority and real CSRF protection',async t=>{
  const store=fixtureStore(),normal=await fixture(t,{store,environment:configured});
  const password=randomBytes(24).toString('hex');
  const owner=await normal.request('/api/auth/setup',{method:'POST',body:await normal.signup({storeName:'Private existing shop',storeCode:'private',username:'owner',name:'Private owner',password})});
  assert.equal(owner.status,201);const normalSession=asSession(owner),privateBefore=Buffer.from(store.rows.get('private').snapshot);
  const f=await fixture(t,{store});let r=await f.request('/api/auth/status');
  assert.equal(r.status,200);assert.equal(r.json.publicDemo,true);assert.equal(r.json.needsSetup,false);assert.equal(r.json.user.role,'admin');assert.equal(r.json.store.code,'demo');
  assert.equal(r.cookies.length,2);assert.ok(r.cookies.every(cookie=>/; Secure(?:;|$)/.test(cookie)&&/HttpOnly/.test(cookie)&&/SameSite=Strict/.test(cookie)&&/Path=\//.test(cookie)));
  assert.match(r.cookies.find(cookie=>cookie.startsWith('__Host-oh_demo=')),/^__Host-oh_demo=[a-f0-9]{64};/);
  assert.match(r.cookies.find(cookie=>cookie.startsWith('__Host-oh_demo_session=')),/^__Host-oh_demo_session=[a-f0-9]{64};/);
  assert.equal(r.cookies.some(cookie=>cookie.startsWith('oh_session=')),false,'public guest cookies cannot overwrite the private account cookie');
  const alpha=asSession(r),initial=await stateOf(f,alpha);assert.ok(initial.orders.length>0);assert.ok(initial.products.every(product=>product.stock>=0));
  const beta=asSession(await f.request('/api/auth/status',{instance:1}));assert.notEqual(alpha.cookie,beta.cookie);assert.notEqual(alpha.store.id,beta.store.id);
  assert.equal((await action(f,alpha,'stock-receive',{sku:'CLN-100',qty:2,requestId:randomUUID()},1)).status,200);
  f.restart();assert.equal(seedStock(await stateOf(f,alpha,1)),seedStock(initial)+2);assert.equal(seedStock(await stateOf(f,beta)),seedStock(initial));
  r=await f.request('/api/auth/status',{session:alpha,instance:1});assert.equal(r.json.user.id,alpha.user.id);assert.equal(r.cookies.length,1,'a valid server session is preserved');
  assert.equal((await f.request('/api/store',{method:'PATCH',body:{name:'CSRF attempt'},session:alpha,headers:{'X-CSRF-Token':undefined}})).status,403);
  assert.equal((await f.request('/api/state',{session:alpha,headers:{'X-Store-Id':beta.store.id}})).status,409);
  assert.equal((await f.request('/api/state?storeId='+beta.store.id,{session:alpha})).json.store.id,alpha.store.id);
  assert.equal((await f.request('/api/auth/status',{headers:{Host:'evil.example','X-Forwarded-Host':new URL(origin).host}})).status,403);
  assert.equal((await f.request('/api/store',{method:'PATCH',body:{name:'Bad origin'},session:alpha,headers:{Origin:'https://evil.example'}})).status,403);
  assert.deepEqual(store.rows.get('private').snapshot,privateBefore,'public requests never load or replace the normal authenticated database');
  assert.equal((await normal.request('/api/state',{session:normalSession})).json.store.name,'Private existing shop');
});

test('only status starts a sandbox; public account routes reject credentials and session regeneration is bounded',async t=>{
  const f=await fixture(t);assert.equal((await f.request('/api/state')).status,401);
  assert.equal((await f.request('/api/store',{method:'PATCH',body:{name:'not started'}})).status,401);assert.equal(f.store.calls.length,0);
  const alpha=asSession(await f.request('/api/auth/status'));
  for(const [route,method]of [['/api/auth/setup','POST'],['/api/auth/login','POST'],['/api/auth/password','POST'],['/api/auth/logout','POST'],['/api/stores','POST'],['/api/users','POST'],['/api/users/'+alpha.user.id,'PATCH']])assert.equal((await f.request(route,{method,body:{},session:alpha})).status,403,route);
  assert.equal((await f.request('/api/users',{session:alpha})).status,200);assert.equal((await f.request('/api/store',{session:alpha})).status,200);
  assert.equal((await f.request('/api/store',{method:'PATCH',body:{name:'ร้านทดลองแก้ชื่อ'},session:alpha})).status,200);
  const visitorCookie=alpha.cookie.split('; ').find(value=>value.startsWith('__Host-oh_demo='));let renewed;
  for(let i=0;i<20;i++){f.restart();renewed=asSession(await f.request('/api/auth/status',{headers:{Cookie:visitorCookie},instance:i%2}));assert.equal(renewed.store.id,alpha.store.id)}
  assert.equal((await f.request('/api/state',{session:alpha})).status,401,'oldest guest sessions are retired');
  assert.equal((await f.request('/api/state',{session:renewed})).status,200);
  const key=digest(visitorCookie.split('=')[1]),old=f.store.rows.get(key);
  old.snapshot=await snapshot({source:old.snapshot,work:db=>db.prepare('UPDATE sessions SET expires_at=0').run()});
  f.restart();const recovered=await f.request('/api/auth/status',{session:renewed,instance:1});assert.equal(recovered.status,200);assert.equal(recovered.json.user.id,alpha.user.id);assert.notEqual(recovered.json.csrf,renewed.csrf);assert.equal(recovered.cookies.length,2);
});

test('reset needs the real session and CSRF, restores only its own sample state and never leaks cookies before commit',async t=>{
  const f=await fixture(t),alpha=asSession(await f.request('/api/auth/status')),beta=asSession(await f.request('/api/auth/status',{instance:1}));
  const initial=await stateOf(f,alpha);assert.equal((await action(f,alpha,'stock-receive',{sku:'CLN-100',qty:7,requestId:randomUUID()})).status,200);
  assert.equal((await f.request('/api/auth/demo-reset',{method:'POST',body:{},session:alpha,headers:{'X-CSRF-Token':undefined}})).status,403);
  const noSessionCookie=alpha.cookie.split('; ').find(value=>value.startsWith('__Host-oh_demo='));assert.equal((await f.request('/api/auth/demo-reset',{method:'POST',body:{},headers:{Cookie:noSessionCookie}})).status,401);
  const before=await stateOf(f,alpha);f.store.failCommit=true;
  let r=await f.request('/api/auth/demo-reset',{method:'POST',body:{},session:alpha,instance:1});assert.equal(r.status,503);assert.deepEqual(r.cookies,[]);
  f.store.failCommit=false;assert.deepEqual(await stateOf(f,alpha),before);
  r=await f.request('/api/auth/demo-reset',{method:'POST',body:{},session:alpha,instance:1});assert.equal(r.status,200);assert.equal(r.json.publicDemo,true);const restarted=asSession(r,alpha);
  assert.notEqual(restarted.store.id,alpha.store.id);assert.notEqual(restarted.csrf,alpha.csrf);assert.equal((await f.request('/api/state',{session:alpha})).status,401);
  assert.equal(seedStock(await stateOf(f,restarted)),seedStock(initial));assert.equal(seedStock(await stateOf(f,beta)),seedStock(initial));
  const fresh=await fixture(t);fresh.store.failCommit=true;r=await fresh.request('/api/auth/status');assert.equal(r.status,503);assert.deepEqual(r.cookies,[]);assert.equal(fresh.store.rows.size,0);
});

test('public demo retains atomic inventory and rejects authenticated snapshots mistaken for synthetic guests',async t=>{
  const f=await fixture(t),alpha=asSession(await f.request('/api/auth/status')),initial=await stateOf(f,alpha);
  const stock=seedStock(initial);
  const receives=await Promise.all([action(f,alpha,'stock-receive',{sku:'CLN-100',qty:3,requestId:randomUUID()},0),action(f,alpha,'stock-receive',{sku:'CLN-100',qty:4,requestId:randomUUID()},1)]);assert.ok(receives.every(r=>r.status===200));assert.equal(seedStock(await stateOf(f,alpha)),stock+7);
  const input={channel:'Offline sales',customer:'ผู้รับตัวอย่าง',phone:'0812345678',shippingAddress:{addressLine:'1 ถนนตัวอย่าง',subdistrict:'ปทุมวัน',district:'ปทุมวัน',province:'กรุงเทพมหานคร',postalCode:'10330'},items:[{sku:'CLN-100',qty:2,price:100,discount:0},{sku:'SUN-050',qty:1,price:50,discount:0}],payment:{method:'unpaid',status:'pending',amount:0}};
  let r=await action(f,alpha,'create-order',input);assert.equal(r.status,200);const id=r.json.result.orderId;
  assert.equal((await action(f,alpha,'reserve',{id},1)).status,200);const reserved=await stateOf(f,alpha);
  r=await action(f,alpha,'update-order',{...input,id,items:[{sku:'CLN-100',qty:4,price:100,discount:0},{sku:'SUN-050',qty:100,price:50,discount:0}]},1);assert.equal(r.status,409);assert.deepEqual(await stateOf(f,alpha),reserved);
  const privateStore=fixtureStore(),normal=await fixture(t,{store:privateStore,environment:configured});
  assert.equal((await normal.request('/api/auth/setup',{method:'POST',body:await normal.signup({storeName:'Private',storeCode:'private',username:'owner',name:'Private owner',password:randomBytes(24).toString('hex')})})).status,201);
  const poisoned={transaction:async callback=>(await callback(copy(privateStore.rows.get('private')))).result};
  const rejected=await fixture(t,{store:poisoned});r=await rejected.request('/api/auth/status');assert.equal(r.status,503);assert.equal(r.cookies.length,0);assert.doesNotMatch(r.text,/Private owner|password_hash|csrf/);
});

const connectionString=process.env.ORDER_HUB_TEST_POSTGRES_URL;
const integration={skip:!connectionString&&'Set ORDER_HUB_TEST_POSTGRES_URL to an isolated loopback PostgreSQL fixture.'};
async function postgres(t){
  const namespace='public-qa-'+randomBytes(12).toString('hex'),project=digest('public-demo-v1|'+namespace);
  const pools=[0,1].map(()=>new Pool({connectionString,ssl:false,max:4}));
  const values=pools.map(pool=>createPostgresSnapshotStore({connectionString,namespace,pool,ssl:false}));
  t.after(async()=>{
    await pools[0].query('DELETE FROM order_hub_public_demo_snapshots WHERE project_key=$1',[project]);
    await pools[0].query('DELETE FROM order_hub_demo_snapshots WHERE namespace=$1',[namespace]);
    await Promise.all(values.map(value=>value.close()));
  });
  return {namespace,project,pools,values};
}

test('real PostgreSQL public allocation serializes capacity, cleans expired rows and never touches private state',integration,async t=>{
  const {pools,values,project}=await postgres(t);const small=await snapshot({work:db=>db.exec('CREATE TABLE counter(n INTEGER); INSERT INTO counter VALUES(1)')});
  const callback=({snapshot,attempts})=>({snapshot:snapshot||small,attempts,result:'saved'});
  await values[0].transaction(callback);
  // Preload 99 active fixture visitor rows, then race two allocations on different pools.
  await pools[0].query('INSERT INTO order_hub_public_demo_snapshots(project_key,visitor_hash,snapshot) SELECT $1, md5(n::text)||md5(n::text),$2 FROM generate_series(1,99) n',[project,small]);
  const candidates=[randomBytes(32).toString('hex'),randomBytes(32).toString('hex')];
  const results=await Promise.allSettled(candidates.map((visitor,i)=>values[i].transaction(callback,{visitor,allowCreate:true})));
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);assert.equal(results.find(result=>result.status==='rejected').reason.code,'PUBLIC_DEMO_CAPACITY');
  assert.equal((await pools[0].query('SELECT COUNT(*)::integer n FROM order_hub_public_demo_snapshots WHERE project_key=$1',[project])).rows[0].n,100);
  await pools[0].query("UPDATE order_hub_public_demo_snapshots SET expires_at=NOW()-INTERVAL '1 second' WHERE project_key=$1 AND visitor_hash=(SELECT visitor_hash FROM order_hub_public_demo_snapshots WHERE project_key=$1 LIMIT 1)",[project]);
  const visitor=randomBytes(32).toString('hex');assert.equal(await values[1].transaction(callback,{visitor,allowCreate:true}),'saved');
  const privateSnapshot=await values[0].transaction(callback);assert.equal(privateSnapshot,'saved');
  await assert.rejects(values[0].transaction(()=>({snapshot:Buffer.concat([Buffer.from('SQLite format 3\0'),Buffer.alloc(2*1024*1024)]),attempts:[],result:'never'}),{visitor,allowCreate:false}),/snapshot/);
  assert.equal((await pools[0].query('SELECT COUNT(*)::integer n FROM order_hub_public_demo_snapshots WHERE project_key=$1',[project])).rows[0].n,100);
  await pools[0].query("UPDATE order_hub_public_demo_snapshots SET expires_at=NOW()-INTERVAL '1 second' WHERE project_key=$1 AND visitor_hash=$2",[project,visitor]);
  await assert.rejects(values[0].transaction(callback,{visitor,allowCreate:false}),error=>error.code==='PUBLIC_DEMO_EXPIRED');
  assert.equal(await values[1].transaction(callback,{visitor,allowCreate:true}),'saved');
});

test('real PostgreSQL guest cookies, cold starts and reset are separate from authenticated database and other visitors',integration,async t=>{
  const {values}=await postgres(t);const multiplex={transaction:(callback,options)=>values[options?.visitor?.at(-1).charCodeAt(0)%2||0].transaction(callback,options)};
  const f=await fixture(t,{store:multiplex}),normal=await fixture(t,{store:values[0],environment:configured});
  const ownerReply=await normal.request('/api/auth/setup',{method:'POST',body:await normal.signup({storeName:'Unchanged private',storeCode:'private',username:'owner',name:'Private owner',password:randomBytes(24).toString('hex')})});assert.equal(ownerReply.status,201);const owner=asSession(ownerReply);
  const alpha=asSession(await f.request('/api/auth/status')),beta=asSession(await f.request('/api/auth/status'));const initial=await stateOf(f,alpha);
  assert.equal((await action(f,alpha,'stock-receive',{sku:'CLN-100',qty:5,requestId:randomUUID()})).status,200);
  f.restart();assert.equal(seedStock(await stateOf(f,alpha,1)),seedStock(initial)+5);assert.equal(seedStock(await stateOf(f,beta)),seedStock(initial));
  const restarted=asSession(await f.request('/api/auth/demo-reset',{method:'POST',body:{},session:alpha}),alpha);assert.equal(seedStock(await stateOf(f,restarted)),seedStock(initial));
  assert.equal((await f.request('/api/state',{session:alpha})).status,401);assert.equal((await normal.request('/api/state',{session:owner})).json.store.name,'Unchanged private');
});

test('public PostgreSQL transport validates visitors, rolls back oversized writes and keeps separate project rows on one pool',async()=>{
  const rows=new Map(),events=[];let capacity;
  const pool={
    async connect(){let pending;return {
      async query(sql,values=[]){
        events.push({sql,values});
        if(sql==='BEGIN')pending=new Map([...rows].map(([key,row])=>[key,copy(row)]));
        if(sql==='COMMIT'){for(const key of rows.keys())rows.delete(key);for(const [key,row]of pending)rows.set(key,row);pending=undefined}
        if(sql==='ROLLBACK')pending=undefined;
        const key=values.slice(0,2).join('|');
        if(sql.startsWith('SELECT snapshot,attempts FROM order_hub_public_demo_snapshots'))return {rows:pending.has(key)?[copy(pending.get(key))]:[]};
        if(sql.startsWith('SELECT COUNT(*)'))return {rows:[{n:capacity??[...pending.keys()].filter(key=>key.startsWith(values[0]+'|')).length}]};
        if(sql.startsWith('INSERT INTO order_hub_public_demo_snapshots'))pending.set(key,{snapshot:null,attempts:[]});
        if(sql.startsWith('UPDATE order_hub_public_demo_snapshots'))pending.set(key,{snapshot:Buffer.from(values[2]),attempts:JSON.parse(values[3])});
        return {rows:[],rowCount:1};
      },release(){}
    }},async end(){}
  };
  const first=createPostgresSnapshotStore({connectionString:'postgresql://fixture:fixture@127.0.0.1:5432/fixture',namespace:'public-transport-one',pool,ssl:false});
  const second=createPostgresSnapshotStore({connectionString:'postgresql://fixture:fixture@127.0.0.1:5432/fixture',namespace:'public-transport-two',pool,ssl:false});
  const visitor='a'.repeat(64),small=Buffer.concat([Buffer.from('SQLite format 3\0'),Buffer.alloc(4080)]);
  const callback=({snapshot,attempts})=>({snapshot:snapshot||small,attempts,result:'saved'});
  for(const bad of ['bad','A'.repeat(64),'b'.repeat(63),'b'.repeat(65),null])await assert.rejects(first.transaction(callback,{visitor:bad,allowCreate:true}),/visitor/);
  assert.equal(events.length,0);
  await assert.rejects(first.transaction(callback,{visitor,allowCreate:false}),error=>error.code==='PUBLIC_DEMO_EXPIRED');
  assert.equal(await first.transaction(callback,{visitor,allowCreate:true}),'saved');
  assert.equal(await second.transaction(callback,{visitor,allowCreate:true}),'saved');assert.equal(rows.size,2);
  const before=new Map([...rows].map(([key,row])=>[key,copy(row)]));
  await assert.rejects(first.transaction(()=>({snapshot:Buffer.concat([Buffer.from('SQLite format 3\0'),Buffer.alloc(2*1024*1024)]),attempts:[],result:'must not escape'}),{visitor}),error=>error.code==='PUBLIC_DEMO_SIZE');
  assert.deepEqual(rows,before);
  capacity=100;await assert.rejects(first.transaction(callback,{visitor:'b'.repeat(64),allowCreate:true}),error=>error.code==='PUBLIC_DEMO_CAPACITY');assert.deepEqual(rows,before);
  assert.ok(events.some(event=>event.sql==='SELECT pg_advisory_xact_lock(hashtext($1),1936615792)'));
  assert.ok(events.some(event=>event.sql.startsWith('DELETE FROM order_hub_public_demo_snapshots WHERE project_key=$1')));
  assert.ok(events.every(event=>!event.sql.startsWith('UPDATE order_hub_demo_snapshots')&&!event.sql.startsWith('DELETE FROM order_hub_demo_snapshots')));
  await Promise.all([first.close(),second.close()]);
});

test('direct concurrent guest bootstrap agrees on one owner and stale simultaneous resets cannot mutate after awaiting hashing',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'order-hub-public-concurrent-'));
  const app=createApp({dbPath:path.join(directory,'fixture.sqlite'),publicOrigin:origin,publicDemo:true});
  t.after(()=>{app.close();fs.rmSync(directory,{recursive:true,force:true})});
  async function invoke(route,{method='GET',session}={}){
    const req=Readable.from(method==='GET'?[]:[Buffer.from('{}')]);req.method=method;req.url=route;req.socket={remoteAddress:'127.0.0.1'};
    req.headers={host:new URL(origin).host,...(method==='GET'?{}:{origin,'content-type':'application/json'}),...(session?{cookie:session.cookie,'x-csrf-token':session.csrf,'x-store-id':session.store.id}:{})};
    const headers={};let status,body;
    const res={setHeader(name,value){headers[name.toLowerCase()]=value},writeHead(value,values){status=value;for(const [name,value]of Object.entries(values))headers[name.toLowerCase()]=value},end(value){body=JSON.parse(value)}};
    await app.handler(req,res);return {status,json:body,cookies:headers['set-cookie']?[headers['set-cookie']]:[]};
  }
  const started=await Promise.all([invoke('/api/auth/status'),invoke('/api/auth/status')]);assert.ok(started.every(reply=>reply.status===200));assert.equal(started[0].json.user.id,started[1].json.user.id);assert.equal(started[0].json.store.id,started[1].json.store.id);assert.equal(app.db.prepare('SELECT COUNT(*) n FROM users').get().n,1);
  const session=asSession(started[0]);
  const results=await Promise.all([invoke('/api/auth/demo-reset',{method:'POST',session}),invoke('/api/auth/demo-reset',{method:'POST',session})]);
  assert.equal(results.filter(reply=>reply.status===200).length,1);assert.equal(results.find(reply=>reply.status!==200).status,401);assert.equal(app.db.prepare('SELECT COUNT(*) n FROM users').get().n,1);
});
