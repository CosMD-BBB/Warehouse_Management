import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createApp} from '../server/index.mjs';
import {available,reserved} from '../server/model.mjs';
import {resolveChannelItems,resolveChannelProduct} from '../server/catalog.mjs';
import {createEmailFixture} from './email-fixture.mjs';

const PASSWORD='Catalog-fixture-password-001';
const sessionOf=response=>({cookie:response.cookie,csrf:response.j.csrf,user:response.j.user,store:response.j.store});
const listing=(centralSku,extra={})=>({channel:'Shopee',shopId:'0000123',productId:'0000456',variantId:'0000789',sellerSku:'SELLER-SKU',name:'สินค้าตัวอย่างบนช่องทาง',centralSku,...extra});
async function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'order-hub-catalog-')),dbPath=path.join(dir,'fixture.sqlite');
  const email=createEmailFixture();let app,origin;
  async function start(){app=createApp({dbPath,emailAuth:email.emailAuth});await new Promise((resolve,reject)=>{app.server.once('error',reject);app.server.listen(0,'127.0.0.1',resolve)});origin='http://127.0.0.1:'+app.server.address().port}
  async function stop(){if(!app)return;const current=app;app=null;await new Promise((resolve,reject)=>current.server.close(error=>error?reject(error):resolve()))}
  await start();t.after(async()=>{try{await stop()}finally{fs.rmSync(dir,{recursive:true,force:true})}});
  async function request(route,body,session,method=body?'POST':'GET',extraHeaders={}){
    const headers={};if(session){headers.Cookie=session.cookie;headers['X-CSRF-Token']=session.csrf}
    if(method!=='GET'){headers.Origin=origin;headers['Content-Type']='application/json'}
    Object.assign(headers,extraHeaders);
    const response=await fetch(origin+route,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
    return {status:response.status,j:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};
  }
  async function provision(route,storeCode,session){const fields={storeCode,storeName:storeCode,name:'Catalog fixture admin',username:'same_owner',password:PASSWORD,email:`${storeCode}@catalog.fixture.example`};const response=await request(route,await email.signup((otpRoute,body)=>request(otpRoute,body,session),fields),session);assert.equal(response.status,201,JSON.stringify(response.j));return sessionOf(response)}
  const admin=await provision('/api/auth/setup','alpha');
  const action=(session,action,input={},headers={})=>request('/api/actions',{action,...input},session,'POST',headers);
  async function state(session=admin){const response=await request('/api/state',undefined,session);assert.equal(response.status,200);return response.j.data}
  async function login(storeCode,username='same_owner'){const response=await request('/api/auth/login',{storeCode,username,password:PASSWORD});assert.equal(response.status,200,JSON.stringify(response.j));return sessionOf(response)}
  async function member(role){const username=`${role}_fixture`;const response=await request('/api/users',{name:'Catalog '+role,username,password:PASSWORD,role},admin);assert.equal(response.status,201,JSON.stringify(response.j));return login('alpha',username)}
  const raw=session=>JSON.parse(app.db.prepare('SELECT data FROM tenant_state WHERE tenant_id=?').get((session||admin).store.id).data);
  const save=(session,data)=>app.db.prepare('UPDATE tenant_state SET data=? WHERE tenant_id=?').run(JSON.stringify(data),session.store.id);
  function snapshot(session=admin){return {data:app.db.prepare('SELECT data FROM tenant_state WHERE tenant_id=?').get(session.store.id).data,audits:app.db.prepare('SELECT COUNT(*) n FROM security_audit WHERE tenant_id=?').get(session.store.id).n,requests:app.db.prepare('SELECT COUNT(*) n FROM action_requests WHERE tenant_id=?').get(session.store.id).n}}
  async function create(sku,extra={},session=admin){const response=await action(session,'create-product',{sku,name:'สินค้าคงคลัง '+sku,...extra});assert.equal(response.status,200,JSON.stringify(response.j));return response.j.result}
  async function link(input,session=admin){const response=await action(session,'link-channel-product',input);assert.equal(response.status,200,JSON.stringify(response.j));return response.j.result}
  return {admin,action,state,request,provision,login,member,raw,save,snapshot,create,link,restart:async()=>{await stop();await start()}};
}

