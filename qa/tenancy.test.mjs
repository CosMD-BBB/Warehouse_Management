import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash, randomUUID, scryptSync} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {createApp} from '../server/index.mjs';
import {available, createSeed, projectData} from '../server/model.mjs';

const PASSWORD = 'Tenant-test-password-001';
const OTHER_PASSWORD = 'Tenant-other-password-002';
const SKU = 'CLN-100';
const credentials = (storeCode, extra = {}) => ({storeCode, username: 'shared_owner', password: PASSWORD, ...extra});
const account = (storeCode, storeName, extra = {}) => ({...credentials(storeCode), storeName, name: `${storeName} owner`, ...extra});
const digest = value => createHash('sha256').update(value).digest('hex');
const sessionOf = response => ({cookie: response.cookie, csrf: response.j.csrf, user: response.j.user, store: response.j.store});

async function fixture(t, prepare) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'order-hub-tenancy-'));
  const dbPath = path.join(dir, 'fixture.sqlite');
  let app, origin;
  const stop = async () => {
    if (!app) return;
    const current = app;
    app = null;
    await new Promise((resolve, reject) => current.server.close(error => error ? reject(error) : resolve()));
  };
  t.after(async () => {
    try { await stop(); } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  });
  if (prepare) await prepare(dbPath);
  const start = async () => {
    app = createApp({dbPath});
    await new Promise((resolve, reject) => {
      app.server.once('error', reject);
      app.server.listen(0, '127.0.0.1', resolve);
    });
    origin = `http://127.0.0.1:${app.server.address().port}`;
  };
  await start();
  const request = async (route, {method = 'GET', body, session, headers: extraHeaders = {}} = {}) => {
    const headers = {...extraHeaders};
    if (session?.cookie) headers.Cookie = session.cookie;
    if (method !== 'GET') {
      headers.Origin = origin;
      headers['Content-Type'] = 'application/json';
      if (session?.csrf) headers['X-CSRF-Token'] = session.csrf;
    }
    const response = await fetch(origin + route, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {status: response.status, j: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0]};
  };
  const post = (route, body, session) => request(route, {method: 'POST', body, session});
  const patch = (route, body, session) => request(route, {method: 'PATCH', body, session});
  const state = async session => {
    const response = await request('/api/state', {session});
    assert.equal(response.status, 200, JSON.stringify(response.j));
    return response.j.data;
  };
  const action = (session, action, input = {}) => post('/api/actions', {action, ...input}, session);
  const login = async input => {
    const response = await post('/api/auth/login', input);
    assert.equal(response.status, 200, JSON.stringify(response.j));
    return sessionOf(response);
  };
  const pair = async () => {
    const setup = await post('/api/auth/setup', account('alpha', 'Alpha shop'));
    assert.equal(setup.status, 201, JSON.stringify(setup.j));
    const alpha = sessionOf(setup);
    assert.ok(alpha.store?.id, 'setup returns its store context');
    assert.equal(alpha.user.storeId, alpha.store.id);
    const created = await post('/api/stores', account('beta', 'Beta shop'), alpha);
    assert.equal(created.status, 201, JSON.stringify(created.j));
    const beta = await login(credentials('beta'));
    return {alpha, beta, created};
  };
  const makeOrder = async (session, customer, extra = {}) => {
    const response = await action(session, 'create-order', {
      channel: 'Offline sales', sku: SKU, qty: 1, customer, province: 'กรุงเทพมหานคร', phone: '0812345678', shippingAddress:{addressLine:'123 ถนนทดสอบ',subdistrict:'ปทุมวัน',district:'ปทุมวัน',province:'กรุงเทพมหานคร',postalCode:'10330'}, ...extra,
    });
    assert.equal(response.status, 200, JSON.stringify(response.j));
    assert.ok(response.j.result.orderId);
    return response.j.result.orderId;
  };
  return {request, post, patch, state, action, login, pair, makeOrder, restart: async () => { await stop(); await start(); }, get db() { return app.db; }, get server() { return app.server; }};
}

