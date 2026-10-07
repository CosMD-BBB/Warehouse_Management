import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes,randomUUID} from 'node:crypto';
import {createVercelDemoHandler,vercelDemoNamespace} from '../server/vercel-demo.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const origin='https://order-hub-demo.example';
const environment={ORDER_HUB_PUBLIC_ORIGIN:origin};

function durableFixtureStore(){
  let snapshot=null,attempts=[],tail=Promise.resolve();
  const store={calls:0,failCommit:false,beforeCommit:null,
    transaction(callback){
      const work=tail.then(async()=>{
        store.calls++;
        const next=await callback({snapshot:snapshot===null?null:Buffer.from(snapshot),attempts:structuredClone(attempts)});
        if(store.beforeCommit)await store.beforeCommit();
        if(store.failCommit)throw Error('Fixture persistence failed: private-credential-must-not-leak');
        snapshot=Buffer.from(next.snapshot);attempts=structuredClone(next.attempts);return next.result;
      });
      tail=work.catch(()=>{});return work;
    },
    get snapshot(){return snapshot},get attempts(){return structuredClone(attempts)}
  };
  return store;
}

async function fixture(t,{store=durableFixtureStore(),env=environment,parsed=false}={}){
  let handlers=[createVercelDemoHandler({store,environment:env}),createVercelDemoHandler({store,environment:env})];
  const server=http.createServer(async(req,res)=>{
    if(parsed&&['POST','PATCH'].includes(req.method)){
      const chunks=[];for await(const chunk of req)chunks.push(chunk);const bytes=Buffer.concat(chunks);
      if(req.headers['x-fixture-body']==='throw')Object.defineProperty(req,'body',{get(){throw Error('Platform parser failure')}});
      else if(req.headers['x-fixture-body']==='buffer')req.body=bytes;
      else if(req.headers['x-fixture-body']==='string')req.body=bytes.toString();
      else {try{req.body=JSON.parse(bytes.toString())}catch{req.body=bytes.toString()}}
    }
    await handlers[Number(req.headers['x-fixture-instance'])===1?1:0](req,res);
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const request=(route,{method='GET',body,session,headers={},instance=0}={})=>{
    const h={Host:new URL(origin).host,'X-Fixture-Instance':instance};
    if(!['GET','HEAD'].includes(method)){h.Origin=origin;h['Content-Type']='application/json'}
    if(session){h.Cookie=session.cookie;h['X-CSRF-Token']=session.csrf;h['X-Store-Id']=session.store?.id}
    Object.assign(h,headers);for(const key of Object.keys(h))if(h[key]===undefined)delete h[key];
    return new Promise((resolve,reject)=>{
      const req=http.request({hostname:'127.0.0.1',port:server.address().port,path:route,method,headers:h},res=>{
        const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>{
          const bytes=Buffer.concat(chunks),text=bytes.toString();let json;try{json=JSON.parse(text)}catch{}
          const setCookie=res.headers['set-cookie']?.[0];resolve({status:res.statusCode,json,bytes,text,headers:res.headers,setCookie,cookie:setCookie?.split(';')[0]});
        });
      });
      req.on('error',reject);req.end(body===undefined?undefined:typeof body==='string'||Buffer.isBuffer(body)?body:JSON.stringify(body));
    });
  };
  return {store,request,restart(){handlers=[createVercelDemoHandler({store,environment:env}),createVercelDemoHandler({store,environment:env})]}};
}
const account=(password,storeCode='alpha')=>({storeName:'Vercel fixture '+storeCode,storeCode,username:'demo_owner',name:'Fixture owner',password});
const sessionOf=r=>({cookie:r.cookie,csrf:r.json.csrf,store:r.json.store,user:r.json.user});

test('Vercel page and all original public assets load without database configuration; private paths remain denied',async t=>{
  const f=await fixture(t,{store:undefined});
  for(const asset of ['/',...fs.readdirSync(path.join(root,'dist'),{recursive:true}).filter(asset=>fs.statSync(path.join(root,'dist',asset)).isFile())]){
    const route=asset==='/'?asset:'/'+asset,r=await f.request(route);assert.equal(r.status,200,route);
    assert.equal(r.bytes.length,fs.statSync(path.join(root,'dist',asset==='/'?'index.html':asset)).size,route);
    assert.equal(r.headers['x-content-type-options'],'nosniff');assert.match(r.headers['content-security-policy'],/connect-src 'self'/);
  }
  const head=await f.request('/',{method:'HEAD'});assert.equal(head.status,200);assert.equal(head.bytes.length,0);
  for(const route of ['/server/seed.json','/.local/order-hub.sqlite','/package.json','/README.md','/api/order-hub','/../server/seed.json','/%2e%2e/server/seed.json','//server/seed.json'])assert.equal((await f.request(route)).status,404,route);
  assert.equal(f.store.calls,0,'static and invalid paths must not open a database');
});

test('Vercel authority is exact, trusted process domains are accepted, and forwarded headers cannot grant access',async t=>{
  const f=await fixture(t),spoof={'X-Forwarded-Host':new URL(origin).host,'X-Forwarded-Proto':'https',Forwarded:'host='+new URL(origin).host+';proto=https'};
  for(const host of ['evil.example',new URL(origin).host+'.evil.example',new URL(origin).host+':443']){
    assert.equal((await f.request('/api/auth/status',{headers:{Host:host,...spoof}})).status,403);
    assert.equal((await f.request('/',{headers:{Host:host,...spoof}})).status,403);
  }
  for(const foreign of [undefined,'null','https://evil.example',origin+'/','http://'+new URL(origin).host])assert.equal((await f.request('/api/auth/setup',{method:'POST',body:{},headers:{Origin:foreign,...spoof}})).status,403);
  assert.equal((await f.request('/api/auth/status',{method:'DELETE',headers:{Origin:origin}})).status,405);assert.equal(f.store.calls,0);
  const trusted=await fixture(t,{env:{VERCEL_URL:'deployment.vercel.app',VERCEL_PROJECT_PRODUCTION_URL:'production.vercel.app'}});
  for(const host of ['deployment.vercel.app','production.vercel.app'])assert.equal((await trusted.request('/',{headers:{Host:host}})).status,200);
  assert.equal((await trusted.request('/',{headers:{Host:'another.vercel.app','X-Forwarded-Host':'production.vercel.app'}})).status,403);
  const explicit=await fixture(t,{env:{...environment,VERCEL_URL:'other.vercel.app'}});assert.equal((await explicit.request('/',{headers:{Host:'other.vercel.app'}})).status,403,'explicit origin is the sole authority');
});

test('durable namespace is stable across preview deployments and separated by the trusted production identity',()=>{
  const first=vercelDemoNamespace({VERCEL_PROJECT_PRODUCTION_URL:'order-hub.vercel.app',VERCEL_URL:'first-preview.vercel.app'});
  assert.equal(first,vercelDemoNamespace({VERCEL_PROJECT_PRODUCTION_URL:'order-hub.vercel.app',VERCEL_URL:'second-preview.vercel.app'}));
  assert.equal(first,vercelDemoNamespace({VERCEL_PROJECT_PRODUCTION_URL:'ORDER-HUB.vercel.app'}));
  assert.equal(first,vercelDemoNamespace({VERCEL_PROJECT_PRODUCTION_URL:'order-hub.vercel.app',VERCEL_ENV:'preview'}));
  assert.notEqual(first,vercelDemoNamespace({VERCEL_PROJECT_PRODUCTION_URL:'order-hub.vercel.app',VERCEL_ENV:'production'}));
  assert.notEqual(first,vercelDemoNamespace({VERCEL_PROJECT_PRODUCTION_URL:'order-hub.vercel.app',VERCEL_ENV:'development'}));
  assert.notEqual(first,vercelDemoNamespace({VERCEL_PROJECT_PRODUCTION_URL:'another-order-hub.vercel.app'}));
  assert.equal(vercelDemoNamespace({ORDER_HUB_DEMO_NAMESPACE:'chosen-demo',VERCEL_PROJECT_PRODUCTION_URL:'bad/value'}),'chosen-demo');
  for(const env of [{},{VERCEL_URL:'temporary-only.vercel.app'},{VERCEL_PROJECT_PRODUCTION_URL:'evil.example/path'},{ORDER_HUB_DEMO_NAMESPACE:''},{ORDER_HUB_DEMO_NAMESPACE:'bad namespace'},{VERCEL_PROJECT_PRODUCTION_URL:'order-hub.vercel.app',VERCEL_ENV:''},{VERCEL_PROJECT_PRODUCTION_URL:'order-hub.vercel.app',VERCEL_ENV:'unknown'}])assert.throws(()=>vercelDemoNamespace(env));
});

test('misconfigured or unavailable demo persistence fails closed without creating accounts or exposing configuration',async t=>{
  const failing={calls:0,async transaction(){this.calls++;throw Error('postgres://fixture:private-password@db.example/private')}};
  const f=await fixture(t,{store:failing});let r=await f.request('/api/auth/status');assert.equal(r.status,503);assert.deepEqual(Object.keys(r.json),['error']);assert.doesNotMatch(r.text,/postgres|private-password|db\.example/);assert.equal(r.setCookie,undefined);
  assert.equal((await f.request('/')).status,200,'assets remain available while persistence is unavailable');
  const invalid=await fixture(t,{env:{ORDER_HUB_PUBLIC_ORIGIN:'https://user:secret@invalid.example'}});assert.equal((await invalid.request('/')).status,503);assert.equal(invalid.store.calls,0);
  const missingHandler=createVercelDemoHandler({environment});
  // Exercise the actual factory with no injected store, not an in-memory fallback.
  const server=http.createServer(missingHandler);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const response=await new Promise((resolve,reject)=>{http.get({hostname:'127.0.0.1',port:server.address().port,path:'/api/auth/status',headers:{Host:new URL(origin).host}},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,text:Buffer.concat(chunks).toString(),headers:res.headers}))}).on('error',reject)});
  assert.equal(response.status,503);assert.equal(response.headers['set-cookie'],undefined);assert.doesNotMatch(response.text,/DATABASE_URL|password|postgres:\/\//);
});