test('only authenticated Admin can create central products or change marketplace mappings, with CSRF and Origin enforcement',async t=>{
  const f=await fixture(t),{admin}=f,worker=await f.member('warehouse'),finance=await f.member('finance');
  await f.create('ROLE-TEST');const mapping=await f.link(listing('ROLE-TEST'));
  const operations=[['create-product',{sku:'NO-ACCESS',name:'Forbidden'}],['link-channel-product',listing('ROLE-TEST',{productId:'DIFFERENT'})],['unlink-channel-product',{mappingId:mapping.mappingId,expectedVersion:1}],['simulate-mapped-order',{mappingId:mapping.mappingId,qty:1}]];
  const before=f.snapshot();
  for(const [name,input]of operations){
    assert.equal((await f.action(undefined,name,input)).status,401,name);
    for(const session of [worker,finance])assert.equal((await f.action(session,name,input)).status,403,name);
    assert.equal((await f.action(admin,name,input,{'X-CSRF-Token':''})).status,403,name);
    assert.equal((await f.action(admin,name,input,{Origin:'https://foreign.fixture.example'})).status,403,name);
    assert.deepEqual(f.snapshot(),before,'authorization failures must not change catalog, requests or audit');
  }
  const warehouse=await f.state(worker),product=warehouse.products.find(item=>item.sku==='ROLE-TEST');
  assert.ok(product);assert.ok(!('price' in product));assert.ok(!('cost' in product));
  assert.ok(!('expenses' in warehouse));assert.ok(!('payouts' in warehouse));
});

test('central product creation normalizes SKU, retains exact barcode text, uses cent precision and defaults new stock to zero',async t=>{
  const f=await fixture(t),{admin}=f;
  const zero=await f.create('  custom-001  ');assert.equal(zero.sku,'CUSTOM-001');
  let data=await f.state(),product=data.products.find(item=>item.sku==='CUSTOM-001');
  for(const field of ['stock','min','price','cost'])assert.equal(product[field],0,field+' defaults to zero');
  await f.create('CUSTOM-002',{name:'ครีมตัวอย่าง',sub:'ขนาด 30 กรัม',location:'A-02',min:4,price:'19.99',cost:'7.25',stock:6,barcode:'0000123456789',barcodes:['ALT-0002']});
  data=await f.state();product=data.products.find(item=>item.sku==='CUSTOM-002');
  assert.equal(product.name,'ครีมตัวอย่าง');assert.equal(product.sub,'ขนาด 30 กรัม');assert.equal(product.location,'A-02');assert.equal(product.min,4);assert.equal(product.stock,6);assert.equal(product.price,19.99);assert.equal(product.cost,7.25);assert.equal(product.barcode,'0000123456789');assert.deepEqual(product.barcodes,['ALT-0002']);
  assert.equal(reserved(f.raw(),'CUSTOM-002'),0);assert.equal(available(f.raw(),'CUSTOM-002'),6);
  for(const channel of ['Shopee','Lazada','TikTok Shop'])assert.equal(data.publishedStock[channel].qty['CUSTOM-002'],6,'marketplace sample quantities mirror central availability');
  await f.provision('/api/stores','beta',admin);const beta=await f.login('beta'),newStore=await f.state(beta);
  assert.equal(newStore.orders.length,0);assert.ok(newStore.products.every(item=>item.stock===0));
  await f.create('NEW-STORE-001',{},beta);assert.equal((await f.state(beta)).products.find(item=>item.sku==='NEW-STORE-001').stock,0);
  assert.equal((await f.state(beta)).orders.length,0,'creating a product never copies another store orders');
});