test('store context separates identical usernames and passwords and permits legacy login only for one store', async t => {
  const f = await fixture(t);
  const setup = await f.post('/api/auth/setup', account('alpha', 'Alpha shop'));
  assert.equal(setup.status, 201);
  const alpha = sessionOf(setup);
  assert.equal(alpha.store.name, 'Alpha shop');
  assert.equal(alpha.store.code, 'alpha');
  assert.match(alpha.store.code, /^[a-z0-9-]+$/, 'public store code is URL-friendly');
  assert.equal(alpha.user.storeId, alpha.store.id);
  const legacyLogin = await f.login(credentials(undefined));
  assert.equal(legacyLogin.store.id, alpha.store.id, 'single-store login remains backward compatible');

  const created = await f.post('/api/stores', account('beta', 'Beta shop'), alpha);
  assert.equal(created.status, 201);
  const beta = await f.login(credentials('beta'));
  assert.equal(created.j.store.id, beta.store.id);
  assert.equal(beta.store.code, 'beta');
  assert.notEqual(alpha.store.id, beta.store.id);
  assert.notEqual(alpha.user.id, beta.user.id, 'matching names are distinct accounts');
  assert.equal(beta.user.username, alpha.user.username);
  assert.equal(beta.user.storeId, beta.store.id);
  const current = await f.request('/api/auth/status', {session: alpha});
  assert.equal(current.j.store.id, alpha.store.id, 'creating a store does not switch the owner session');
  assert.equal(current.j.user.id, alpha.user.id);
  assert.equal((await f.request('/api/auth/status', {session: beta})).j.store.id, beta.store.id);
  assert.equal((await f.post('/api/stores', account('beta', 'Duplicate shop'), alpha)).status, 409);
  assert.equal((await f.post('/api/stores', account('contains spaces!', 'Invalid shop code'), alpha)).status, 400);

  const missingCode = await f.post('/api/auth/login', credentials(undefined));
  assert.ok([400, 401].includes(missingCode.status), 'multiple stores require an explicit code');
  const failures = await Promise.all([
    f.post('/api/auth/login', credentials('does-not-exist')),
    f.post('/api/auth/login', credentials('beta', {password: 'Incorrect-password-001'})),
    f.post('/api/auth/login', credentials('beta', {username: 'unknown_owner'})),
  ]);
  for (const response of failures) {
    assert.equal(response.status, 401);
    assert.deepEqual(Object.keys(response.j), ['error'], 'failed authentication exposes no account/store context');
  }
  assert.deepEqual(failures[0].j, failures[1].j, 'unknown store has the same generic failure as wrong password');
  assert.deepEqual(failures[1].j, failures[2].j, 'unknown username has the same generic failure');
  const newStore = await f.state(beta);
  for (const key of ['orders', 'payouts', 'expenses', 'audit', 'stockEvents']) {
    assert.deepEqual(newStore[key], [], `new store has no inherited ${key}`);
  }
  assert.ok(newStore.products.length > 0, 'new store retains an editable sample product catalog');
  assert.ok(newStore.products.every(product => product.stock === 0), 'new store starts with no physical inventory');
  for (const mirror of Object.values(newStore.publishedStock)) {
    assert.ok(Object.values(mirror.qty).every(qty => qty === 0), 'new store mirrors start at zero');
  }
  assert.deepEqual((await f.request('/api/connections', {session: beta})).j.drafts, []);
});

