import test from 'node:test';
import assert from 'node:assert/strict';
import {bangkokDate, cancelShipmentRequest, closePendingShipment, createShipmentRequest, DIRECT_CARRIERS, projectShipment, shippingReadiness} from '../server/shipping.mjs';

const now = Date.parse('2026-10-08T03:00:00Z');
const actor = {id: 'fixture-admin', name: 'ผู้ดูแลสาธิต', role: 'admin', store_code: 'fixture-shop'};
const sender = {name: 'คลังสาธิต', phone: '0812345678', addressLine: '123 ถนนสาธิต', subdistrict: 'ปทุมวัน', district: 'ปทุมวัน', province: 'กรุงเทพมหานคร', postalCode: '10330'};
function state(channel = 'Offline sales') {
  return {
    products: [{sku: 'SKU-A', stock: 12, price: 500, cost: 200}, {sku: 'SKU-B', stock: 7, price: 200, cost: 80}],
    orders: [{id: 'ORDER-PRIVATE-1', external: 'PLATFORM-FIXTURE-1', channel, status: 'packed', reserved: true, customer: 'ผู้รับสาธิต', phone: '0898765432', shippingAddress: {addressLine: '456 ถนนสาธิต', subdistrict: 'สุเทพ', district: 'เมืองเชียงใหม่', province: 'เชียงใหม่', postalCode: '50200'}, carrier: 'Flash Express', items: [{sku: 'SKU-A', qty: 2, price: 500, cost: 200}, {sku: 'SKU-B', qty: 1, price: 200, cost: 80}], tracking: '', payment: {method: 'cod', amount: 1200}, grandTotal: 1200, scanned: {'SKU-A': 2, 'SKU-B': 1}}],
    audit: [], stockRevision: 2, lastStock: {'SKU-A': 10, 'SKU-B': 6}, publishedStock: {Shopee: {qty: {'SKU-A': 10, 'SKU-B': 6}, revision: 2}}, stockEvents: [],
    connections: {Shopee: {connected: true, live: true, token: 'fixture-untrusted-draft-value'}}
  };
}
function input(overrides = {}) {
  return {id: 'ORDER-PRIVATE-1', method: 'pickup', pickupDate: '2026-10-09', pickupTimeFrom: '09:00', pickupTimeTo: '12:00', package: {weightGrams: 500, lengthCm: 20, widthCm: 15, heightCm: 10}, sender: structuredClone(sender), notes: 'ตัวอย่างข้อมูลเตรียมเรียกรับ', ...overrides};
}
function expectFault(operation, status) {
  assert.throws(operation, error => error.status === status);
}
function unchangedOnFailure(data, details, status = 400, selectedActor = actor) {
  const before = structuredClone(data);
  expectFault(() => createShipmentRequest(data, details, selectedActor, {now}), status);
  assert.deepEqual(data, before, 'a rejected shipping preparation cannot partially mutate any store state');
}

test('shipping preparation derives recipient and SKU quantities while preserving packed reservations and all inventory mirrors', () => {
  const data = state(), before = structuredClone(data);
  const result = createShipmentRequest(data, input({carrier: 'J&T Express'}), actor, {now});
  const shipment = data.orders[0].shipment;
  assert.equal(result.status, 'awaiting_connection');
  assert.equal(result.readiness.ready, false);
  assert.equal(result.readiness.connectionRequired, 'carrier');
  assert.equal(result.shipmentId, shipment.id);
  assert.match(shipment.id, /^SHIP-[\da-f-]{36}$/u);
  assert.equal(shipment.provider, 'J&T Express');
  assert.equal(shipment.carrier, 'J&T Express');
  assert.equal(data.orders[0].carrier, 'Flash Express', 'a draft carrier selection cannot change the actual order carrier');
  assert.deepEqual(shipment.recipient, {name: before.orders[0].customer, phone: before.orders[0].phone, ...before.orders[0].shippingAddress});
  assert.deepEqual(shipment.items, [{sku: 'SKU-A', qty: 2}, {sku: 'SKU-B', qty: 1}]);
  assert.equal(Object.hasOwn(shipment.items[0], 'price'), false);
  assert.equal(Object.hasOwn(shipment.items[0], 'cost'), false);
  assert.equal(Object.hasOwn(shipment, 'payment'), false);
  assert.equal(Object.hasOwn(shipment, 'tracking'), false);
  assert.equal(shipment.createdAt, new Date(now).toISOString());
  assert.equal(shipment.createdBy, actor.name);
  assert.match(result.message, /ยังไม่ได้เรียกรถ/u);
  assert.equal(data.audit.length, 1);
  delete data.orders[0].shipment; data.audit = [];
  assert.deepEqual(data, before, 'only shipment metadata and its audit entry may change');
});

