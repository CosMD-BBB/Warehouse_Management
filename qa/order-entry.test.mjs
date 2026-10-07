import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createApp} from '../server/index.mjs';
import {available, reserved} from '../server/model.mjs';

const PASSWORD = 'Order-entry-fixture-password-001';
const SKU_A = 'CLN-100', SKU_B = 'SUN-050';
const address = (extra = {}) => ({
  addressLine: '99/12 อาคารทดสอบ ชั้น 3', subdistrict: 'คลองตัน', district: 'คลองเตย',
  province: 'กรุงเทพมหานคร', postalCode: '10110', ...extra,
});
const input = (extra = {}) => ({
  channel: 'Offline sales', customer: 'ผู้รับทดสอบหลายรายการ', phone: '0812345678',
  shippingAddress: address(), billingSame: true,
  items: [{sku: SKU_A, qty: 2, price: 100.25, discount: 10.10}, {sku: SKU_B, qty: 3, price: 19.99, discount: 1.01}],
  shippingFee: 20.75, discount: 5.11,
  payment: {method: 'unpaid', status: 'pending', amount: 0}, ...extra,
});
const pick = (data, id) => data.orders.find(order => order.id === id);
const stock = (data, sku) => data.products.find(product => product.sku === sku).stock;

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'order-hub-entry-'));
  const dbPath = path.join(dir, 'fixture.sqlite');
  let app, origin, admin;
  const start = async () => {
    app = createApp({dbPath});
    await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); });
    origin = `http://127.0.0.1:${app.server.address().port}`;
  };
  const stop = async () => {
    if (!app) return;
    const previous = app;
    app = null;
    await new Promise((resolve, reject) => previous.server.close(error => error ? reject(error) : resolve()));
  };
  t.after(async () => { try { await stop(); } finally { fs.rmSync(dir, {recursive: true, force: true}); } });
  await start();
  const request = async (route, {session = admin, method = 'GET', body} = {}) => {
    const headers = {};
    if (session) { headers.Cookie = session.cookie; headers['X-CSRF-Token'] = session.csrf; }
    if (method !== 'GET') { headers.Origin = origin; headers['Content-Type'] = 'application/json'; }
    const response = await fetch(origin + route, {method, headers, body: body === undefined ? undefined : JSON.stringify(body)});
    return {status: response.status, j: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0]};
  };
  const asSession = response => ({cookie: response.cookie, csrf: response.j.csrf, user: response.j.user, store: response.j.store});
  const post = (route, body, session = admin) => request(route, {session, method: 'POST', body});
  const login = async (storeCode, username = 'entry_owner') => {
    const response = await post('/api/auth/login', {storeCode, username, password: PASSWORD}, null);
    assert.equal(response.status, 200, JSON.stringify(response.j));
    return asSession(response);
  };
  const setup = await post('/api/auth/setup', {storeCode: 'entry', storeName: 'Order entry test', username: 'entry_owner', name: 'Order entry owner', password: PASSWORD}, null);
  assert.equal(setup.status, 201, JSON.stringify(setup.j));
  admin = asSession(setup);
  const state = async (session = admin) => {
    const response = await request('/api/state', {session});
    assert.equal(response.status, 200, JSON.stringify(response.j));
    return response.j.data;
  };
  const act = (action, body = {}, session = admin) => post('/api/actions', {action, ...body}, session);
  const create = async (body = input(), session = admin) => {
    const response = await act('create-order', body, session);
    assert.equal(response.status, 200, JSON.stringify(response.j));
    assert.ok(response.j.result.orderId);
    return response.j.result.orderId;
  };
  const newStore = async (code = 'other') => {
    const response = await post('/api/stores', {storeCode: code, storeName: code + ' shop', username: 'entry_owner', name: code + ' owner', password: PASSWORD});
    assert.equal(response.status, 201, JSON.stringify(response.j));
    return login(code);
  };
  const editStoredState = (session, edit) => {
    const data = JSON.parse(app.db.prepare('SELECT data FROM tenant_state WHERE tenant_id=?').get(session.store.id).data);
    edit(data);
    app.db.prepare('UPDATE tenant_state SET data=? WHERE tenant_id=?').run(JSON.stringify(data), session.store.id);
  };
  return {request, post, login, state, act, create, newStore, editStoredState, get admin() { return admin; },
    restart: async () => { await stop(); await start(); admin = await login('entry'); }};
}

