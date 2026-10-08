import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createApp} from '../server/index.mjs';
import {createEmailFixture} from './email-fixture.mjs';
import {bangkokDate} from '../server/shipping.mjs';

const PASSWORD='Shipment-fixture-password-001';
const address={addressLine:'123 ถนนตัวอย่าง',subdistrict:'ปทุมวัน',district:'ปทุมวัน',province:'กรุงเทพมหานคร',postalCode:'10330'};
const sessionOf=response=>({cookie:response.cookie,csrf:response.j.csrf,user:response.j.user,store:response.j.store});
const prepared=(id,extra={})=>({id,method:'pickup',pickupDate:bangkokDate(),pickupTimeFrom:'09:00',pickupTimeTo:'17:00',package:{weightGrams:500,lengthCm:20,widthCm:15,heightCm:10},sender:{name:'คลัง fixture',phone:'0812345678',...address},carrier:'Flash Express',notes:'คำขอจัดส่งสำหรับทดสอบในเครื่อง',...extra});
async function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'order-hub-shipping-api-')),dbPath=path.join(dir,'fixture.sqlite');
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
  async function provision(route,storeCode,session){const fields={storeCode,storeName:storeCode,name:'Shipment fixture admin',username:'same_owner',password:PASSWORD,email:`${storeCode}@shipment.fixture.example`};const response=await request(route,await email.signup((otpRoute,body)=>request(otpRoute,body,session),fields),session);assert.equal(response.status,201,JSON.stringify(response.j));return sessionOf(response)}
  const admin=await provision('/api/auth/setup','alpha');
  const action=(session,action,input={},headers={})=>request('/api/actions',{action,...input},session,'POST',headers);
  async function state(session=admin){const response=await request('/api/state',undefined,session);assert.equal(response.status,200);return response.j.data}
  async function makeOrder(session=admin,{packed=true,channel='Offline sales'}={}){
    const created=await action(session,'create-order',{channel:'Offline sales',items:[{sku:'CLN-100',qty:1}],customer:'ผู้รับ fixture',phone:'0812345678',shippingAddress:address});assert.equal(created.status,200,JSON.stringify(created.j));const id=created.j.result.orderId;
    if(packed){for(const [name,input]of [['reserve',{id}],['start-pack',{id}],['scan',{id,code:'CLN-100'}],['complete-pack',{id}]])assert.equal((await action(session,name,input)).status,200)}
    if(channel!=='Offline sales'){const data=await state(session),order=data.orders.find(order=>order.id===id);order.channel=channel;order.external=`FIXTURE-${channel}-${id}`;saveState(session,data)}
    return id;
  }
  function saveState(session,data){app.db.prepare('UPDATE tenant_state SET data=? WHERE tenant_id=?').run(JSON.stringify(data),session.store.id)}
  async function login(storeCode,username='same_owner'){const response=await request('/api/auth/login',{storeCode,username,password:PASSWORD});assert.equal(response.status,200,JSON.stringify(response.j));return sessionOf(response)}
  async function member(role){const username=`${role}_fixture`;const response=await request('/api/users',{name:'Shipment '+role,username,password:PASSWORD,role},admin);assert.equal(response.status,201,JSON.stringify(response.j));return login('alpha',username)}
  return {admin,action,state,request,provision,makeOrder,login,member,saveState,restart:async()=>{await stop();await start()}};
}

function assertUnchangedFulfillment(before,after,id){
  const original=before.orders.find(order=>order.id===id),current=after.orders.find(order=>order.id===id);
  for(const field of ['status','reserved','tracking','scanned'])assert.deepEqual(current[field],original[field],field+' cannot change merely by preparing pickup');
  assert.deepEqual(after.products,before.products,'shipment preparation cannot deduct physical stock');
  assert.deepEqual(after.lastStock,before.lastStock);assert.deepEqual(after.publishedStock,before.publishedStock);
}