test('store management and user administration cannot address a different store', async t => {
  const f = await fixture(t), {alpha, beta} = await f.pair();
  const betaBefore = (await f.request('/api/store', {session: beta})).j.store;
  let response = await f.patch('/api/store', {name: 'Alpha renamed', storeId: beta.store.id, storeCode: 'beta'}, alpha);
  assert.ok([200, 400, 403].includes(response.status));
  assert.deepEqual((await f.request('/api/store', {session: beta})).j.store, betaBefore);
  if (response.status === 200) assert.equal((await f.request('/api/store', {session: alpha})).j.store.name, 'Alpha renamed');

  for (const session of [alpha, beta]) {
    response = await f.post('/api/users', {username: 'same_worker', name: `${session.store.code} worker`, password: OTHER_PASSWORD, role: 'warehouse'}, session);
    assert.equal(response.status, 201, 'same username can exist in separate stores');
  }
  const list = async session => (await f.request('/api/users', {session})).j.users;
  const alphaUsers = await list(alpha), betaUsers = await list(beta);
  assert.equal(alphaUsers.length, 2);
  assert.equal(betaUsers.length, 2);
  assert.ok(alphaUsers.every(user => !betaUsers.some(other => other.id === user.id)));
  const betaWorker = betaUsers.find(user => user.username === 'same_worker');
  response = await f.patch('/api/users/' + betaWorker.id, {active: false, role: 'finance', storeId: beta.store.id}, alpha);
  assert.equal(response.status, 404, 'foreign user ID cannot be modified');
  assert.deepEqual(await list(beta), betaUsers);
  response = await f.patch('/api/users/' + alpha.user.id, {active: false}, alpha);
  assert.equal(response.status, 409, 'another store admin cannot satisfy this store last-admin guard');
  response = await f.patch('/api/users/' + beta.user.id, {role: 'warehouse'}, beta);
  assert.equal(response.status, 409);

  const forged = await f.post('/api/users', {
    username: 'forged_worker', name: 'Forged target', password: OTHER_PASSWORD, role: 'warehouse', storeId: beta.store.id, storeCode: 'beta',
  }, alpha);
  assert.ok([201, 400, 403].includes(forged.status));
  assert.deepEqual(await list(beta), betaUsers, 'forged store fields never inject a user into the target store');
  if (forged.status === 201) assert.ok((await list(alpha)).some(user => user.username === 'forged_worker'));
  response = await f.post('/api/users', {username: 'same_worker', name: 'Duplicate', password: OTHER_PASSWORD, role: 'warehouse'}, alpha);
  assert.equal(response.status, 409, 'username remains unique inside a store');

  const worker = await f.login(credentials('beta', {username: 'same_worker', password: OTHER_PASSWORD}));
  for (const [route, method, body] of [
    ['/api/stores', 'POST', account('gamma', 'Gamma shop')],
    ['/api/store', 'PATCH', {name: 'Forbidden rename'}],
    ['/api/users', 'GET', undefined],
  ]) {
    response = await f.request(route, {method, body, session: worker});
    assert.equal(response.status, 403, `warehouse account cannot ${method} ${route}`);
  }
  assert.equal((await f.request('/api/auth/status', {session: alpha})).j.user.id, alpha.user.id);
});

test('tenant selection comes from the session, including action, connection and order object references', async t => {
  const f = await fixture(t), {alpha, beta} = await f.pair();
  const betaStart = await f.state(beta);
  const alphaStart = await f.state(alpha);
  const query = await f.request(`/api/state?storeId=${beta.store.id}&storeCode=beta`, {session: alpha});
  assert.equal(query.status, 200);
  assert.equal(query.j.user.storeId, alpha.store.id);
  assert.deepEqual(query.j.data, await f.state(alpha));
  const received = await f.action(alpha, 'stock-receive', {sku: SKU, qty: 3, storeId: beta.store.id, storeCode: 'beta'});
  assert.ok([200, 400, 403].includes(received.status));
  assert.deepEqual(await f.state(beta), betaStart, 'forged action selector has no foreign state or history effects');
  if (received.status === 200) {
    assert.equal((await f.state(alpha)).products.find(product => product.sku === SKU).stock,
      alphaStart.products.find(product => product.sku === SKU).stock + 3, 'accepted receipt modifies only the session store');
  }

  for (const session of [alpha, beta]) {
    const response = await f.post('/api/connections', {
      channel: 'Shopee', storeName: `${session.store.code} marketplace`, storeUrl: `https://shopee.co.th/${session.store.code}`,
    }, session);
    assert.equal(response.status, 200);
    assert.equal(response.j.live, false);
  }
  const connections = async session => (await f.request('/api/connections', {session})).j;
  const betaConnections = await connections(beta);
  assert.equal(betaConnections.drafts[0].storeName, 'beta marketplace');
  assert.equal((await connections(alpha)).drafts[0].storeName, 'alpha marketplace');
  const forgedDraft = await f.post('/api/connections', {
    channel: 'Shopee', storeName: 'Forged marketplace target', storeUrl: 'https://shopee.co.th/alpha',
    storeId: beta.store.id, storeCode: 'beta', tenant_id: beta.store.id,
  }, alpha);
  assert.ok([200, 400, 403].includes(forgedDraft.status));
  assert.deepEqual(await connections(beta), betaConnections);

  assert.equal((await f.action(beta, 'stock-receive', {sku: SKU, qty: 5})).status, 200);
  const betaOrder = await f.makeOrder(beta, 'Beta recipient');
  assert.equal((await f.action(beta, 'reserve', {id: betaOrder})).status, 200);
  assert.equal((await f.action(beta, 'start-pack', {id: betaOrder})).status, 200);
  const betaProtected = await f.state(beta);
  for (const action of ['reserve', 'start-pack', 'scan', 'complete-pack', 'dispatch', 'cancel', 'resolve']) {
    const response = await f.action(alpha, action, {id: betaOrder, sku: SKU, confirmed: true, storeId: beta.store.id});
    assert.ok([400, 403, 404].includes(response.status), `${action} rejects an order outside the session store`);
    assert.notEqual(response.status, 500);
  }
  assert.deepEqual(await f.state(beta), betaProtected, 'foreign order attempts leave stock, scans and audit unchanged');
  for (const action of ['fail-stock', 'retry-stock', 'simulate-order']) {
    assert.equal((await f.action(alpha, action)).status, 200);
    assert.deepEqual(await f.state(beta), betaProtected, `${action} stays in the caller store`);
  }
  const alphaData = await f.state(alpha);
  assert.ok(!alphaData.orders.some(order => order.id === betaOrder));
  assert.ok(!alphaData.audit.some(entry => entry.orderId === betaOrder));
});