test('manual order validates recipient, complete shipping/billing addresses and monetary item input before any mutation', async t => {
  const f = await fixture(t), before = await f.state();
  const invalid = [
    ['missing customer', {...input(), customer: ''}],
    ['missing phone', {...input(), phone: ''}],
    ['invalid phone', {...input(), phone: 'not-a-phone'}],
    ['missing shipping address', {...input(), shippingAddress: undefined}],
    ...['addressLine', 'subdistrict', 'district', 'province', 'postalCode'].map(field => [`missing ${field}`, input({shippingAddress: address({[field]: ''})})]),
    ['postal code shorter than five digits', input({shippingAddress: address({postalCode: '1011'})})],
    ['postal code containing letters', input({shippingAddress: address({postalCode: 'A0110'})})],
    ['missing alternate billing address', input({billingSame: false})],
    ['incomplete alternate billing address', input({billingSame: false, billingAddress: address({district: ''})})],
    ['empty items', input({items: []})],
    ['unknown SKU', input({items: [{sku: 'UNKNOWN-SKU', qty: 1, price: 10, discount: 0}]})],
    ['zero quantity', input({items: [{sku: SKU_A, qty: 0, price: 10, discount: 0}]})],
    ['fractional quantity', input({items: [{sku: SKU_A, qty: 1.5, price: 10, discount: 0}]})],
    ['negative price', input({items: [{sku: SKU_A, qty: 1, price: -1, discount: 0}]})],
    ['negative line discount', input({items: [{sku: SKU_A, qty: 1, price: 10, discount: -1}]})],
    ['line discount greater than its entire gross', input({items: [{sku: SKU_A, qty: 2, price: 10, discount: 20.01}]})],
    ['negative shipping fee', input({shippingFee: -1})],
    ['negative order discount', input({discount: -1})],
    ['unknown payment method', input({payment: {method: 'automatic-bank-verification', status: 'pending', amount: 0}})],
    ['unknown payment status', input({payment: {method: 'transfer', status: 'verified-by-bank', amount: 265}})],
    ['negative payment amount', input({payment: {method: 'transfer', status: 'confirmed', amount: -1, paidAt: '2026-10-07T09:30:00+07:00'}})],
    ['payment greater than the order total', input({payment: {method: 'transfer', status: 'confirmed', amount: 300, paidAt: '2026-10-07T09:30:00+07:00'}})],
  ];
  for (const [label, body] of invalid) {
    const response = await f.act('create-order', body);
    assert.equal(response.status, 400, label + ': ' + JSON.stringify(response.j));
    assert.deepEqual(await f.state(), before, label + ' must not append orders, reserve inventory or write order history');
  }
  const oldShape = {channel: 'Offline sales', sku: SKU_A, qty: 1, customer: 'Legacy API recipient', province: 'กรุงเทพมหานคร'};
  assert.equal((await f.act('create-order', oldShape)).status, 400, 'old single-SKU shape does not bypass recipient requirements');
  const id = await f.create({...oldShape, phone: '0812345678', shippingAddress: address()});
  assert.equal(pick(await f.state(), id).items[0].sku, SKU_A, 'legacy SKU/quantity callers remain supported when address and phone are present');
});