test('accounts, Secure sessions, CSRF, tenant scope and warehouse redaction survive independent Vercel cold starts',async t=>{
  const f=await fixture(t),password=randomBytes(24).toString('hex');
  assert.equal((await f.request('/api/auth/status')).json.needsSetup,true);
  let r=await f.request('/api/auth/setup',{method:'POST',body:account(password)});assert.equal(r.status,201,JSON.stringify(r.json));assert.match(r.setCookie,/; Secure(?:;|$)/);const alpha=sessionOf(r);
  f.restart();assert.equal((await f.request('/api/auth/status',{session:alpha,instance:1})).json.user.id,alpha.user.id);
  assert.equal((await f.request('/api/state',{session:alpha,instance:1})).status,200);
  assert.equal((await f.request('/api/store',{method:'PATCH',body:{name:'Blocked'},session:alpha,headers:{'X-CSRF-Token':undefined},instance:1})).status,403);
  r=await f.request('/api/stores',{method:'POST',body:account(password,'beta'),session:alpha,instance:1});assert.equal(r.status,201,JSON.stringify(r.json));
  r=await f.request('/api/auth/login',{method:'POST',body:{storeCode:'beta',username:'demo_owner',password}});assert.equal(r.status,200);const beta=sessionOf(r);
  const betaState=(await f.request('/api/state',{session:beta,instance:1})).json.data;assert.deepEqual(betaState.orders,[]);assert.ok(betaState.products.every(product=>product.stock===0));
  r=await f.request('/api/state?storeId='+beta.store.id,{session:alpha,instance:1});assert.equal(r.status,200);assert.equal(r.json.store.id,alpha.store.id);assert.ok(r.json.data.orders.length>0);
  assert.equal((await f.request('/api/state',{session:alpha,headers:{'X-Store-Id':beta.store.id}})).status,409);
  r=await f.request('/api/users',{method:'POST',body:{username:'warehouse_fixture',name:'Warehouse fixture',role:'warehouse',password},session:alpha,instance:1});assert.equal(r.status,201);
  r=await f.request('/api/auth/login',{method:'POST',body:{storeCode:'alpha',username:'warehouse_fixture',password},instance:1});assert.equal(r.status,200);const worker=sessionOf(r);
  const workerState=(await f.request('/api/state',{session:worker})).json.data;
  for(const order of workerState.orders){for(const key of ['grandTotal','total','cost','payment','shippingFee','discount'])assert.equal(Object.hasOwn(order,key),false,key);for(const item of order.items)assert.equal(Object.hasOwn(item,'price'),false)}
  assert.ok(workerState.products.every(product=>!Object.hasOwn(product,'cost')&&!Object.hasOwn(product,'price')));
  assert.equal((await f.request('/api/users',{session:worker})).status,403);
  r=await f.request('/api/auth/logout',{method:'POST',body:{},session:alpha,instance:1});assert.equal(r.status,200);assert.match(r.setCookie,/Max-Age=0/);
  f.restart();assert.equal((await f.request('/api/state',{session:alpha})).status,401);assert.equal((await f.request('/api/state',{session:beta})).status,200);
});

