import {randomBytes} from 'node:crypto';
import {createSeed} from './model.mjs';

const schema=`
CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tenants(id TEXT PRIMARY KEY,code TEXT NOT NULL UNIQUE,name TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL REFERENCES tenants(id),username TEXT NOT NULL,name TEXT NOT NULL,password_hash TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('admin','warehouse','finance')),active INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,UNIQUE(tenant_id,username));
CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),csrf TEXT NOT NULL,expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id);
CREATE TABLE IF NOT EXISTS tenant_state(tenant_id TEXT PRIMARY KEY REFERENCES tenants(id),data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS action_requests(tenant_id TEXT NOT NULL REFERENCES tenants(id),actor_id TEXT NOT NULL,request_id TEXT NOT NULL,fingerprint TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(tenant_id,actor_id,request_id));
CREATE TABLE IF NOT EXISTS security_audit(id INTEGER PRIMARY KEY,at TEXT NOT NULL,tenant_id TEXT NOT NULL REFERENCES tenants(id),actor_id TEXT,action TEXT NOT NULL,target_id TEXT);
CREATE TABLE IF NOT EXISTS connection_drafts(tenant_id TEXT NOT NULL REFERENCES tenants(id),channel TEXT NOT NULL,data TEXT NOT NULL,updated_at TEXT NOT NULL,actor_id TEXT NOT NULL,PRIMARY KEY(tenant_id,channel));
`;
const exists=(db,name)=>!!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
export function transaction(db,fn){db.exec('BEGIN IMMEDIATE');try{const out=fn();db.exec('COMMIT');return out}catch(e){db.exec('ROLLBACK');throw e}}
export function emptyStoreState(){
  const data=createSeed();
  // The catalog is a sample template; no transactions or inventory are copied from another shop.
  data.products=data.products.map(p=>({...p,stock:0}));
  data.orders=[];data.payouts=[];data.expenses=[];data.audit=[];data.stockEvents=[];
  data.syncCount=0;data.stockRevision=1;data.blockedChannel='';
  data.lastStock=Object.fromEntries(data.products.map(p=>[p.sku,0]));
  for(const channel of Object.keys(data.publishedStock))data.publishedStock[channel]={qty:{...data.lastStock},revision:1,state:'สาธิต: ส่งค่าแล้ว'};
  return data;
}
export function insertStore(db,{name,code},data=emptyStoreState()){
  const store={id:randomBytes(16).toString('hex'),name,code,active:true};
  db.prepare('INSERT INTO tenants VALUES(?,?,?,?,?)').run(store.id,store.code,store.name,1,new Date().toISOString());
  db.prepare('INSERT INTO tenant_state VALUES(?,?)').run(store.id,JSON.stringify(data));
  return store;
}
export function initializeStorage(db){
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=OFF;');
  const legacy=exists(db,'users')&&!db.prepare('PRAGMA table_info(users)').all().some(c=>c.name==='tenant_id');
  try{
    transaction(db,()=>{
      if(legacy){
        const users=db.prepare('SELECT * FROM users').all();
        const state=exists(db,'application_state')?db.prepare('SELECT data FROM application_state WHERE id=1').get()?.data:null;
        const drafts=exists(db,'connection_drafts')?db.prepare('SELECT * FROM connection_drafts').all():[];
        const actions=exists(db,'action_requests')?db.prepare('SELECT * FROM action_requests').all():[];
        const audit=exists(db,'security_audit')?db.prepare('SELECT * FROM security_audit').all():[];
        const names=['users','sessions','application_state','connection_drafts','action_requests','security_audit'];
        for(const name of names)if(exists(db,name))db.exec(`ALTER TABLE ${name} RENAME TO legacy_${name};`);
        // The old session index name is occupied until its table is dropped; recreate it at the end.
        db.exec(schema);
        if(users.length){
          const shopDraft=drafts.find(d=>d.channel==='Shopee')||drafts[0];
          const shopName=shopDraft?JSON.parse(shopDraft.data).storeName:null;
          const name=typeof shopName==='string'&&shopName.trim()?shopName.trim():'ร้านหลัก';
          let code=name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
          if(code.length<3||code.length>40)code='main';
          const store=insertStore(db,{name,code},state?JSON.parse(state):createSeed());
          const addUser=db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?,?)');
          for(const u of users)addUser.run(u.id,store.id,u.username,u.name,u.password_hash,u.role,u.active,u.created_at);
          for(const d of drafts)db.prepare('INSERT INTO connection_drafts VALUES(?,?,?,?,?)').run(store.id,d.channel,d.data,d.updated_at,d.actor_id);
          for(const a of actions)db.prepare('INSERT INTO action_requests VALUES(?,?,?,?,?)').run(store.id,a.actor_id,a.request_id,a.fingerprint,a.result);
          for(const a of audit)db.prepare('INSERT INTO security_audit VALUES(?,?,?,?,?,?)').run(a.id,a.at,store.id,a.actor_id,a.action,a.target_id);
        }
        // Sessions from the pre-store schema are deliberately revoked; passwords and user IDs remain unchanged.
        for(const name of names)if(exists(db,'legacy_'+name))db.exec(`DROP TABLE legacy_${name};`);
        db.exec(schema);
      }else db.exec(schema);
      db.prepare('INSERT OR IGNORE INTO schema_migrations VALUES(3,?)').run(new Date().toISOString());
      db.exec('PRAGMA user_version=3;');
      if(db.prepare('PRAGMA foreign_key_check').all().length)throw Error('Store migration failed foreign key verification');
    });
  }finally{db.exec('PRAGMA foreign_keys=ON;')}
}