test('invalid product fields and barcode/SKU collisions fail atomically without false audit or saved replay requests',async t=>{
  const f=await fixture(t),{admin}=f;
  await f.create('EXISTING',{barcode:'00009999',barcodes:['EXISTING-ALIAS']});const before=f.snapshot();
  const cases=[
    [{sku:'existing',name:'Duplicate normalized SKU'},409],
    [{sku:'FRESH',name:'Collision',barcode:'00009999'},409],
    [{sku:'FRESH',name:'Collision',barcodes:['EXISTING-ALIAS']},409],
    [{sku:'EXISTING-ALIAS',name:'New SKU collides with existing barcode'},409],
    [{sku:'FRESH',name:'Collision',barcode:'CLN-100'},409],
    [{sku:'FRESH',name:'Duplicate aliases',barcodes:['ALT','ALT']},409],
    [{sku:'FRESH',name:'Primary repeats alias',barcode:'ALT',barcodes:['ALT']},409],
    [{sku:'FRESH',name:'Own SKU as barcode',barcode:'FRESH'},409],
    [{sku:'',name:'Missing SKU'},400],[{sku:'bad sku',name:'Whitespace SKU'},400],[{sku:'A'.repeat(65),name:'Oversize'},400],[{sku:123,name:'Numeric SKU'},400],
    [{sku:'FRESH',name:''},400],[{sku:'FRESH',name:true},400],[{sku:'FRESH',name:'A'.repeat(161)},400],
    ...['price','cost'].flatMap(field=>[-1,true,null,'NaN','Infinity','1.001',1e-9,'1e-2'].map(value=>[{sku:'FRESH',name:'Invalid money',[field]:value},400])),
    ...['stock','min'].flatMap(field=>[-1,true,null,1.5,'2',1000000001].map(value=>[{sku:'FRESH',name:'Invalid quantity',[field]:value},400])),
    [{sku:'FRESH',name:'Invalid barcode',barcode:12345},400],[{sku:'FRESH',name:'Invalid alias',barcodes:['']},400],
    [{sku:'FRESH',name:'Untrusted fields',reserved:12},400],[{sku:'FRESH',name:'Untrusted fields',tenantId:admin.store.id},400],
  ];
  for(const [input,status]of cases){const response=await f.action(admin,'create-product',{...input,requestId:randomUUID()});assert.equal(response.status,status,JSON.stringify(input)+' '+JSON.stringify(response.j));assert.deepEqual(f.snapshot(),before)}
});

test('channel products use an exact channel/shop/product/variant identity and many listings can share one central SKU',async t=>{
  const f=await fixture(t);await f.create('ONE-POOL',{stock:9});
  const inputs=[listing('ONE-POOL'),listing('ONE-POOL',{channel:'Lazada'}),listing('ONE-POOL',{channel:'TikTok Shop'}),listing('ONE-POOL',{shopId:'123'}),listing('ONE-POOL',{productId:'456'}),listing('ONE-POOL',{variantId:'789'}),listing('ONE-POOL',{variantId:''})];
  const identities=[];for(const input of inputs){const result=await f.link(input);assert.match(result.mappingId,/^[a-f0-9]{32}$/);assert.equal(result.version,1);identities.push(result.mappingId)}
  assert.equal(new Set(identities).size,inputs.length);const data=await f.state();assert.equal(data.productMappings.length,inputs.length);
  for(let i=0;i<inputs.length;i++){const mapping=data.productMappings.find(item=>item.id===identities[i]);assert.ok(mapping);for(const field of ['channel','shopId','productId','variantId','centralSku'])assert.equal(mapping[field],inputs[i][field]);const resolved=resolveChannelProduct(f.raw(),inputs[i]);assert.equal(resolved.product.sku,'ONE-POOL');assert.equal(resolved.mapping.id,identities[i])}
  assert.equal(data.products.find(product=>product.sku==='ONE-POOL').stock,9,'linking listings does not add marketplace stock into the central pool');
  const before=f.snapshot(),duplicate=await f.action(f.admin,'link-channel-product',inputs[0]);assert.equal(duplicate.status,409);assert.deepEqual(f.snapshot(),before);
});