test('serial durable snapshots preserve concurrent inventory changes and atomic multi-product edits across instances',async t=>{
  const f=await fixture(t),password=randomBytes(24).toString('hex');let r=await f.request('/api/auth/setup',{method:'POST',body:account(password)});assert.equal(r.status,201);const owner=sessionOf(r);
  await f.request('/api/stores',{method:'POST',body:account(password,'beta'),session:owner});r=await f.request('/api/auth/login',{method:'POST',body:{storeCode:'beta',username:'demo_owner',password},instance:1});assert.equal(r.status,200);const beta=sessionOf(r);
  const action=(action,input={},instance=0)=>f.request('/api/actions',{method:'POST',body:{action,...input},session:beta,instance});
  const received=await Promise.all([action('stock-receive',{sku:'CLN-100',qty:3,requestId:randomUUID()},0),action('stock-receive',{sku:'CLN-100',qty:4,requestId:randomUUID()},1),action('stock-receive',{sku:'SUN-050',qty:5,requestId:randomUUID()},1)]);for(const response of received)assert.equal(response.status,200);
  const input={channel:'Offline sales',customer:'Vercel fixture recipient',phone:'0812345678',shippingAddress:{addressLine:'1 ถนนทดสอบ',subdistrict:'ปทุมวัน',district:'ปทุมวัน',province:'กรุงเทพมหานคร',postalCode:'10330'},items:[{sku:'CLN-100',qty:2,price:100,discount:0},{sku:'SUN-050',qty:3,price:50,discount:0}],payment:{method:'unpaid',status:'pending',amount:0}};
  r=await action('create-order',input,1);assert.equal(r.status,200,JSON.stringify(r.json));const id=r.json.result.orderId;
  assert.equal((await action('reserve',{id},0)).status,200);const before=(await f.request('/api/state',{session:beta,instance:1})).json.data;
  assert.equal(before.products.find(p=>p.sku==='CLN-100').stock,7);
  r=await action('update-order',{...input,id,items:[{sku:'CLN-100',qty:8,price:100,discount:0},{sku:'SUN-050',qty:1,price:50,discount:0}]},1);assert.equal(r.status,409);
  f.restart();assert.deepEqual((await f.request('/api/state',{session:beta})).json.data,before,'shortage must preserve every SKU and the previous order after cold start');
  r=await action('update-order',{...input,id,items:[{sku:'CLN-100',qty:4,price:100,discount:0},{sku:'SUN-050',qty:1,price:50,discount:0}]},0);assert.equal(r.status,200);
  const after=(await f.request('/api/state',{session:beta,instance:1})).json.data;assert.equal(after.orders.find(order=>order.id===id).items[0].qty,4);
});

