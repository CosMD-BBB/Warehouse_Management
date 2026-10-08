import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createApp} from '../server/index.mjs';
import {createEmailFixture} from './email-fixture.mjs';

const PASSWORD='Barcode-fixture-password-001';
const address={addressLine:'123 ถนนตัวอย่าง',subdistrict:'ปทุมวัน',district:'ปทุมวัน',province:'กรุงเทพมหานคร',postalCode:'10330'};
const sessionOf=response=>({cookie:response.cookie,csrf:response.j.csrf,user:response.j.user,store:response.j.store});
async function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'order-hub-barcode-')),dbPath=path.join(dir,'fixture.sqlite');
  const email=createEmailFixture();let app,origin;
  async function start(){app=createApp({dbPath,emailAuth:email.emailAuth});await new Promise((resolve,reject)=>{app.server.once('error',reject);app.server.listen(0,'127.0.0.1',resolve)});origin='http://127.0.0.1:'+app.server.address().port}
  async function stop(){if(!app)return;const current=app;app=null;await new Promise((resolve,reject)=>current.server.close(error=>error?reject(error):resolve()))}
  await start();t.after(async()=>{try{await stop()}finally{fs.rmSync(dir,{recursive:true,force:true})}});
  async function request(route,body,session,method=body?'POST':'GET'){
    const headers={};if(session){headers.Cookie=session.cookie;headers['X-CSRF-Token']=session.csrf}
    if(method!=='GET'){headers.Origin=origin;headers['Content-Type']='application/json'}
    const response=await fetch(origin+route,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
    return {status:response.status,j:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};
  }
  async function provision(route,storeCode,session){const fields={storeCode,storeName:storeCode,name:'Barcode fixture admin',username:'same_owner',password:PASSWORD,email:`${storeCode}@barcode.fixture.example`};const response=await request(route,await email.signup((otpRoute,body)=>request(otpRoute,body,session),fields),session);assert.equal(response.status,201,JSON.stringify(response.j));return sessionOf(response)}
  const admin=await provision('/api/auth/setup','alpha');
  const action=(session,action,input={})=>request('/api/actions',{action,...input},session);
  async function state(session=admin){const response=await request('/api/state',undefined,session);assert.equal(response.status,200);return response.j.data}
  async function makeOrder(session=admin,items=[{sku:'CLN-100',qty:2}],channel='Offline sales'){
    const created=await action(session,'create-order',{channel,items,customer:'ผู้รับ fixture',phone:'0812345678',shippingAddress:address});assert.equal(created.status,200,JSON.stringify(created.j));const id=created.j.result.orderId;
    if(channel!=='Review')assert.equal((await action(session,'reserve',{id})).status,200);
    assert.equal((await action(session,'start-pack',{id})).status,200);return id;
  }
  async function login(storeCode,username='same_owner'){const response=await request('/api/auth/login',{storeCode,username,password:PASSWORD});assert.equal(response.status,200,JSON.stringify(response.j));return sessionOf(response)}
  async function member(role){const username=`${role}_fixture`;const response=await request('/api/users',{name:'Barcode '+role,username,password:PASSWORD,role},admin);assert.equal(response.status,201,JSON.stringify(response.j));return login('alpha',username)}
  return {admin,action,state,request,provision,makeOrder,login,member,restart:async()=>{await stop();await start()},get db(){return app.db}};
}

test('a HID scan resolves exact leading-zero barcodes and aliases, counts one unit and keeps replay idempotent across restart',async t=>{
  const f=await fixture(t),{admin}=f;
  assert.equal((await f.action(admin,'set-barcode',{sku:'CLN-100',barcode:'0001234567890',barcodes:['ALT-CLEANSER']})).status,200);
  const id=await f.makeOrder(),requestId=randomUUID();
  const input={id,code:'0001234567890',requestId};
  const first=await f.action(admin,'scan',input);assert.equal(first.status,200);assert.deepEqual(first.j.result,{message:'ตรวจสินค้า CLN-100 1/2',orderId:id,sku:'CLN-100',scanned:1,required:2});
  assert.equal((await f.action(admin,'scan',input)).status,200,'network retry acknowledges the same physical scan');
  assert.equal((await f.state()).orders.find(order=>order.id===id).scanned['CLN-100'],1);
  assert.equal((await f.action(admin,'scan',{...input,code:'ALT-CLEANSER'})).status,409,'a retry ID cannot be repurposed');
  await f.restart();const restored=await f.login('alpha');
  assert.equal((await f.action(restored,'scan',input)).status,200,'completed scan request survives process restart');
  let data=await f.state(restored);assert.equal(data.products.find(product=>product.sku==='CLN-100').barcode,'0001234567890');assert.equal(data.orders.find(order=>order.id===id).scanned['CLN-100'],1);
  assert.equal((await f.action(restored,'scan',{id,code:'ALT-CLEANSER',requestId:randomUUID()})).status,200);
  data=await f.state(restored);const before=structuredClone(data);
  assert.equal((await f.action(restored,'scan',{id,code:'0001234567890',requestId:randomUUID()})).status,400,'an extra physical scan cannot exceed the order quantity');
  assert.deepEqual(await f.state(restored),before);
  assert.equal((await f.action(restored,'complete-pack',{id})).status,200);
  assert.equal((await f.action(restored,'scan',{id,code:'0001234567890'})).status,400,'a closed box rejects further scans');
});