test('mapping edits require the current version, reject malformed or duplicate identities and unlink without changing product stock',async t=>{
  const f=await fixture(t),{admin}=f;await f.create('OLD-CENTRAL');await f.create('NEW-CENTRAL');
  const first=await f.link(listing('OLD-CENTRAL')),second=await f.link(listing('OLD-CENTRAL',{productId:'OTHER'}));
  let before=f.snapshot();
  for(const input of [
    listing('NEW-CENTRAL',{mappingId:first.mappingId}),
    listing('NEW-CENTRAL',{mappingId:first.mappingId,expectedVersion:0}),
    listing('NEW-CENTRAL',{mappingId:first.mappingId,expectedVersion:'1'}),
    listing('NEW-CENTRAL',{shopId:123}),listing('NEW-CENTRAL',{productId:''}),listing('NEW-CENTRAL',{variantId:true}),
    listing('NEW-CENTRAL',{shopId:'0000123\n'}),listing('NEW-CENTRAL',{productId:'\t0000456'}),listing('NEW-CENTRAL',{variantId:'0000\u200b789'}),
    listing('NEW-CENTRAL',{channel:'Facebook'}),listing('NEW-CENTRAL',{apiKey:'never-collect-credentials'}),listing('NEW-CENTRAL',{stock:900}),
  ]){const response=await f.action(admin,'link-channel-product',input);assert.equal(response.status,400,JSON.stringify(input));assert.deepEqual(f.snapshot(),before)}
  assert.equal((await f.action(admin,'link-channel-product',listing('MISSING'))).status,404);assert.deepEqual(f.snapshot(),before);
  assert.equal((await f.action(admin,'link-channel-product',listing('NEW-CENTRAL',{mappingId:'0'.repeat(32),expectedVersion:1}))).status,404);assert.deepEqual(f.snapshot(),before);
  assert.equal((await f.action(admin,'link-channel-product',listing('NEW-CENTRAL',{mappingId:second.mappingId,expectedVersion:1}))).status,409);assert.deepEqual(f.snapshot(),before,'a mapping update cannot steal another exact identity');
  const updated=await f.link(listing('NEW-CENTRAL',{mappingId:first.mappingId,expectedVersion:1,name:'รายการที่แก้ไข'}));assert.equal(updated.mappingId,first.mappingId);assert.equal(updated.version,2);
  before=f.snapshot();assert.equal((await f.action(admin,'link-channel-product',listing('OLD-CENTRAL',{mappingId:first.mappingId,expectedVersion:1}))).status,409);assert.deepEqual(f.snapshot(),before,'stale browser edits cannot replace the newer mapping');
  assert.equal((await f.action(admin,'unlink-channel-product',{mappingId:first.mappingId,expectedVersion:1})).status,409);assert.deepEqual(f.snapshot(),before);
  const products=(await f.state()).products;assert.equal((await f.action(admin,'unlink-channel-product',{mappingId:first.mappingId,expectedVersion:2})).status,200);
  assert.ok(!(await f.state()).productMappings.some(item=>item.id===first.mappingId));assert.deepEqual((await f.state()).products,products);
  before=f.snapshot();assert.equal((await f.action(admin,'unlink-channel-product',{mappingId:first.mappingId,expectedVersion:2})).status,404);assert.deepEqual(f.snapshot(),before);
});

test('simulated orders from all three marketplaces reserve the same inventory and hold shortages without deducting physical stock',async t=>{
  const f=await fixture(t),{admin}=f;await f.create('SHARED-001',{stock:5,price:29.99,cost:8.25});
  const mapped=[];for(const channel of ['Shopee','Lazada','TikTok Shop'])mapped.push(await f.link(listing('SHARED-001',{channel})));
  const orderIds=[];
  for(let i=0;i<mapped.length;i++){
    const before=f.raw(),response=await f.action(admin,'simulate-mapped-order',{mappingId:mapped[i].mappingId,qty:2,requestId:randomUUID()});assert.equal(response.status,200,JSON.stringify(response.j));assert.equal(response.j.result.mappingId,mapped[i].mappingId);assert.equal(response.j.result.status,i<2?'ready':'hold');orderIds.push(response.j.result.orderId);
    const data=f.raw(),order=data.orders.find(item=>item.id===response.j.result.orderId);assert.equal(order.channel,['Shopee','Lazada','TikTok Shop'][i]);assert.deepEqual(order.items.map(({sku,qty})=>({sku,qty})),[{sku:'SHARED-001',qty:2}]);assert.equal(order.reserved,i<2);assert.equal(order.items[0].price,29.99);assert.equal(order.items[0].cost,8.25);assert.equal(data.products.find(item=>item.sku==='SHARED-001').stock,5);
    assert.ok(order.shippingAddress.addressLine);assert.ok(order.phone);assert.ok(order.customer);assert.equal(reserved(data,'SHARED-001'),i<2?(i+1)*2:4);assert.equal(available(data,'SHARED-001'),i<2?5-(i+1)*2:1);
    if(i===2){assert.ok(order.holdReason);for(const id of orderIds.slice(0,2))assert.deepEqual(data.orders.find(item=>item.id===id),before.orders.find(item=>item.id===id),'stock shortage preserves previous orders/reservations')}
    for(const channel of ['Shopee','Lazada','TikTok Shop'])assert.equal(data.publishedStock[channel].qty['SHARED-001'],available(data,'SHARED-001'));
  }
});