test('Vercel-parsed object, string and Buffer bodies use the real validation and retain the 64KiB limit',async t=>{
  const f=await fixture(t,{parsed:true}),password=randomBytes(24).toString('hex');
  let r=await f.request('/api/auth/setup',{method:'POST',body:account(password)});assert.equal(r.status,201,JSON.stringify(r.json));const session=sessionOf(r);
  for(const kind of ['string','buffer']){r=await f.request('/api/store',{method:'PATCH',body:{name:'Parsed '+kind},session,headers:{'X-Fixture-Body':kind},instance:1});assert.equal(r.status,200,kind);assert.equal(r.json.store.name,'Parsed '+kind)}
  for(const body of ['{','null','[]','"text"'])assert.equal((await f.request('/api/store',{method:'PATCH',body,session,headers:{'X-Fixture-Body':'string'}})).status,400);
  let calls=f.store.calls;r=await f.request('/api/store',{method:'PATCH',body:{name:'x'.repeat(66000)},session});assert.equal(r.status,413);assert.equal(f.store.calls,calls,'oversized parsed body is rejected before opening persistence');
  r=await f.request('/api/store',{method:'PATCH',body:{name:'Invalid content type'},session,headers:{'Content-Type':'text/plain'}});assert.equal(r.status,415);
  calls=f.store.calls;r=await f.request('/api/store',{method:'PATCH',body:{name:'Parser failure'},session,headers:{'X-Fixture-Body':'throw'}});assert.equal(r.status,400);assert.equal(f.store.calls,calls);
});