test('shipping preparation requires packing, authenticated warehouse/admin roles and valid CSRF',async t=>{
  const f=await fixture(t),{admin}=f,worker=await f.member('warehouse'),finance=await f.member('finance');
  const newId=await f.makeOrder(admin,{packed:false}),packedId=await f.makeOrder();let before=await f.state();
  assert.equal((await f.action(admin,'request-shipment',prepared(newId))).status,409);
  assert.equal((await f.action(admin,'cancel-shipment',{id:packedId})).status,409,'a nonexistent request cannot be cancelled');
  assert.equal((await f.action(undefined,'request-shipment',prepared(packedId))).status,401);
  assert.equal((await f.action(finance,'request-shipment',prepared(packedId))).status,403);
  assert.equal((await f.action(admin,'request-shipment',prepared(packedId),{'X-CSRF-Token':''})).status,403);
  assert.equal((await f.action(admin,'request-shipment',prepared(packedId),{Origin:'https://foreign.example'})).status,403);
  assert.deepEqual(await f.state(),before,'failed authorization and packing checks leave all state unchanged');
  const response=await f.action(worker,'request-shipment',prepared(packedId));assert.equal(response.status,200,JSON.stringify(response.j));assert.equal(response.j.result.status,'awaiting_connection');assert.equal(response.j.result.readiness.ready,false);
  assertUnchangedFulfillment(before,await f.state(),packedId);
  const secondId=await f.makeOrder();assert.equal((await f.action(admin,'request-shipment',prepared(secondId))).status,200,'Admin can prepare its own packed order');
});

test('shipment request replay keeps one identity and audit across cold restart; changed request data is rejected',async t=>{
  const f=await fixture(t),{admin}=f,id=await f.makeOrder(),requestId=randomUUID(),input=prepared(id,{requestId});
  const before=await f.state(),first=await f.action(admin,'request-shipment',input);assert.equal(first.status,200,JSON.stringify(first.j));assert.match(first.j.result.shipmentId,/^SHIP-/);
  const persisted=await f.state();assertUnchangedFulfillment(before,persisted,id);
  const repeated=await f.action(admin,'request-shipment',input);assert.deepEqual(repeated.j.result,first.j.result);assert.deepEqual(await f.state(),persisted);
  assert.equal((await f.action(admin,'request-shipment',{...input,notes:'changed details'})).status,409);assert.deepEqual(await f.state(),persisted);
  assert.equal((await f.action(admin,'request-shipment',{...input,requestId:randomUUID()})).status,200,'an equal preparation also reuses its order-level identity');assert.deepEqual(await f.state(),persisted);
  assert.equal((await f.action(admin,'request-shipment',{...input,requestId:randomUUID(),package:{...input.package,weightGrams:700}})).status,409);assert.deepEqual(await f.state(),persisted);
  await f.restart();const resumed=await f.login('alpha'),response=await f.action(resumed,'request-shipment',input);assert.equal(response.status,200);assert.deepEqual(response.j.result,first.j.result);assert.deepEqual(await f.state(resumed),persisted);
});

test('foreign order IDs cannot prepare or cancel pickup in another shop',async t=>{
  const f=await fixture(t),{admin}=f;await f.provision('/api/stores','beta',admin);const beta=await f.login('beta');
  assert.equal((await f.action(beta,'stock-receive',{sku:'CLN-100',qty:3})).status,200);
  const id=await f.makeOrder(beta),alphaBefore=await f.state(admin),betaBefore=await f.state(beta);
  assert.equal((await f.action(admin,'request-shipment',prepared(id))).status,404);assert.equal((await f.action(admin,'cancel-shipment',{id})).status,404);
  assert.deepEqual(await f.state(admin),alphaBefore);assert.deepEqual(await f.state(beta),betaBefore);
  assert.equal((await f.action(beta,'request-shipment',prepared(id))).status,200);const preparedBeta=await f.state(beta);
  assert.equal((await f.action(admin,'cancel-shipment',{id})).status,404);assert.deepEqual(await f.state(beta),preparedBeta);
});