test('inventory, provider events and idempotency remain independent under concurrent requests', async t => {
  const f = await fixture(t), {alpha, beta} = await f.pair();
  const stock = data => data.products.find(product => product.sku === SKU).stock;
  const alphaStart = await f.state(alpha), betaStart = await f.state(beta);
  const requestId = randomUUID();
  const received = await Promise.all([
    f.action(alpha, 'stock-receive', {sku: SKU, qty: 4, requestId}),
    f.action(beta, 'stock-receive', {sku: SKU, qty: 7, requestId}),
    f.action(alpha, 'stock-receive', {sku: SKU, qty: 4, requestId}),
    f.action(beta, 'stock-receive', {sku: SKU, qty: 7, requestId}),
  ]);
  assert.ok(received.every(response => response.status === 200));
  assert.equal(stock(await f.state(alpha)), stock(alphaStart) + 4);
  assert.equal(stock(await f.state(beta)), stock(betaStart) + 7);
  assert.equal((await f.action(alpha, 'stock-receive', {sku: SKU, qty: 8, requestId})).status, 409);
  assert.equal(stock(await f.state(beta)), stock(betaStart) + 7);

  const orderRequestId = randomUUID();
  const [alphaId, betaId] = await Promise.all([
    f.makeOrder(alpha, 'Only Alpha', {requestId: orderRequestId}),
    f.makeOrder(beta, 'Only Beta', {requestId: orderRequestId}),
  ]);
  assert.notEqual(alphaId, betaId, 'order identifiers are store-qualified');
  assert.ok(alphaId.startsWith('OH-ALPHA-M'));
  assert.ok(betaId.startsWith('OH-BETA-M'));
  assert.equal(await f.makeOrder(alpha, 'Only Alpha', {requestId: orderRequestId}), alphaId);
  assert.equal(await f.makeOrder(beta, 'Only Beta', {requestId: orderRequestId}), betaId);
  const alphaData = await f.state(alpha), betaData = await f.state(beta);
  assert.equal(alphaData.orders.filter(order => order.customer === 'Only Alpha').length, 1);
  assert.equal(betaData.orders.filter(order => order.customer === 'Only Beta').length, 1);
  assert.ok(!alphaData.orders.some(order => order.id === betaId));
  assert.ok(!betaData.orders.some(order => order.id === alphaId));

  for (const session of [alpha, beta]) {
    const first = await f.action(session, 'simulate-order');
    assert.equal(first.status, 200);
    const beforeRetry = await f.state(session);
    assert.equal((await f.action(session, 'simulate-order')).status, 200);
    const afterRetry = await f.state(session);
    assert.deepEqual(afterRetry.orders, beforeRetry.orders, 'provider event retry does not duplicate its own order');
    assert.equal(available(afterRetry, SKU), available(beforeRetry, SKU));
  }
  const aEvents = (await f.state(alpha)).orders.filter(order => order.external === 'SHOPEE-DEMO-001');
  const bEvents = (await f.state(beta)).orders.filter(order => order.external === 'SHOPEE-DEMO-001');
  assert.equal(aEvents.length, 1);
  assert.equal(bEvents.length, 1, 'same provider event key is accepted once in each store');
  assert.notEqual(aEvents[0].id, bEvents[0].id);
  assert.equal(aEvents[0].id, 'OH-ALPHA-SYNC-001');
  assert.equal(bEvents[0].id, 'OH-BETA-SYNC-001');

  const left = await f.makeOrder(beta, 'Last stock left', {qty: 6});
  const right = await f.makeOrder(beta, 'Last stock right', {qty: 6});
  const alphaSnapshot = await f.state(alpha);
  const reservations = await Promise.all([f.action(beta, 'reserve', {id: left}), f.action(beta, 'reserve', {id: right})]);
  assert.ok(reservations.every(response => response.status === 200));
  const competing = await f.state(beta);
  assert.equal(competing.orders.filter(order => [left, right].includes(order.id) && order.status === 'ready').length, 1);
  assert.equal(competing.orders.filter(order => [left, right].includes(order.id) && order.status === 'hold').length, 1);
  assert.equal(available(competing, SKU), 0, 'the final available units cannot be reserved twice');
  assert.deepEqual(await f.state(alpha), alphaSnapshot, 'parallel foreign reservations cannot change this store');
});