test('failed COMMIT never releases success or session cookies and leaves the persisted setup unchanged',async t=>{
  const f=await fixture(t),password=randomBytes(24).toString('hex');
  assert.equal((await f.request('/api/auth/status')).json.needsSetup,true);const before=Buffer.from(f.store.snapshot);
  f.store.failCommit=true;const failed=await f.request('/api/auth/setup',{method:'POST',body:account(password),instance:1});assert.equal(failed.status,503);assert.equal(failed.setCookie,undefined);assert.doesNotMatch(failed.text,/private-credential|demo_owner|csrf|oh_session/);assert.deepEqual(f.store.snapshot,before);
  f.store.failCommit=false;f.restart();assert.equal((await f.request('/api/auth/status')).json.needsSetup,true);
  const setup=await f.request('/api/auth/setup',{method:'POST',body:account(password)});assert.equal(setup.status,201);const session=sessionOf(setup);
  f.store.failCommit=true;const logout=await f.request('/api/auth/logout',{method:'POST',body:{},session,instance:1});assert.equal(logout.status,503);assert.equal(logout.setCookie,undefined);
  f.store.failCommit=false;assert.equal((await f.request('/api/state',{session})).status,200,'rolled-back logout must preserve the existing durable session');
});

test('login throttling survives repeated cold starts and rolls back when persistence fails',async t=>{
  const f=await fixture(t);
  for(let i=0;i<6;i++){f.restart();const r=await f.request('/api/auth/login',{method:'POST',body:{storeCode:'unknown',username:'unknown',password:'Fixture-wrong-password'},instance:i%2});assert.equal(r.status,401)}
  assert.ok(f.store.attempts.length>=1);assert.ok(f.store.attempts.every(([key,value])=>/^[a-f0-9]{64}$/.test(key)&&value.count===6));
  f.restart();assert.equal((await f.request('/api/auth/login',{method:'POST',body:{storeCode:'unknown',username:'unknown',password:'Fixture-wrong-password'},instance:1})).status,429);
  const fresh=await fixture(t);fresh.store.failCommit=true;assert.equal((await fresh.request('/api/auth/login',{method:'POST',body:{username:'rollback',password:'Fixture-wrong-password'}})).status,503);assert.deepEqual(fresh.store.attempts,[]);
});

test('malformed durable snapshots and login counters fail closed instead of initializing a replacement database',async t=>{
  for(const persisted of [{snapshot:Buffer.from('not sqlite'),attempts:[]},{snapshot:null,attempts:[['not-a-hash',{count:1,at:Date.now()}]]},{snapshot:null,attempts:[['a'.repeat(64),{count:Infinity,at:Date.now()}]]}]){
    let committed=false;const store={async transaction(callback){const result=await callback(persisted);committed=true;return result.result}};
    const f=await fixture(t,{store}),r=await f.request('/api/auth/status');assert.equal(r.status,503);assert.equal(r.setCookie,undefined);assert.equal(committed,false);
  }
});