test('equal normalized retries keep one shipment ID and one audit event; changed draft requires explicit cancellation', () => {
  const data = state(), first = createShipmentRequest(data, input(), actor, {now});
  const before = structuredClone(data);
  const second = createShipmentRequest(data, input({sender: {...sender, phone: '๐๘๑-๒๓๔-๕๖๗๘'}}), actor, {now: now + 3600000});
  assert.equal(second.shipmentId, first.shipmentId);
  assert.deepEqual(data, before);
  unchangedOnFailure(data, input({package: {weightGrams: 501, lengthCm: 20, widthCm: 15, heightCm: 10}}), 409);
  unchangedOnFailure(data, input({carrier: 'KEX'}), 409);
});

test('shipping readiness separates marketplace shipping from direct courier shipping and rejects all forged connection flags', () => {
  for (const channel of ['TikTok Shop', 'Shopee', 'Lazada']) {
    const data = state(channel);
    const result = createShipmentRequest(data, input(), actor, {now});
    assert.equal(result.readiness.ready, false, 'untrusted saved connection draft cannot authorize live API');
    assert.equal(result.readiness.provider, channel);
    assert.equal(result.readiness.connectionRequired, 'platform');
    assert.equal(data.orders[0].shipment.sourceOrderExternal, data.orders[0].external);
    assert.equal(data.orders[0].shipment.carrier, 'Flash Express');
    assert.ok(result.readiness.officialLinks.length >= 1);
    unchangedOnFailure(state(channel), input({carrier: 'KEX'}));
  }
  for (const channel of ['Facebook', 'LINE OA', 'Review', 'Offline sales']) for (const carrier of DIRECT_CARRIERS) {
    const result = createShipmentRequest(state(channel), input({carrier}), actor, {now});
    assert.equal(result.readiness.provider, carrier);
    assert.equal(result.readiness.connectionRequired, 'carrier');
    assert.equal(result.readiness.ready, false);
    assert.equal(result.readiness.status, 'not_connected');
  }
  for (const forged of [{provider: 'Shopee'}, {shopId: 'another-shop'}, {tenantId: 'other'}, {status: 'requested'}, {tracking: 'REAL123'}, {token: 'fixture'}, {live: true}, {connected: true}, {recipient: sender}, {items: [{sku: 'SKU-A', qty: 99}]}]) unchangedOnFailure(state(), input(forged));
  unchangedOnFailure(state(), input({package: {...input().package, price: 500}}));
  unchangedOnFailure(state(), input({sender: {...sender, token: 'fixture'}}));
  unchangedOnFailure(state(), input({carrier: 'Arbitrary guessed provider'}));
});

test('only authorized packed reserved orders can prepare shipping and cross-store order IDs do not select data', () => {
  for (const status of ['new', 'ready', 'packing', 'hold', 'cancelled', 'shipped', 'delivered']) {
    const data = state(); data.orders[0].status = status;
    unchangedOnFailure(data, input(), 409);
  }
  const unreserved = state(); unreserved.orders[0].reserved = false;
  unchangedOnFailure(unreserved, input(), 409);
  unchangedOnFailure(state(), input({id: 'OTHER-STORE-ORDER'}), 404);
  unchangedOnFailure(state(), input(), 403, {...actor, role: 'finance'});
  unchangedOnFailure(state(), input(), 403, null);
  assert.equal(createShipmentRequest(state(), input(), {...actor, role: 'warehouse'}, {now}).status, 'awaiting_connection');
});

test('complete sender and existing order recipient are required, and invalid contacts never mutate data', () => {
  for (const [field, bad] of [['name', ''], ['phone', 'abc'], ['phone', '123'], ['addressLine', ''], ['subdistrict', ''], ['district', ''], ['province', ''], ['postalCode', '1234'], ['postalCode', '123456']]) unchangedOnFailure(state(), input({sender: {...sender, [field]: bad}}));
  unchangedOnFailure(state(), input({sender: null}));
  const legacy = state(); delete legacy.orders[0].shippingAddress; delete legacy.orders[0].phone;
  unchangedOnFailure(legacy, input());
  const missingSku = state(); missingSku.orders[0].items[0].sku = 'DELETED-SKU';
  unchangedOnFailure(missingSku, input());
  const missingExternal = state('Shopee'); missingExternal.orders[0].external = '';
  unchangedOnFailure(missingExternal, input());
  const duplicate = state(); duplicate.orders[0].items.push({sku: 'SKU-A', qty: 1, price: 500, cost: 200});
  createShipmentRequest(duplicate, input(), actor, {now});
  assert.deepEqual(duplicate.orders[0].shipment.items, [{sku: 'SKU-A', qty: 3}, {sku: 'SKU-B', qty: 1}]);
});