test('multiple priced lines, full billing address and manually confirmed payment persist without rewriting existing orders', async t => {
  const f = await fixture(t), existing = (await f.state()).orders;
  const billingAddress = address({addressLine: '101 อาคารสำนักงาน', subdistrict: 'สีลม', district: 'บางรัก', postalCode: '10500'});
  const payment = {method: 'transfer', status: 'confirmed', amount: 265, paidAt: '2026-10-07T09:30:00+07:00', bankName: 'ธนาคารทดสอบ', reference: 'MANUAL-TEST-265'};
  const id = await f.create(input({billingSame: false, billingAddress, payment, requestId: randomUUID()}));
  const order = pick(await f.state(), id);
  assert.equal(order.customer, 'ผู้รับทดสอบหลายรายการ');
  assert.equal(order.phone, '0812345678');
  assert.deepEqual(order.shippingAddress, address());
  assert.deepEqual(order.billingAddress, billingAddress);
  assert.equal(order.billingSame, false);
  assert.equal(order.items.length, 2);
  assert.deepEqual(order.items.map(({sku, qty, price, discount}) => ({sku, qty, price, discount})), input().items);
  assert.equal(order.shippingFee, 20.75);
  assert.equal(order.discount, 5.11);
  assert.equal(order.subtotal, 260.47);
  assert.equal(order.lineDiscount, 11.11);
  assert.equal(order.itemNetTotal, 249.36);
  assert.equal(order.grandTotal, 265, 'line discounts apply once per whole line; order discount and shipping are applied once');
  for (const [field, expected] of Object.entries(payment)) {
    if (field === 'paidAt') assert.equal(Date.parse(order.payment.paidAt), Date.parse(expected));
    else assert.equal(order.payment[field], expected);
  }
  assert.equal(order.payment.verificationSource, 'manual', 'a manual confirmation does not claim bank verification');
  assert.ok(order.payment.confirmedBy);
  assert.ok(Number.isFinite(Date.parse(order.payment.confirmedAt)));
  assert.equal(order.reserved, false, 'a new paid manual order still needs explicit warehouse reservation');
  const rounded = await f.create(input({items: [{sku: SKU_A, qty: 3, price: 0.10, discount: 0}], shippingFee: 0.20, discount: 0}));
  assert.equal(pick(await f.state(), rounded).grandTotal, 0.50, 'THB totals do not retain floating-point artifacts');
  for (const method of ['cod', 'unpaid']) {
    const paymentOrder = await f.create(input({payment: {method, status: 'pending', amount: 0}}));
    assert.equal(pick(await f.state(), paymentOrder).payment.method, method);
  }
  const snapshot = await f.state();
  for (const legacyOrder of existing) assert.deepEqual(pick(snapshot, legacyOrder.id), legacyOrder);
  await f.restart();
  assert.deepEqual(pick(await f.state(), id), order, 'complete order entry survives restart');
  for (const legacyOrder of existing) assert.deepEqual(pick(await f.state(), legacyOrder.id), legacyOrder, 'legacy orders remain unchanged');
});

