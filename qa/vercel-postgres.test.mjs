import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {randomBytes,randomUUID} from 'node:crypto';
import {DatabaseSync,backup} from 'node:sqlite';
import {Pool} from 'pg';
import {createPostgresSnapshotStore} from '../server/demo-postgres.mjs';
import {createVercelDemoHandler} from '../server/vercel-demo.mjs';
import {createEmailFixture} from './email-fixture.mjs';

const connectionString=process.env.ORDER_HUB_TEST_POSTGRES_URL;
const integration={skip:!connectionString&&'Set ORDER_HUB_TEST_POSTGRES_URL to an isolated loopback PostgreSQL fixture.'};
const origin='https://order-hub-pg-fixture.example';

async function stores(t){
  const namespace='qa-'+randomBytes(12).toString('hex');
  const pools=[0,1].map(()=>new Pool({connectionString,ssl:false,max:2}));
  const values=pools.map(pool=>createPostgresSnapshotStore({connectionString,namespace,ssl:false,pool}));
  t.after(async()=>{
    await pools[0].query('DELETE FROM order_hub_demo_snapshots WHERE namespace=$1',[namespace]);
    await Promise.all(values.map(store=>store.close()));
  });
  return {values,pools,namespace};
}

async function countSnapshot(snapshot,change=0){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'order-hub-pg-snapshot-'));
  let db;
  try{
    const file=path.join(dir,'counter.sqlite');
    if(snapshot)fs.writeFileSync(file,snapshot,{mode:0o600});
    db=new DatabaseSync(file);
    db.exec('CREATE TABLE IF NOT EXISTS counter(n INTEGER NOT NULL)');
    if(!db.prepare('SELECT n FROM counter').get())db.prepare('INSERT INTO counter VALUES(0)').run();
    if(change)db.prepare('UPDATE counter SET n=n+?').run(change);
    const n=db.prepare('SELECT n FROM counter').get().n;
    const output=path.join(dir,'saved.sqlite');await backup(db,output);
    return {snapshot:fs.readFileSync(output),n};
  }finally{db?.close();fs.rmSync(dir,{recursive:true,force:true})}
}

test('real PostgreSQL cold-start stores serialize row updates and roll back failed snapshots',integration,async t=>{
  const {values}=await stores(t);
  const results=await Promise.all([0,1,0,1].map(index=>values[index].transaction(async({snapshot,attempts})=>{
    const next=await countSnapshot(snapshot,1);
    return {snapshot:next.snapshot,attempts,result:next.n};
  })));
  assert.deepEqual(results.sort(),[1,2,3,4]);
  await assert.rejects(()=>values[1].transaction(async({snapshot})=>{
    await countSnapshot(snapshot,100);throw new Error('Fixture abort before durable update');
  }),/Fixture abort/);
  const n=await values[0].transaction(async({snapshot,attempts})=>{
    const next=await countSnapshot(snapshot);return {snapshot:next.snapshot,attempts,result:next.n};
  });
  assert.equal(n,4,'a failed request must not replace the last committed database');
});