test('pickup dates use Bangkok calendar bounds, including UTC date crossings and invalid calendar dates', () => {
  const midnight = Date.parse('2026-10-07T17:01:00Z');
  assert.equal(bangkokDate(midnight), '2026-10-08');
  for (const date of ['2026-10-08', '2026-10-22']) assert.equal(createShipmentRequest(state(), input({pickupDate: date}), actor, {now: midnight}).status, 'awaiting_connection');
  for (const date of ['2026-10-07', '2026-10-23', '2026-02-30', '2026-13-01', '2026-1-01', '2026-10-08T10:00:00+07:00', 'not-a-date']) unchangedOnFailure(state(), input({pickupDate: date}));
  const leap = Date.parse('2028-02-28T18:00:00Z');
  assert.equal(createShipmentRequest(state(), input({pickupDate: '2028-02-29'}), actor, {now: leap}).status, 'awaiting_connection');
});

test('pickup time preferences require valid paired times; dropoff does not accept pickup schedule', () => {
  for (const times of [{pickupTimeFrom: '09:00', pickupTimeTo: ''}, {pickupTimeFrom: '', pickupTimeTo: '12:00'}, {pickupTimeFrom: '12:00', pickupTimeTo: '09:00'}, {pickupTimeFrom: '09:00', pickupTimeTo: '09:00'}, {pickupTimeFrom: '24:00', pickupTimeTo: '25:00'}, {pickupTimeFrom: '9:00', pickupTimeTo: '12:00'}]) unchangedOnFailure(state(), input(times));
  const data = state();
  createShipmentRequest(data, input({pickupTimeFrom: '', pickupTimeTo: ''}), actor, {now});
  assert.equal(data.orders[0].shipment.pickupTimeFrom, '');
  const dropoff = state();
  createShipmentRequest(dropoff, input({method: 'dropoff', pickupDate: '', pickupTimeFrom: '', pickupTimeTo: ''}), actor, {now});
  assert.equal(dropoff.orders[0].shipment.method, 'dropoff');
  assert.equal(dropoff.orders[0].shipment.pickupDate, '');
  unchangedOnFailure(state(), input({method: 'dropoff'}));
  unchangedOnFailure(state(), input({method: 'other'}));
});

test('parcel values and control characters are validated before any audit or shipping state is added', () => {
  for (const parcel of [null, {}, {...input().package, weightGrams: 0}, {...input().package, weightGrams: 100001}, {...input().package, weightGrams: 0.5}, {...input().package, weightGrams: '500'}, {...input().package, lengthCm: 0}, {...input().package, widthCm: -1}, {...input().package, heightCm: 301}, {...input().package, heightCm: Infinity}, {...input().package, heightCm: '10'}]) unchangedOnFailure(state(), input({package: parcel}));
  unchangedOnFailure(state(), input({notes: '\u0000bad'}));
  unchangedOnFailure(state(), input({notes: 'x'.repeat(501)}));
  unchangedOnFailure(state(), input({sender: {...sender, name: {arbitrary: 'object'}}}));
  assert.equal(createShipmentRequest(state(), input({package: {weightGrams: 1, lengthCm: 0.1, widthCm: 300, heightCm: 300}}), actor, {now}).status, 'awaiting_connection');
});