test('multiple products scan and dispatch atomically once, and cancellation releases every reservation', async t => {
  const f = await fixture(t), before = await f.state();
  const id = await f.create();
  assert.equal((await f.act('reserve', {id})).status, 200);
  const held = await f.state();
  for (const [sku, qty] of [[SKU_A, 2], [SKU_B, 3]]) {
    assert.equal(stock(held, sku), stock(before, sku));
    assert.equal(available(held, sku), available(before, sku) - qty);
  }
  assert.equal((await f.act('start-pack', {id})).status, 200);
  assert.equal((await f.act('scan', {id, sku: 'UNKNOWN-SKU'})).status, 400);
  assert.equal((await f.act('scan', {id, sku: SKU_A})).status, 200);
  assert.equal((await f.act('complete-pack', {id})).status, 400, 'one product scan cannot satisfy the other lines');
  assert.equal((await f.act('dispatch', {id})).status, 400);
  assert.equal((await f.act('scan', {id, sku: SKU_A})).status, 200);
  assert.equal((await f.act('scan', {id, sku: SKU_A})).status, 400, 'extra scans of one line are rejected');
  for (let count = 0; count < 3; count++) assert.equal((await f.act('scan', {id, sku: SKU_B})).status, 200);
  assert.equal((await f.act('complete-pack', {id})).status, 200);
  assert.equal((await f.act('dispatch', {id})).status, 200);
  const shipped = await f.state();
  assert.equal(pick(shipped, id).status, 'shipped');
  assert.equal(pick(shipped, id).reserved, false);
  for (const [sku, qty] of [[SKU_A, 2], [SKU_B, 3]]) {
    assert.equal(stock(shipped, sku), stock(before, sku) - qty);
    assert.equal(available(shipped, sku), available(before, sku) - qty, 'dispatch releases reserved quantity without a second available deduction');
  }
  assert.equal((await f.act('dispatch', {id})).status, 400);
  assert.equal((await f.act('cancel', {id})).status, 400);
  assert.deepEqual(await f.state(), shipped, 'duplicate dispatch/cancel does not alter stock or order history');
  const cancelId = await f.create();
  assert.equal((await f.act('reserve', {id: cancelId})).status, 200);
  assert.equal((await f.act('cancel', {id: cancelId})).status, 200);
  const cancelled = await f.state();
  assert.equal(pick(cancelled, cancelId).reserved, false);
  for (const sku of [SKU_A, SKU_B]) {
    assert.equal(stock(cancelled, sku), stock(shipped, sku));
    assert.equal(available(cancelled, sku), available(shipped, sku));
  }
  assert.equal((await f.act('cancel', {id: cancelId})).status, 400);
});

test('duplicate SKU demand cannot oversell, and a shortage of one product prevents all reservation and partial dispatch', async t => {
  const f = await fixture(t), shop = await f.newStore();
  assert.equal((await f.act('stock-receive', {sku: SKU_A, qty: 5}, shop)).status, 200);
  const duplicate = input({items: [{sku: SKU_A, qty: 3, price: 10, discount: 0}, {sku: SKU_A, qty: 3, price: 10, discount: 0}]});
  const duplicateResponse = await f.act('create-order', duplicate, shop);
  assert.ok([200, 400].includes(duplicateResponse.status), 'duplicate lines are either safely coalesced or rejected');
  if (duplicateResponse.status === 200) {
    const id = duplicateResponse.j.result.orderId;
    assert.equal((await f.act('reserve', {id}, shop)).status, 200);
    const data = await f.state(shop);
    assert.equal(pick(data, id).status, 'hold');
    assert.equal(pick(data, id).reserved, false);
  }
  assert.equal(available(await f.state(shop), SKU_A), 5);
  // A persisted legacy order may already contain duplicate lines, even when
  // newly submitted duplicates are rejected. Reservation must aggregate it.
  const legacyId = await f.create(input({items: [{sku: SKU_A, qty: 3, price: 10, discount: 0}]}), shop);
  f.editStoredState(shop, data => { pick(data, legacyId).items.push({...pick(data, legacyId).items[0]}); });
  assert.equal((await f.act('reserve', {id: legacyId}, shop)).status, 200);
  const aggregated = await f.state(shop);
  assert.equal(pick(aggregated, legacyId).status, 'hold', 'two demands of three must not reserve against five physical units');
  assert.equal(pick(aggregated, legacyId).reserved, false);
  assert.equal(reserved(aggregated, SKU_A), 0);
  assert.equal(available(aggregated, SKU_A), 5);

  const id = await f.create(input({items: [{sku: SKU_A, qty: 2, price: 10, discount: 0}, {sku: SKU_B, qty: 1, price: 20, discount: 0}]}), shop);
  assert.equal((await f.act('reserve', {id}, shop)).status, 200);
  let data = await f.state(shop);
  assert.equal(pick(data, id).status, 'hold');
  assert.equal(pick(data, id).reserved, false);
  assert.equal(reserved(data, SKU_A), 0, 'in-stock line is not partially reserved when another SKU is short');
  assert.equal(reserved(data, SKU_B), 0);
  assert.equal((await f.act('stock-receive', {sku: SKU_B, qty: 1}, shop)).status, 200);
  assert.equal((await f.act('resolve', {id, confirmed: true}, shop)).status, 200);
  assert.equal((await f.act('start-pack', {id}, shop)).status, 200);
  for (const sku of [SKU_A, SKU_A, SKU_B]) assert.equal((await f.act('scan', {id, sku}, shop)).status, 200);
  assert.equal((await f.act('complete-pack', {id}, shop)).status, 200);
  // Inject a late shortage into this disposable fixture to verify that a
  // failure on the second line cannot persist a deduction from the first.
  f.editStoredState(shop, stored => { stored.products.find(product => product.sku === SKU_B).stock = 0; });
  const beforeFailure = await f.state(shop);
  assert.equal((await f.act('dispatch', {id}, shop)).status, 400);
  assert.deepEqual(await f.state(shop), beforeFailure, 'failed multi-line dispatch rolls back every inventory/order/history change');
});