test('mapping edits and removal preserve reserved order SKU snapshots and dispatch decreases central physical stock only once',async t=>{
  const f=await fixture(t),{admin}=f;await f.create('ORIGINAL-001',{stock:3,barcode:'000011112222'});await f.create('REPLACEMENT-001',{stock:10});
  const first=await f.link(listing('ORIGINAL-001')),response=await f.action(admin,'simulate-mapped-order',{mappingId:first.mappingId,qty:2,requestId:randomUUID()});assert.equal(response.status,200);const id=response.j.result.orderId;
  const original=structuredClone(f.raw().orders.find(item=>item.id===id));
  assert.deepEqual(original.sourceMapping,{mappingId:first.mappingId,version:1,channel:'Shopee',shopId:'0000123',productId:'0000456',variantId:'0000789',centralSku:'ORIGINAL-001'});
  await f.link(listing('REPLACEMENT-001',{mappingId:first.mappingId,expectedVersion:1}));assert.equal((await f.action(admin,'unlink-channel-product',{mappingId:first.mappingId,expectedVersion:2})).status,200);
  assert.deepEqual(f.raw().orders.find(item=>item.id===id),original,'catalog updates cannot rewrite already reserved fulfillment');
  assert.equal(reserved(f.raw(),'ORIGINAL-001'),2);assert.equal(reserved(f.raw(),'REPLACEMENT-001'),0);
  for(const [name,input]of [['start-pack',{id}],['scan',{id,code:'000011112222'}],['scan',{id,code:'000011112222'}],['complete-pack',{id}],['dispatch',{id}]])assert.equal((await f.action(admin,name,input)).status,200,name);
  let data=f.raw();assert.equal(data.products.find(item=>item.sku==='ORIGINAL-001').stock,1);assert.equal(data.products.find(item=>item.sku==='REPLACEMENT-001').stock,10);assert.equal(reserved(data,'ORIGINAL-001'),0);assert.equal(data.orders.find(item=>item.id===id).status,'shipped');
  const before=f.snapshot();assert.equal((await f.action(admin,'dispatch',{id})).status,400);assert.deepEqual(f.snapshot(),before);
  assert.equal((await f.action(admin,'simulate-mapped-order',{mappingId:first.mappingId,qty:1})).status,404);assert.deepEqual(f.snapshot(),before);
});

test('central catalogs and identical platform identities stay isolated between stores and foreign mapping IDs cannot select another tenant',async t=>{
  const f=await fixture(t),{admin}=f;await f.provision('/api/stores','beta',admin);const beta=await f.login('beta');
  await f.create('SHARED-NAME',{stock:2,barcode:'00009999'});await f.create('SHARED-NAME',{stock:7,barcode:'00009999'},beta);
  const alphaMap=await f.link(listing('SHARED-NAME')),betaMap=await f.link(listing('SHARED-NAME'),beta);assert.notEqual(alphaMap.mappingId,betaMap.mappingId);
  const alphaBefore=f.snapshot(admin),betaBefore=f.snapshot(beta);
  for(const [name,input]of [
    ['unlink-channel-product',{mappingId:betaMap.mappingId,expectedVersion:1}],
    ['link-channel-product',listing('SHARED-NAME',{mappingId:betaMap.mappingId,expectedVersion:1})],
    ['simulate-mapped-order',{mappingId:betaMap.mappingId,qty:1}],
  ]){assert.equal((await f.action(admin,name,input)).status,404,name);assert.deepEqual(f.snapshot(admin),alphaBefore);assert.deepEqual(f.snapshot(beta),betaBefore)}
  assert.equal((await f.action(admin,'simulate-mapped-order',{mappingId:betaMap.mappingId,qty:1,tenantId:beta.store.id})).status,400,'strict fields reject forged tenant selectors');assert.deepEqual(f.snapshot(beta),betaBefore);
  assert.equal((await f.action(beta,'simulate-mapped-order',{mappingId:betaMap.mappingId,qty:3,requestId:randomUUID()})).status,200);assert.equal(reserved(f.raw(beta),'SHARED-NAME'),3);assert.equal(f.raw(beta).products.find(item=>item.sku==='SHARED-NAME').stock,7);assert.deepEqual(f.snapshot(admin),alphaBefore);
});