test('fresh authentication and restart retain the correct store, draft and request history', async t => {
  const f = await fixture(t), {alpha, beta} = await f.pair();
  const key = randomUUID();
  assert.equal((await f.action(alpha, 'stock-receive', {sku: SKU, qty: 2, requestId: key})).status, 200);
  assert.equal((await f.action(beta, 'stock-receive', {sku: SKU, qty: 9, requestId: key})).status, 200);
  await f.makeOrder(alpha, 'Persistent Alpha');
  await f.makeOrder(beta, 'Persistent Beta');
  for (const session of [alpha, beta]) {
    assert.equal((await f.post('/api/connections', {channel: 'Lazada', storeName: `${session.store.code} persistent`, storeUrl: ''}, session)).status, 200);
  }
  const snapshots = [await f.state(alpha), await f.state(beta)];
  const switched = await f.post('/api/auth/login', credentials('beta'), alpha);
  assert.equal(switched.status, 200);
  assert.equal(switched.j.store.id, beta.store.id);
  assert.equal(switched.j.user.id, beta.user.id);
  assert.equal((await f.request('/api/state', {session: alpha})).status, 401, 'explicit login replaces the prior browser session');
  const changedSession = sessionOf(switched);
  for (const [route, method, body] of [
    ['/api/state', 'GET', undefined],
    ['/api/actions', 'POST', {action: 'stock-receive', sku: SKU, qty: 99}],
  ]) {
    const stale = await f.request(route, {method, body, session: changedSession, headers: {'X-Store-Id': alpha.store.id}});
    assert.equal(stale.status, 409, 'stale browser store context must be rejected');
    assert.equal(stale.j.code, 'SESSION_CHANGED');
  }
  assert.deepEqual(await f.state(changedSession), snapshots[1], 'stale context cannot perform a mutation in the new session store');
  assert.equal((await f.request('/api/state', {session: changedSession, headers: {'X-Store-Id': beta.store.id}})).status, 200);
  await f.restart();
  const resumed = [await f.login(credentials('alpha')), await f.login(credentials('beta'))];
  for (let index = 0; index < resumed.length; index++) {
    const session = resumed[index];
    assert.equal(session.store.id, [alpha, beta][index].store.id);
    assert.deepEqual(await f.state(session), snapshots[index], 'each store state persists without merging');
    assert.equal((await f.request('/api/connections', {session})).j.drafts[0].storeName, `${session.store.code} persistent`);
    assert.equal((await f.action(session, 'stock-receive', {sku: SKU, qty: index ? 9 : 2, requestId: key})).status, 200);
    assert.deepEqual(await f.state(session), snapshots[index], 'idempotency history survives restart for the correct store');
  }
});