test('Review orders make every product free and reserve the same central inventory automatically', async t => {
  const f = await fixture(t), before = await f.state();
  const id = await f.create(input({channel: 'Review', shippingFee: 0, discount: 0, payment: {method: 'free', status: 'confirmed', amount: 0}}));
  const data = await f.state(), order = pick(data, id);
  assert.equal(order.status, 'ready');
  assert.equal(order.reserved, true);
  assert.ok(order.items.every(line => line.price === 0 && (line.discount ?? 0) === 0));
  assert.equal(order.grandTotal, 0);
  assert.equal(order.payment.amount, 0);
  for (const [sku, qty] of [[SKU_A, 2], [SKU_B, 3]]) {
    assert.equal(stock(data, sku), stock(before, sku));
    assert.equal(available(data, sku), available(before, sku) - qty);
    assert.equal(order.items.find(line => line.sku === sku).cost, before.products.find(product => product.sku === sku).cost);
  }
  assert.equal((await f.act('cancel', {id})).status, 200);
  for (const sku of [SKU_A, SKU_B]) assert.equal(available(await f.state(), sku), available(before, sku));
  const empty = await f.newStore('empty');
  const heldId = await f.create(input({channel: 'Review', shippingFee: 0, discount: 0, payment: {method: 'free', status: 'confirmed', amount: 0}}), empty);
  const held = await f.state(empty);
  assert.equal(pick(held, heldId).status, 'hold');
  assert.equal(pick(held, heldId).reserved, false);
  assert.ok(held.products.every(product => available(held, product.sku) === 0));
});