test('unknown, malformed, wrong-order and conflicting client-SKU scans cannot change counts, stock or audit',async t=>{
  const f=await fixture(t),{admin}=f;
  for(const [sku,barcode]of [['CLN-100','00001111'],['SUN-050','00002222']])assert.equal((await f.action(admin,'set-barcode',{sku,barcode})).status,200);
  const id=await f.makeOrder(),before=await f.state();
  for(const input of [
    {code:'1111'}, // A numeric-looking barcode must keep its leading zeros.
    {code:'00002222'}, // Product exists, but belongs to a different order line.
    {code:'00002222',sku:'CLN-100'}, // SKU cannot override the scanned product.
    {code:'UNKNOWN',sku:'CLN-100'},
    {code:''},{code:1111},{code:null},{code:'a'.repeat(129)},
    {code:'0000 1111'},{code:'00001111\n'},{code:'0000\u00001111'},{code:'0000\u200b1111'},
  ]){
    const response=await f.action(admin,'scan',{id,...input,requestId:randomUUID()});assert.equal(response.status,400,JSON.stringify(input));assert.deepEqual(await f.state(),before,'rejected scan has no mutation');
  }
  assert.equal((await f.action(admin,'complete-pack',{id})).status,400,'wrong scans cannot authorize closing a box');
  assert.equal((await f.action(admin,'scan',{id,sku:'CLN-100'})).status,200,'legacy SKU scanning remains compatible');
  assert.equal((await f.action(admin,'scan',{id,code:'CLN-100'})).status,200,'a scanner may scan a literal SKU label');
});

test('barcode configuration rejects catalog collisions and malformed aliases atomically and can clear configured codes',async t=>{
  const f=await fixture(t),{admin}=f;
  assert.equal((await f.action(admin,'set-barcode',{sku:'CLN-100',barcode:'00001111',barcodes:['CLEANSER-ALIAS']})).status,200);
  assert.equal((await f.action(admin,'set-barcode',{sku:'SUN-050',barcode:'00002222',barcodes:['SUN-ALIAS']})).status,200);
  const before=await f.state();
  for(const [input,status]of [
    [{barcode:'00001111'},409],[{barcode:'CLEANSER-ALIAS'},409],[{barcode:'CLN-100'},409],
    [{barcode:'FREE',barcodes:['00001111']},409],[{barcode:'FREE',barcodes:['SUN-ALIAS','SUN-ALIAS']},409],
    [{barcode:'FREE',barcodes:['FREE']},409],[{barcode:'SUN-050'},409],
    [{barcode:1234},400],[{barcode:null},400],[{barcode:'\t'},400],[{barcode:'A'.repeat(129)},400],
    [{barcode:'FREE',barcodes:'ALIAS'},400],[{barcode:'FREE',barcodes:null},400],[{barcodes:[1234]},400],
    [{barcodes:['']},400],[{barcodes:Array.from({length:21},(_,index)=>`ALIAS-${index}`)},400],
  ]){
    const response=await f.action(admin,'set-barcode',{sku:'SUN-050',...input});assert.equal(response.status,status,JSON.stringify(input));assert.deepEqual(await f.state(),before);
  }
  assert.equal((await f.action(admin,'set-barcode',{sku:'NO-SUCH-SKU',barcode:'00003333'})).status,404);
  assert.equal((await f.action(admin,'set-barcode',{sku:'CLN-100',barcode:'',barcodes:[]})).status,200);
  const cleared=(await f.state()).products.find(product=>product.sku==='CLN-100');assert.equal(cleared.barcode,'');assert.deepEqual(cleared.barcodes,[]);
  assert.equal(cleared.stock,before.products.find(product=>product.sku==='CLN-100').stock);
  assert.equal(cleared.price,before.products.find(product=>product.sku==='CLN-100').price);
});

test('preexisting ambiguous barcode versus SKU mappings fail closed before packing mutation',async t=>{
  const f=await fixture(t),{admin}=f,id=await f.makeOrder();
  const current=await f.state();current.products.find(product=>product.sku==='SUN-050').barcode='CLN-100';
  f.db.prepare('UPDATE tenant_state SET data=? WHERE tenant_id=?').run(JSON.stringify(current),admin.store.id);
  const before=await f.state();assert.equal((await f.action(admin,'scan',{id,code:'CLN-100'})).status,409);assert.deepEqual(await f.state(),before);
  assert.equal((await f.action(admin,'set-barcode',{sku:'SUN-050',barcode:''})).status,200,'admin may repair an ambiguous legacy mapping');
  assert.equal((await f.action(admin,'scan',{id,code:'CLN-100'})).status,200);
});