test('cancelling a preparation is idempotent, releases no stock and allows a new draft identity', () => {
  const data = state(), created = createShipmentRequest(data, input(), actor, {now});
  const before = structuredClone(data);
  const cancelled = cancelShipmentRequest(data, {id: data.orders[0].id}, actor, {now: now + 1000});
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.shipmentId, created.shipmentId);
  assert.equal(data.orders[0].shipment.cancelledBy, actor.name);
  assert.equal(data.orders[0].status, 'packed');
  assert.equal(data.orders[0].reserved, true);
  assert.equal(data.orders[0].tracking, '');
  assert.deepEqual(data.products, before.products);
  assert.deepEqual(data.publishedStock, before.publishedStock);
  assert.equal(data.audit.length, 2);
  const snapshot = structuredClone(data);
  cancelShipmentRequest(data, {id: data.orders[0].id}, actor, {now: now + 2000});
  assert.deepEqual(data, snapshot);
  const replacement = createShipmentRequest(data, input({carrier: 'KEX'}), actor, {now: now + 3000});
  assert.notEqual(replacement.shipmentId, created.shipmentId);
  assert.equal(replacement.status, 'awaiting_connection');
  const shipped = state(); shipped.orders[0].status = 'shipped';
  expectFault(() => cancelShipmentRequest(shipped, {id: shipped.orders[0].id}, actor, {now}), 409);
  const realRequested = state(); realRequested.orders[0].shipment = {id: 'not-a-draft', status: 'requested'};
  unchangedOnFailure(realRequested, input(), 409);
  expectFault(() => cancelShipmentRequest(realRequested, {id: realRequested.orders[0].id}, actor, {now}), 409);
  expectFault(() => cancelShipmentRequest(state(), {id: 'ORDER-PRIVATE-1'}, actor, {now}), 409);
});

test('readiness metadata is fresh and cannot be changed into a live provider connection by a caller', () => {
  const first = shippingReadiness('Shopee', 'Flash Express');
  first.ready = true;
  first.officialLinks[0].url = 'https://fixture.invalid/';
  first.requirements.length = 0;
  const second = shippingReadiness('Shopee', 'Flash Express');
  assert.equal(second.ready, false);
  assert.equal(second.officialLinks[0].url, 'https://open.shopee.com/');
  assert.ok(second.requirements.length > 0);
  expectFault(() => shippingReadiness('Unrecognized platform'), 400);
});

test('shipment API projection retains operational fields while dropping nested financial and provider secrets', () => {
  const data = state('Shopee');
  createShipmentRequest(data, input(), actor, {now});
  const draft = data.orders[0].shipment;
  Object.assign(draft, {price: 500, cost: 200, payment: {amount: 1200}, token: 'fixture-secret', providerPayload: {authorization: 'fixture-secret'}, readiness: {ready: true, token: 'fixture-secret', officialLinks: [{label: 'forged', url: 'https://fixture.invalid/?token=fixture-secret'}]}});
  Object.assign(draft.sender, {price: 500, token: 'fixture-secret'});
  Object.assign(draft.recipient, {cost: 200, payment: {amount: 1200}});
  Object.assign(draft.package, {price: 500, carrierResponse: {token: 'fixture-secret'}});
  Object.assign(draft.items[0], {price: 500, cost: 200, discount: 1, providerPayload: {token: 'fixture-secret'}});
  const projected = projectShipment(draft), serialized = JSON.stringify(projected);
  assert.equal(projected.id, draft.id);
  assert.equal(projected.sender.phone, draft.sender.phone);
  assert.equal(projected.package.weightGrams, 500);
  assert.deepEqual(projected.items, [{sku: 'SKU-A', qty: 2}, {sku: 'SKU-B', qty: 1}]);
  assert.equal(projected.readiness.ready, false);
  assert.equal(projected.readiness.officialLinks[0].url, 'https://open.shopee.com/');
  for (const forbidden of ['fixture-secret', 'price', 'cost', 'payment', 'providerPayload', 'carrierResponse', 'discount']) assert.equal(serialized.includes(forbidden), false);
  assert.equal(projectShipment(null), null);
  assert.deepEqual(projectShipment({sender: {name: {token: 'fixture-secret'}}, items: [{sku: {token: 'fixture-secret'}, qty: 1}]}), {sender: {}, items: []});
});

test('closing a parent order disables pending drafts without inventing external cancellation or changing stock', () => {
  const data = state();
  createShipmentRequest(data, input(), actor, {now});
  const before = structuredClone(data);
  assert.equal(closePendingShipment(data.orders[0], 'order_cancelled', {now: now + 1000}), true);
  const shipment = data.orders[0].shipment;
  assert.equal(shipment.status, 'cancelled');
  assert.equal(shipment.cancelledBy, 'system');
  assert.equal(shipment.cancellationReason, 'order_cancelled');
  assert.equal(shipment.cancelledAt, new Date(now + 1000).toISOString());
  const snapshot = structuredClone(data);
  assert.equal(closePendingShipment(data.orders[0], 'demo_dispatched', {now: now + 2000}), false);
  assert.deepEqual(data, snapshot);
  delete data.orders[0].shipment; delete before.orders[0].shipment;
  assert.deepEqual(data, before, 'parent closure only changes pending shipment metadata');
  assert.equal(closePendingShipment({}, 'order_cancelled', {now}), false);
});