test('warehouse sees delivery details without any money fields; finance remains read-only and stores cannot access foreign recipients', async t => {
  const f = await fixture(t);
  const id = await f.create(input({payment: {method: 'transfer', status: 'confirmed', amount: 265, paidAt: '2026-10-07T09:30:00+07:00', bankName: 'Test Bank', reference: 'PRIVATE-MANUAL-PAYMENT'}}));
  for (const role of ['warehouse', 'finance']) {
    assert.equal((await f.post('/api/users', {username: role + '_entry', name: role + ' entry', role, password: PASSWORD})).status, 201);
  }
  const warehouse = await f.login('entry', 'warehouse_entry'), finance = await f.login('entry', 'finance_entry');
  const warehouseData = await f.state(warehouse), warehouseOrder = pick(warehouseData, id);
  assert.deepEqual(warehouseOrder.shippingAddress, address());
  assert.equal(warehouseOrder.phone, '0812345678');
  const prohibited = new Set(['price', 'cost', 'discount', 'refund', 'shippingFee', 'amount', 'total', 'grandTotal', 'subtotal', 'itemNetTotal', 'net', 'fee', 'payouts', 'expenses', 'sales', 'lineTotal', 'lineDiscount']);
  const checkNoMoney = (value, location = 'data') => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      assert.equal(prohibited.has(key), false, `warehouse payload exposes ${location}.${key}`);
      checkNoMoney(child, `${location}.${key}`);
    }
  };
  checkNoMoney(warehouseData);
  const financeOrder = pick(await f.state(finance), id);
  assert.equal(financeOrder.grandTotal, 265);
  assert.equal(financeOrder.payment.amount, 265);
  const before = await f.state();
  for (const [action, body] of [['create-order', input()], ['update-order', {id, ...input()}], ['reserve', {id}], ['stock-receive', {sku: SKU_A, qty: 100}]]) {
    assert.equal((await f.act(action, body, finance)).status, 403);
  }
  assert.equal((await f.act('update-order', {id, ...input()}, warehouse)).status, 403);
  assert.deepEqual(await f.state(), before);
  const other = await f.newStore();
  const otherAddress = address({addressLine: '888 FOREIGN-RECIPIENT-SECRET', subdistrict: 'สีลม', district: 'บางรัก', postalCode: '10500'});
  const otherId = await f.create(input({customer: 'Foreign private recipient', phone: '0899999999', shippingAddress: otherAddress}), other);
  const foreignSnapshot = await f.state(other);
  for (const session of [f.admin, warehouse, finance]) {
    const response = await f.request(`/api/state?storeId=${other.store.id}&orderId=${otherId}`, {session});
    assert.equal(response.status, 200);
    assert.ok(!response.j.data.orders.some(order => order.id === otherId));
    assert.ok(!JSON.stringify(response.j.data).includes('FOREIGN-RECIPIENT-SECRET'));
    assert.ok(!JSON.stringify(response.j.data).includes('0899999999'));
  }
  for (const action of ['reserve', 'start-pack', 'scan', 'complete-pack', 'dispatch', 'cancel', 'update-order']) {
    assert.equal((await f.act(action, {id: otherId, sku: SKU_A, storeId: other.store.id})).status, 404);
  }
  assert.deepEqual(await f.state(other), foreignSnapshot, 'foreign recipient requests do not alter the target store');
  assert.equal((await f.request('/api/state', {session: null})).status, 401);
});

test('edits before packing update recipient and all reservations atomically; shortages and packing preserve the previous order', async t => {
  const f = await fixture(t), shop = await f.newStore();
  for (const [sku, qty] of [[SKU_A, 8], [SKU_B, 6]]) assert.equal((await f.act('stock-receive', {sku, qty}, shop)).status, 200);
  const id = await f.create(input(), shop);
  const revised = input({customer: 'ผู้รับแก้ไขก่อนแพ็ก', phone: '0823456789', shippingAddress: address({addressLine: '123 ที่อยู่แก้ไข'})});
  assert.equal((await f.act('update-order', {id, ...revised}, shop)).status, 200);
  let data = await f.state(shop), order = pick(data, id);
  assert.equal(order.customer, revised.customer);
  assert.equal(order.phone, revised.phone);
  assert.deepEqual(order.shippingAddress, revised.shippingAddress);
  assert.equal(order.reserved, false);
  assert.equal(available(data, SKU_A), 8);
  assert.equal(available(data, SKU_B), 6);
  assert.equal((await f.act('reserve', {id}, shop)).status, 200);
  const readyEdit = input({customer: 'ผู้รับหลังกันสินค้า', shippingAddress: address({addressLine: '456 ที่อยู่หลังกันสินค้า'}),
    items: [{sku: SKU_A, qty: 3, price: 100, discount: 0}, {sku: SKU_B, qty: 4, price: 20, discount: 0}]});
  assert.equal((await f.act('update-order', {id, ...readyEdit}, shop)).status, 200);
  data = await f.state(shop); order = pick(data, id);
  assert.equal(order.status, 'ready');
  assert.equal(order.reserved, true);
  assert.equal(order.customer, readyEdit.customer);
  assert.deepEqual(order.shippingAddress, readyEdit.shippingAddress);
  assert.equal(available(data, SKU_A), 5, 'edit replaces the old reservation instead of adding a second reservation');
  assert.equal(available(data, SKU_B), 2);
  assert.equal(stock(data, SKU_A), 8);
  assert.equal(stock(data, SKU_B), 6);
  const shortage = await f.act('update-order', {id, ...readyEdit, items: [{sku: SKU_A, qty: 9, price: 100, discount: 0}, {sku: SKU_B, qty: 1, price: 20, discount: 0}]}, shop);
  assert.equal(shortage.status, 409, 'a larger edit cannot take more than the central stock');
  assert.deepEqual(await f.state(shop), data, 'failed edit retains address, prices, lines, old reservations, mirrors and history');

  const heldId = await f.create(input({items: [{sku: SKU_A, qty: 6, price: 100, discount: 0}]}), shop);
  assert.equal((await f.act('reserve', {id: heldId}, shop)).status, 200);
  assert.equal(pick(await f.state(shop), heldId).status, 'hold');
  const heldEdit = input({customer: 'ผู้รับแก้ไขออเดอร์พัก', shippingAddress: address({addressLine: '789 ที่อยู่รายการพัก'}), items: [{sku: SKU_A, qty: 2, price: 100, discount: 0}]});
  assert.equal((await f.act('update-order', {id: heldId, ...heldEdit}, shop)).status, 200);
  assert.equal(pick(await f.state(shop), heldId).customer, heldEdit.customer);
  assert.deepEqual(pick(await f.state(shop), heldId).shippingAddress, heldEdit.shippingAddress);
  assert.equal((await f.act('start-pack', {id}, shop)).status, 200);
  const packing = await f.state(shop);
  const rejected = await f.act('update-order', {id, ...input({customer: 'Must not replace packing order'})}, shop);
  assert.ok([400, 409].includes(rejected.status));
  assert.deepEqual(await f.state(shop), packing, 'editing after packing starts cannot change the prepared shipment');
});