test('Vercel API persists sessions, stock and tenant permissions through independent real PostgreSQL connections',integration,async t=>{
  const {values,pools,namespace}=await stores(t),email=createEmailFixture();
  let handlers=values.map(store=>createVercelDemoHandler({store,environment:{ORDER_HUB_PUBLIC_ORIGIN:origin},emailAuth:email.emailAuth}));
  const server=http.createServer((req,res)=>handlers[Number(req.headers['x-qa-instance'])===1?1:0](req,res));
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  function request(route,{method='GET',body,session,instance=0,headers={}}={}){
    const h={Host:new URL(origin).host,'X-QA-Instance':instance};
    if(method!=='GET'){h.Origin=origin;h['Content-Type']='application/json'}
    if(session){h.Cookie=session.cookie;h['X-CSRF-Token']=session.csrf;h['X-Store-Id']=session.store.id}
    Object.assign(h,headers);for(const key of Object.keys(h))if(h[key]===undefined)delete h[key];
    return new Promise((resolve,reject)=>{
      const req=http.request({hostname:'127.0.0.1',port:server.address().port,path:route,method,headers:h},res=>{
        const chunks=[];res.on('data',part=>chunks.push(part));res.on('end',()=>{
          const text=Buffer.concat(chunks).toString();resolve({status:res.statusCode,data:JSON.parse(text),cookie:res.headers['set-cookie']?.[0]});
        });
      });req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));
    });
  }
  const asSession=r=>({cookie:r.cookie.split(';')[0],csrf:r.data.csrf,store:r.data.store});
  const password=randomBytes(24).toString('hex');
  const owner=code=>({storeName:'Fixture '+code,storeCode:code,username:'fixture_owner',name:'Fixture owner',password});
  let r=await request('/api/auth/setup',{method:'POST',body:await email.signup(async(route,body)=>{const reply=await request(route,{method:'POST',body});return {...reply,json:reply.data}},owner('alpha'))});assert.equal(r.status,201);assert.match(r.cookie,/; Secure/);const alpha=asSession(r);
  handlers=values.map(store=>createVercelDemoHandler({store,environment:{ORDER_HUB_PUBLIC_ORIGIN:origin},emailAuth:email.emailAuth}));
  assert.equal((await request('/api/state',{session:alpha,instance:1})).status,200);
  assert.equal((await request('/api/auth/setup',{method:'POST',body:owner('rogue'),instance:1})).status,409);
  r=await request('/api/stores',{method:'POST',body:await email.signup(async(route,body)=>{const reply=await request(route,{method:'POST',body,session:alpha,instance:1});return {...reply,json:reply.data}},owner('beta')),session:alpha,instance:1});assert.equal(r.status,201);
  r=await request('/api/auth/login',{method:'POST',body:{storeCode:'beta',username:'fixture_owner',password},instance:1});assert.equal(r.status,200);const beta=asSession(r);
  const state=async(session,instance=0)=>(await request('/api/state',{session,instance})).data.data;
  const empty=await state(beta);assert.deepEqual(empty.orders,[]);assert.ok(empty.products.every(p=>p.stock===0));
  const action=(input,instance=0)=>request('/api/actions',{method:'POST',body:input,session:beta,instance});
  const receives=await Promise.all([action({action:'stock-receive',sku:'CLN-100',qty:3,requestId:randomUUID()},0),action({action:'stock-receive',sku:'CLN-100',qty:4,requestId:randomUUID()},1),action({action:'stock-receive',sku:'SUN-050',qty:5,requestId:randomUUID()},1)]);
  assert.ok(receives.every(r=>r.status===200));assert.equal((await state(beta,1)).products.find(p=>p.sku==='CLN-100').stock,7);
  const input={channel:'Offline sales',customer:'Fixture recipient',phone:'0812345678',shippingAddress:{addressLine:'1 ถนนทดสอบ',subdistrict:'ปทุมวัน',district:'ปทุมวัน',province:'กรุงเทพมหานคร',postalCode:'10330'},items:[{sku:'CLN-100',qty:2,price:100,discount:0},{sku:'SUN-050',qty:3,price:50,discount:0}],payment:{method:'unpaid',status:'pending',amount:0}};
  r=await action({action:'create-order',...input},1);assert.equal(r.status,200);const id=r.data.result.orderId;
  assert.equal((await action({action:'reserve',id})).status,200);const before=await state(beta,1);
  assert.equal((await action({action:'update-order',...input,id,items:[{sku:'CLN-100',qty:8,price:100,discount:0},{sku:'SUN-050',qty:1,price:50,discount:0}]},1)).status,409);
  assert.deepEqual(await state(beta),before);
  const receive={action:'stock-receive',sku:'CLN-100',qty:1,requestId:randomUUID()};
  const duplicate=await Promise.all([action(receive,0),action(receive,1)]);assert.ok(duplicate.every(r=>r.status===200));assert.equal((await state(beta)).products.find(p=>p.sku==='CLN-100').stock,8);
  assert.equal((await request('/api/state',{session:alpha,headers:{'X-Store-Id':beta.store.id},instance:1})).status,409);
  assert.equal((await request('/api/state?storeId='+beta.store.id,{session:alpha,instance:1})).data.store.id,alpha.store.id);
  r=await request('/api/users',{method:'POST',body:{username:'fixture_finance',name:'Fixture finance',role:'finance',password},session:alpha});assert.equal(r.status,201);
  r=await request('/api/auth/login',{method:'POST',body:{storeCode:'alpha',username:'fixture_finance',password},instance:1});assert.equal(r.status,200);const finance=asSession(r);
  assert.equal((await request('/api/actions',{method:'POST',body:{action:'stock-receive',sku:'CLN-100',qty:1,requestId:randomUUID()},session:finance,instance:1})).status,403);
  // PostgreSQL now contains the complete, closed SQLite snapshot, never a WAL-only file.
  const persisted=await pools[0].query('SELECT snapshot FROM order_hub_demo_snapshots WHERE namespace=$1',[namespace]);assert.equal(persisted.rows[0].snapshot.subarray(0,16).toString(),'SQLite format 3\0');
  assert.equal((await request('/api/auth/logout',{method:'POST',body:{},session:beta,instance:1})).status,200);
  assert.equal((await request('/api/state',{session:beta})).status,401);assert.equal((await request('/api/state',{session:alpha,instance:1})).status,200);
});