test('cancelling a prepared pickup is idempotent and leaves the packed reservation intact for replacement',async t=>{
  const f=await fixture(t),{admin}=f,worker=await f.member('warehouse'),finance=await f.member('finance'),id=await f.makeOrder();
  const first=await f.action(worker,'request-shipment',prepared(id));assert.equal(first.status,200);const before=await f.state();
  assert.equal((await f.action(finance,'cancel-shipment',{id})).status,403);assert.deepEqual(await f.state(),before);
  const input={id,requestId:randomUUID()},cancelled=await f.action(worker,'cancel-shipment',input);assert.equal(cancelled.status,200);assert.equal(cancelled.j.result.status,'cancelled');assert.equal(cancelled.j.result.shipmentId,first.j.result.shipmentId);
  const after=await f.state();assertUnchangedFulfillment(before,after,id);assert.equal(after.orders.find(order=>order.id===id).shipment.status,'cancelled');
  assert.deepEqual((await f.action(worker,'cancel-shipment',input)).j.result,cancelled.j.result);assert.deepEqual(await f.state(),after);
  assert.equal((await f.action(admin,'cancel-shipment',{id,requestId:randomUUID()})).status,200);assert.deepEqual(await f.state(),after,'a fresh cancellation request also remains a no-op');
  const replacement=await f.action(admin,'request-shipment',prepared(id,{method:'dropoff',pickupDate:'',pickupTimeFrom:'',pickupTimeTo:'',notes:'replacement'}));assert.equal(replacement.status,200);assert.notEqual(replacement.j.result.shipmentId,first.j.result.shipmentId);assertUnchangedFulfillment(after,await f.state(),id);
});

test('shipment input validation cannot mutate a packed order or accept a browser-supplied recipient/provider payload',async t=>{
  const f=await fixture(t),{admin}=f,id=await f.makeOrder(),before=await f.state();
  for(const extra of [
    {package:{weightGrams:0,lengthCm:20,widthCm:15,heightCm:10}},
    {package:{weightGrams:500,lengthCm:0,widthCm:15,heightCm:10}},
    {sender:{name:'not a complete address'}},{pickupDate:'2025-02-30'},
    {method:'instant'},{carrier:'unapproved carrier'},{pickupTimeFrom:'17:00',pickupTimeTo:'09:00'},
    {recipient:{name:'browser-changed recipient'}},{ready:true},{apiKey:'fixture-never-send'},
    {package:{weightGrams:500,lengthCm:20,widthCm:15,heightCm:10,price:900}},
  ]){
    const response=await f.action(admin,'request-shipment',prepared(id,extra));assert.equal(response.status,400,JSON.stringify(extra));assert.deepEqual(await f.state(),before);
  }
  assert.equal((await f.action(admin,'request-shipment',prepared(id))).status,200);
  const shipment=(await f.state()).orders.find(order=>order.id===id).shipment;
  assert.equal(shipment.recipient.name,'ผู้รับ fixture');assert.equal(shipment.recipient.addressLine,address.addressLine);assert.deepEqual(shipment.items,[{sku:'CLN-100',qty:1}]);
});

test('each marketplace preparation remains awaiting verified platform access and cannot choose an arbitrary carrier',async t=>{
  const f=await fixture(t),{admin}=f;
  for(const channel of ['TikTok Shop','Shopee','Lazada']){
    const draft=await f.request('/api/connections',{channel,storeName:'fixture '+channel,storeUrl:'https://shop.fixture.example',status:'connected',ready:true},admin);assert.equal(draft.status,200);assert.equal(draft.j.live,false);
    const id=await f.makeOrder(admin,{channel}),before=await f.state(),input=prepared(id);delete input.carrier;
    assert.equal((await f.action(admin,'request-shipment',{...input,carrier:'Flash Express'})).status,400);
    const response=await f.action(admin,'request-shipment',input);assert.equal(response.status,200,JSON.stringify(response.j));assert.equal(response.j.result.status,'awaiting_connection');assert.equal(response.j.result.readiness.ready,false);assert.equal(response.j.result.readiness.provider,channel);assert.equal(response.j.result.readiness.connectionRequired,'platform');
    const after=await f.state(),shipment=after.orders.find(order=>order.id===id).shipment;
    assert.equal(shipment.provider,channel);assert.equal(shipment.channel,channel);assert.match(shipment.sourceOrderExternal,/^FIXTURE-/);assertUnchangedFulfillment(before,after,id);
  }
});