test('marketplace edits preserve the original source and reject reclassification before changing reservations', async t => {
  const f = await fixture(t);
  for (const channel of ['Shopee', 'Lazada', 'TikTok Shop']) {
    const before = await f.state();
    const original = before.orders.find(order => order.channel === channel && order.status === 'ready');
    assert.ok(original, channel + ' fixture includes a reserved order');
    const revised = input({channel, customer: 'ผู้รับแก้ไข ' + channel});
    assert.equal((await f.act('update-order', {id: original.id, ...revised})).status, 200);
    const after = await f.state(), order = pick(after, original.id);
    assert.equal(order.channel, channel, 'editing a marketplace order retains its source');
    assert.equal(order.external, original.external, 'external identity remains attached to the original source');
    assert.equal(order.customer, revised.customer);
    assert.equal(order.reserved, true);
    assert.equal(order.status, 'ready');
    for (const sku of [SKU_A, SKU_B]) {
      const oldQty = original.items.filter(line => line.sku === sku).reduce((total, line) => total + line.qty, 0);
      const newQty = revised.items.find(line => line.sku === sku).qty;
      assert.equal(stock(after, sku), stock(before, sku));
      assert.equal(available(after, sku), available(before, sku) + oldQty - newQty);
    }
    for (const replacement of ['Facebook', 'Review', ...['Shopee', 'Lazada', 'TikTok Shop'].filter(name => name !== channel)]) {
      assert.equal((await f.act('update-order', {id: original.id, ...revised, channel: replacement})).status, 400);
      assert.deepEqual(await f.state(), after, 'channel tampering cannot rewrite the order, reservations, mirrors or history');
    }
    assert.equal((await f.act('create-order', input({channel}))).status, 400, 'marketplace orders cannot be created through the manual form');
    assert.deepEqual(await f.state(), after);
  }
  const manualId = await f.create();
  const beforeManualEdit = await f.state();
  assert.equal((await f.act('update-order', {id: manualId, ...input({channel: 'Shopee'})})).status, 400);
  assert.deepEqual(await f.state(), beforeManualEdit, 'a manual order cannot be reclassified as a marketplace order');
});