test('barcode mappings and order scans are scoped to the authenticated shop even when a caller forges tenant IDs',async t=>{
  const f=await fixture(t),{admin}=f;
  await f.provision('/api/stores','beta',admin);const beta=await f.login('beta');
  assert.equal((await f.action(admin,'set-barcode',{sku:'CLN-100',barcode:'00009999'})).status,200);
  assert.equal((await f.action(beta,'set-barcode',{sku:'SUN-050',barcode:'00009999'})).status,200,'independent shops may reuse the same physical barcode');
  assert.equal((await f.action(beta,'stock-receive',{sku:'SUN-050',qty:3})).status,200);
  const alphaId=await f.makeOrder(),betaId=await f.makeOrder(beta,[{sku:'SUN-050',qty:2}]);
  const alphaBefore=await f.state(admin),betaBefore=await f.state(beta);
  assert.equal((await f.action(admin,'scan',{id:betaId,code:'00009999',storeId:beta.store.id})).status,404);
  assert.deepEqual(await f.state(beta),betaBefore);assert.deepEqual(await f.state(admin),alphaBefore);
  assert.equal((await f.action(beta,'scan',{id:betaId,code:'00009999',storeId:admin.store.id})).status,200);
  assert.equal((await f.state(beta)).orders.find(order=>order.id===betaId).scanned['SUN-050'],1);
  assert.deepEqual(await f.state(admin),alphaBefore,'barcode resolution stays in the session store');
  assert.equal((await f.action(admin,'scan',{id:alphaId,code:'00009999',storeId:beta.store.id})).status,200);
  assert.equal((await f.state(admin)).orders.find(order=>order.id===alphaId).scanned['CLN-100'],1);
  const betaAfter=await f.state(beta);
  assert.equal((await f.action(admin,'set-barcode',{sku:'CLN-100',barcode:'00008888',storeId:beta.store.id})).status,200);
  assert.deepEqual(await f.state(beta),betaAfter,'forged shop selectors cannot change a foreign barcode catalog');
});

test('warehouse can scan configured codes without financial data, while only admin may manage mappings',async t=>{
  const f=await fixture(t),{admin}=f;
  assert.equal((await f.action(admin,'set-barcode',{sku:'CLN-100',barcode:'00001111'})).status,200);
  const worker=await f.member('warehouse'),finance=await f.member('finance'),id=await f.makeOrder();
  const before=await f.state();
  for(const session of [worker,finance]){
    assert.equal((await f.action(session,'set-barcode',{sku:'CLN-100',barcode:'00002222'})).status,403);
    assert.deepEqual(await f.state(),before);
  }
  assert.equal((await f.action(finance,'scan',{id,code:'00001111'})).status,403);
  const scanned=await f.action(worker,'scan',{id,code:'00001111'});assert.equal(scanned.status,200);
  assert.deepEqual(Object.keys(scanned.j.result).sort(),['message','orderId','required','scanned','sku']);
  const data=await f.state(worker),product=data.products.find(product=>product.sku==='CLN-100'),order=data.orders.find(order=>order.id===id);
  assert.equal(product.barcode,'00001111');assert.ok(!('price' in product));assert.ok(!('cost' in product));assert.equal(order.shippingAddress.addressLine,address.addressLine);
  for(const field of ['payment','discount','refund','subtotal','lineDiscount','itemNetTotal','shippingFee','grandTotal'])assert.ok(!(field in order),field);
  for(const line of order.items)for(const field of ['price','cost','discount'])assert.ok(!(field in line),field);
  assert.ok(!('expenses' in data));assert.ok(!('payouts' in data));
});

test('barcode packing aggregates SKU demand and preserves the single shared stock deduction for free Review',async t=>{
  const f=await fixture(t),{admin}=f;
  assert.equal((await f.action(admin,'set-barcode',{sku:'CLN-100',barcode:'00001111'})).status,200);
  const id=await f.makeOrder(admin,[{sku:'CLN-100',qty:2}],'Review');
  let data=await f.state(),order=data.orders.find(order=>order.id===id),stock=data.products.find(product=>product.sku==='CLN-100').stock;
  assert.equal(order.reserved,true);assert.equal(order.grandTotal,0);
  // Marketplace imports can contain multiple lines sharing a SKU. Scan demand
  // must count all lines while physical inventory is deducted exactly once.
  order.items=[{...order.items[0],qty:1},{...order.items[0],qty:1}];
  f.db.prepare('UPDATE tenant_state SET data=? WHERE tenant_id=?').run(JSON.stringify(data),admin.store.id);
  for(let count=1;count<=2;count++){const response=await f.action(admin,'scan',{id,code:'00001111',requestId:randomUUID()});assert.equal(response.status,200);assert.equal(response.j.result.scanned,count);assert.equal(response.j.result.required,2)}
  assert.equal((await f.action(admin,'complete-pack',{id})).status,200);assert.equal((await f.action(admin,'dispatch',{id})).status,200);
  data=await f.state();order=data.orders.find(order=>order.id===id);
  assert.equal(data.products.find(product=>product.sku==='CLN-100').stock,stock-2);assert.equal(order.reserved,false);assert.equal(order.status,'shipped');assert.ok(order.items.every(item=>item.price===0));
  assert.equal((await f.action(admin,'dispatch',{id})).status,400);assert.equal((await f.state()).products.find(product=>product.sku==='CLN-100').stock,stock-2);
});