test('shipping readiness requires an authorized account and stays false for every platform despite saved connection drafts',async t=>{
  const f=await fixture(t),{admin}=f,worker=await f.member('warehouse'),finance=await f.member('finance');
  assert.equal((await f.request('/api/shipping/readiness')).status,401);
  assert.equal((await f.request('/api/shipping/readiness',undefined,finance)).status,403);
  const initial=await f.request('/api/shipping/readiness',undefined,admin);assert.equal(initial.status,200,JSON.stringify(initial.j));assert.equal(initial.j.live,false);assert.equal(initial.j.providers.length,7);
  assert.ok(initial.j.providers.every(provider=>provider.ready===false&&provider.status==='not_connected'));
  for(const channel of ['TikTok Shop','Shopee','Lazada']){
    const draft=await f.request('/api/connections',{channel,storeName:'fixture '+channel,storeUrl:'https://shop.fixture.example',status:'connected',ready:true,live:true},admin);assert.equal(draft.status,200);assert.equal(draft.j.live,false);
  }
  const after=await f.request('/api/shipping/readiness',undefined,worker);assert.equal(after.status,200);assert.deepEqual(after.j,initial.j);
  for(const channel of ['TikTok Shop','Shopee','Lazada']){
    const provider=after.j.providers.find(provider=>provider.channel===channel);assert.equal(provider.provider,channel);assert.equal(provider.connectionRequired,'platform');assert.ok(provider.requirements.length>0);assert.ok(provider.officialLinks.every(link=>new URL(link.url).protocol==='https:'));
  }
});

test('warehouse shipment projection keeps packing contacts while excluding credentials, raw provider payload and finance fields',async t=>{
  const f=await fixture(t),{admin}=f,worker=await f.member('warehouse'),id=await f.makeOrder();
  assert.equal((await f.action(admin,'request-shipment',prepared(id))).status,200);
  const data=await f.state(),shipment=data.orders.find(order=>order.id===id).shipment;
  Object.assign(shipment,{apiKey:'fixture-secret-do-not-leak',accessToken:'fixture-secret-do-not-leak',password:'fixture-secret-do-not-leak',price:999,cost:111,providerPayload:{secret:'fixture-secret-do-not-leak',amount:999}});
  shipment.items[0].price=999;shipment.items[0].cost=111;shipment.package.cost=111;shipment.sender.secret='fixture-secret-do-not-leak';shipment.recipient.secret='fixture-secret-do-not-leak';
  f.saveState(admin,data);
  const projected=await f.state(worker),order=projected.orders.find(order=>order.id===id),safe=order.shipment;
  assert.equal(safe.sender.name,'คลัง fixture');assert.equal(safe.recipient.name,'ผู้รับ fixture');assert.deepEqual(safe.items,[{sku:'CLN-100',qty:1}]);
  assert.deepEqual(safe.package,{weightGrams:500,lengthCm:20,widthCm:15,heightCm:10});assert.ok(!JSON.stringify(safe).includes('fixture-secret-do-not-leak'));
  for(const field of ['apiKey','accessToken','password','price','cost','providerPayload'])assert.ok(!(field in safe),field);
  for(const field of ['payment','discount','refund','subtotal','lineDiscount','itemNetTotal','shippingFee','grandTotal'])assert.ok(!(field in order),field);
});

test('parent cancellation and demo dispatch close a pending preparation and preserve their respective stock effects',async t=>{
  const f=await fixture(t),{admin}=f;
  for(const parentAction of ['cancel','dispatch']){
    const id=await f.makeOrder();assert.equal((await f.action(admin,'request-shipment',prepared(id))).status,200);
    const before=await f.state(),stock=before.products.find(product=>product.sku==='CLN-100').stock;
    assert.equal((await f.action(admin,parentAction,{id,requestId:randomUUID()})).status,200);
    const after=await f.state(),order=after.orders.find(order=>order.id===id);
    assert.equal(order.shipment.status,'cancelled');assert.equal(order.shipment.cancelledBy,'system');assert.ok(order.shipment.cancellationReason);
    assert.equal(order.status,parentAction==='cancel'?'cancelled':'shipped');assert.equal(order.reserved,false);
    assert.equal(after.products.find(product=>product.sku==='CLN-100').stock,stock-(parentAction==='dispatch'?1:0));
    if(parentAction==='dispatch')assert.match(order.tracking,/^DEMO/);else assert.equal(order.tracking,'');
    assert.equal((await f.action(admin,'request-shipment',prepared(id))).status,409,'closed orders cannot reactivate an old pickup');
    assert.equal((await f.action(admin,'cancel-shipment',{id})).status,409,'order closure uses parent fulfillment state');
    assert.deepEqual(await f.state(),after);
  }
});