test('legacy migration preserves users, hashes, state, drafts and audit, revokes sessions, and is repeatable', async t => {
  const seed = createSeed();
  seed.products[0].stock += 13;
  seed.audit.unshift({orderId: 'LEGACY-SENTINEL', time: '12:00:00', at: '2026-01-01T05:00:00.000Z', text: 'Legacy audit retained', actor: 'Legacy Owner'});
  const original = projectData(seed, 'admin');
  const oldToken = 'ab'.repeat(32), oldCsrf = 'legacy-csrf-value';
  const salt = 'legacy-fixture-salt';
  const hash = salt + ':' + scryptSync(PASSWORD, salt, 64, {N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024}).toString('hex');
  const legacyRequest = {action: 'stock-receive', sku: SKU, qty: 13, requestId: 'legacy-receipt-000001'};
  const draft = {storeName: 'Legacy marketplace', storeUrl: 'https://shopee.co.th/legacy', warehouse: 'คลังกลาง', syncStock: true, status: 'draft', connectionMode: 'pending_provider_setup'};
  const f = await fixture(t, dbPath => {
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(`
        PRAGMA foreign_keys=ON;
        CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT NOT NULL UNIQUE,name TEXT NOT NULL,password_hash TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('admin','warehouse','finance')),active INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL);
        CREATE TABLE sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),csrf TEXT NOT NULL,expires_at INTEGER NOT NULL);
        CREATE INDEX idx_sessions_user ON sessions(user_id);
        CREATE TABLE application_state(id INTEGER PRIMARY KEY CHECK(id=1),data TEXT NOT NULL);
        CREATE TABLE action_requests(actor_id TEXT NOT NULL,request_id TEXT NOT NULL,fingerprint TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(actor_id,request_id));
        CREATE TABLE security_audit(id INTEGER PRIMARY KEY,at TEXT NOT NULL,actor_id TEXT,action TEXT NOT NULL,target_id TEXT);
        CREATE TABLE connection_drafts(channel TEXT PRIMARY KEY,data TEXT NOT NULL,updated_at TEXT NOT NULL,actor_id TEXT NOT NULL);
      `);
      const insertUser = db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?)');
      insertUser.run('legacy-owner', 'legacy_owner', 'Legacy Owner', hash, 'admin', 1, '2026-01-01T00:00:00.000Z');
      insertUser.run('legacy-worker', 'legacy_worker', 'Legacy Worker', hash, 'warehouse', 1, '2026-01-02T00:00:00.000Z');
      insertUser.run('legacy-disabled', 'legacy_disabled', 'Legacy Disabled', hash, 'finance', 0, '2026-01-03T00:00:00.000Z');
      db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(digest(oldToken), 'legacy-owner', oldCsrf, Date.now() + 3_600_000);
      db.prepare('INSERT INTO application_state VALUES(1,?)').run(JSON.stringify(seed));
      db.prepare('INSERT INTO action_requests VALUES(?,?,?,?)').run('legacy-owner', legacyRequest.requestId, digest(JSON.stringify(legacyRequest)), JSON.stringify('Legacy receipt already recorded'));
      db.prepare('INSERT INTO security_audit VALUES(?,?,?,?,?)').run(42, '2026-01-01T00:00:00.000Z', 'legacy-owner', 'legacy_preserved', 'LEGACY-SENTINEL');
      db.prepare('INSERT INTO connection_drafts VALUES(?,?,?,?)').run('Shopee', JSON.stringify(draft), '2026-01-01T00:00:00.000Z', 'legacy-owner');
    } finally { db.close(); }
  });
  assert.equal((await f.request('/api/auth/status')).j.needsSetup, false);
  assert.equal((await f.request('/api/state', {session: {cookie: `oh_session=${oldToken}`, csrf: oldCsrf}})).status, 401, 'migration revokes pre-tenancy sessions');
  const owner = await f.login({username: 'legacy_owner', password: PASSWORD});
  assert.ok(owner.store.id);
  assert.equal(owner.user.id, 'legacy-owner');
  assert.equal(owner.user.storeId, owner.store.id);
  const readUsers = async session => (await f.request('/api/users', {session})).j.users;
  const users = await readUsers(owner);
  assert.equal(users.length, 3);
  assert.equal(Boolean(users.find(user => user.id === 'legacy-disabled').active), false);
  assert.equal(f.db.prepare('SELECT password_hash FROM users WHERE id=?').get('legacy-owner').password_hash, hash);
  assert.deepEqual(await f.state(owner), original);
  const connections = (await f.request('/api/connections', {session: owner})).j.drafts;
  assert.equal(connections.length, 1);
  assert.equal(connections[0].storeName, draft.storeName);
  const savedAudit = f.db.prepare("SELECT at,actor_id,action,target_id FROM security_audit WHERE action='legacy_preserved'").all();
  assert.equal(savedAudit.length, 1);
  assert.equal(savedAudit[0].actor_id, 'legacy-owner');
  assert.equal(savedAudit[0].target_id, 'LEGACY-SENTINEL');
  const retried = await f.post('/api/actions', legacyRequest, owner);
  assert.equal(retried.status, 200);
  assert.equal(retried.j.result, 'Legacy receipt already recorded');
  assert.deepEqual(await f.state(owner), original, 'legacy idempotency prevents a historical stock receipt replay');
  assert.equal((await f.post('/api/auth/login', {storeCode: owner.store.code, username: 'legacy_disabled', password: PASSWORD})).status, 401);
  const worker = await f.login({storeCode: owner.store.code, username: 'legacy_worker', password: PASSWORD});
  assert.equal(worker.user.id, 'legacy-worker');
  assert.equal(worker.user.storeId, owner.store.id);

  await f.restart();
  const again = await f.login({storeCode: owner.store.code, username: 'legacy_owner', password: PASSWORD});
  assert.equal(again.store.id, owner.store.id, 'migration reuses the same store identity');
  assert.deepEqual(await readUsers(again), users);
  assert.deepEqual(await f.state(again), original);
  assert.deepEqual((await f.request('/api/connections', {session: again})).j.drafts, connections);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM security_audit WHERE action='legacy_preserved'").get().n, 1);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM tenants').get().n, 1, 'restart does not create another migrated store');
  assert.equal(f.db.prepare('SELECT password_hash FROM users WHERE id=?').get('legacy-owner').password_hash, hash);
  assert.equal((await f.post('/api/actions', legacyRequest, again)).status, 200);
  assert.deepEqual(await f.state(again), original);
});