test('product/mapping/order replay is durable across restart and mismatched request IDs cannot duplicate inventory or reservations',async t=>{
  const f=await fixture(t),{admin}=f;
  const createInput={sku:'PERSISTENT-001',name:'สินค้าคงอยู่',stock:5,barcode:'00005555',requestId:randomUUID()};const create=await f.action(admin,'create-product',createInput);assert.equal(create.status,200);
  const mapInput=listing('PERSISTENT-001',{requestId:randomUUID()}),mapping=await f.action(admin,'link-channel-product',mapInput);assert.equal(mapping.status,200);
  const orderInput={mappingId:mapping.j.result.mappingId,qty:2,requestId:randomUUID()},order=await f.action(admin,'simulate-mapped-order',orderInput);assert.equal(order.status,200);const persisted=f.snapshot();
  for(const [name,input,original]of [['create-product',createInput,create],['link-channel-product',mapInput,mapping],['simulate-mapped-order',orderInput,order]]){const replay=await f.action(admin,name,input);assert.equal(replay.status,200);assert.deepEqual(replay.j.result,original.j.result);assert.deepEqual(f.snapshot(),persisted)}
  assert.equal((await f.action(admin,'simulate-mapped-order',{...orderInput,qty:1})).status,409);assert.deepEqual(f.snapshot(),persisted);
  await f.restart();const resumed=await f.login('alpha'),restored=f.snapshot(resumed);
  assert.equal(restored.data,persisted.data);assert.equal(restored.requests,persisted.requests);assert.equal(restored.audits,persisted.audits+1,'restored login creates its own security event');
  for(const [name,input,original]of [['create-product',createInput,create],['link-channel-product',mapInput,mapping],['simulate-mapped-order',orderInput,order]]){const replay=await f.action(resumed,name,input);assert.equal(replay.status,200);assert.deepEqual(replay.j.result,original.j.result);assert.deepEqual(f.snapshot(resumed),restored)}
  const data=f.raw(resumed);assert.equal(data.products.filter(item=>item.sku==='PERSISTENT-001').length,1);assert.equal(data.productMappings.filter(item=>item.id===mapping.j.result.mappingId).length,1);assert.equal(data.orders.filter(item=>item.id===order.j.result.orderId).length,1);assert.equal(reserved(data,'PERSISTENT-001'),2);assert.equal(available(data,'PERSISTENT-001'),3);
});

test('batch listing resolution aggregates central demand and fails closed on unmapped or ambiguous legacy products without mutation',async t=>{
  const f=await fixture(t);await f.create('BATCH-001',{stock:9,price:12.5,cost:3});
  await f.link(listing('BATCH-001',{variantId:'A'}));await f.link(listing('BATCH-001',{variantId:'B'}));
  const data=f.raw(),before=structuredClone(data),batch={channel:'Shopee',shopId:'0000123',items:[{productId:'0000456',variantId:'A',qty:2},{productId:'0000456',variantId:'B',qty:3}]};
  assert.deepEqual(resolveChannelItems(data,batch),[{sku:'BATCH-001',qty:5,price:12.5,cost:3}]);assert.deepEqual(data,before);
  assert.throws(()=>resolveChannelItems(data,{...batch,items:[...batch.items,{productId:'MISSING',variantId:'A',qty:1}]}),error=>error.status===409);assert.deepEqual(data,before,'a mixed unmapped batch cannot partly reserve or alter stock');
  data.productMappings.push({...data.productMappings[0],id:'f'.repeat(32),centralSku:'CLN-100'});const ambiguous=structuredClone(data);
  assert.throws(()=>resolveChannelProduct(data,{channel:'Shopee',shopId:'0000123',productId:'0000456',variantId:'A'}),error=>error.status===409);assert.deepEqual(data,ambiguous);
});

test('projected listing mappings expose only operational text and versions, excluding legacy credentials and financial payloads for all roles',async t=>{
  const f=await fixture(t),{admin}=f,worker=await f.member('warehouse'),finance=await f.member('finance');
  const text='<img src=x onerror=window.catalogFixtureXss=true>';
  await f.create('TEXT-001',{name:text,price:12.5,cost:3});const linked=await f.link(listing('TEXT-001',{sellerSku:text,name:text}));
  const data=f.raw(),mapping=data.productMappings.find(item=>item.id===linked.mappingId);
  Object.assign(mapping,{accessToken:'fixture-secret-never-public',refreshToken:'fixture-secret-never-public',apiKey:'fixture-secret-never-public',price:900,cost:800,providerPayload:{secret:'fixture-secret-never-public',finance:500},extra:{name:'unsafe nested object'}});
  f.save(admin,data);
  for(const session of [admin,worker,finance]){
    const projected=await f.state(session),safe=projected.productMappings.find(item=>item.id===linked.mappingId);
    assert.equal(safe.name,text);assert.equal(safe.sellerSku,text);assert.equal(safe.version,1);assert.equal(safe.centralSku,'TEXT-001');
    for(const field of ['accessToken','refreshToken','apiKey','price','cost','providerPayload','extra'])assert.ok(!(field in safe),field);
    assert.ok(!JSON.stringify(safe).includes('fixture-secret-never-public'));
    if(session===worker){const product=projected.products.find(item=>item.sku==='TEXT-001');assert.equal(product.name,text);assert.ok(!('price' in product));assert.ok(!('cost' in product))}
  }
});