test('password-only user update preserves concurrent disable, demotion and name changes during hashing', async t => {
  const f = await fixture(t), {alpha, beta} = await f.pair();
  assert.equal((await f.post('/api/users', {
    username: 'password_race', name: 'Original account name', password: PASSWORD, role: 'admin',
  }, alpha)).status, 201);
  const target = await f.login(credentials('alpha', {username: 'password_race'}));
  const before = f.db.prepare('SELECT * FROM users WHERE id=?').get(target.user.id);
  const betaUsers = (await f.request('/api/users', {session: beta})).j.users;
  let injected = false;
  // The request body ends before the async scrypt completes. Change the target
  // during that gap so the password-only PATCH must re-read the latest fields.
  f.server.once('request', request => request.once('end', () => setImmediate(() => {
    f.db.prepare('UPDATE users SET active=0,role=?,name=? WHERE id=? AND tenant_id=?')
      .run('warehouse', 'Concurrent account name', target.user.id, alpha.store.id);
    injected = true;
  })));
  const response = await f.patch('/api/users/' + target.user.id, {password: OTHER_PASSWORD}, alpha);
  assert.equal(injected, true, 'the competing account update ran while the password update was pending');
  assert.equal(response.status, 200, JSON.stringify(response.j));
  const after = f.db.prepare('SELECT * FROM users WHERE id=?').get(target.user.id);
  assert.equal(after.active, 0, 'password reset must not reactivate a concurrently disabled account');
  assert.equal(after.role, 'warehouse', 'password reset must not restore a concurrently removed admin role');
  assert.equal(after.name, 'Concurrent account name', 'omitted name must retain its most recent value');
  assert.equal(after.tenant_id, alpha.store.id);
  assert.notEqual(after.password_hash, before.password_hash, 'the requested password change still takes effect');
  assert.equal((await f.request('/api/state', {session: target})).status, 401, 'the prior target session is revoked');
  assert.equal((await f.post('/api/auth/login', credentials('alpha', {username: 'password_race', password: OTHER_PASSWORD}))).status, 401);
  assert.deepEqual((await f.request('/api/users', {session: beta})).j.users, betaUsers);
  assert.equal((await f.patch('/api/users/' + target.user.id, {active: true}, alpha)).status, 200);
  const resumed = await f.login(credentials('alpha', {username: 'password_race', password: OTHER_PASSWORD}));
  assert.equal(resumed.user.role, 'warehouse');
  assert.equal(resumed.user.name, 'Concurrent account name');
  assert.equal((await f.post('/api/auth/login', credentials('alpha', {username: 'password_race'}))).status, 401, 'the superseded password no longer authenticates');
});
