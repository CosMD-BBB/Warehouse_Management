import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {randomBytes,scrypt,timingSafeEqual,createHash} from 'node:crypto';
import {promisify} from 'node:util';
import {ROLES,createSeed,perform,projectData,fault} from './model.mjs';
import {initializeStorage,insertStore,transaction} from './storage.mjs';

const scryptAsync=promisify(scrypt),root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const digest=s=>createHash('sha256').update(s).digest('hex');
const safeUser=u=>({id:u.id,storeId:u.tenant_id,username:u.username,name:u.name,role:u.role,active:!!u.active});
const storeOf=u=>({id:u.tenant_id,name:u.store_name,code:u.store_code,active:true});
const storeFields=(b,initial=false)=>{
  const name=String(b.storeName??(initial?'ร้านหลัก':'')).trim();
  const code=String(b.storeCode??(initial?'main':'')).trim().toLowerCase();
  if(!name||name.length>80)fault('กรุณาระบุชื่อร้าน 1–80 ตัวอักษร');
  if(code.length<3||code.length>40||!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(code))fault('รหัสร้านใช้ a-z, 0-9 และขีดกลาง 3–40 ตัวอักษร');
  return {name,code};
};
async function hashPassword(password){const salt=randomBytes(16).toString('hex'),hash=await scryptAsync(password,salt,64,{N:32768,r:8,p:1,maxmem:64*1024*1024});return salt+':'+hash.toString('hex')}
let dummyPasswordHash;
const getDummyPasswordHash=()=>dummyPasswordHash||=hashPassword(randomBytes(32).toString('hex'));
async function verifyPassword(password,stored){const [salt,hex]=stored.split(':');const actual=await scryptAsync(password,salt,64,{N:32768,r:8,p:1,maxmem:64*1024*1024}),expected=Buffer.from(hex,'hex');return actual.length===expected.length&&timingSafeEqual(actual,expected)}
function passwordValid(value){if(typeof value!=='string'||value.length<12||value.length>128)fault('ใช้รหัสผ่าน 12–128 ตัวอักษร');return value}
function accountFields(b){const username=String(b.username||'').trim().toLowerCase(),name=String(b.name||'').trim();if(!/^[a-z0-9._-]{3,40}$/.test(username))fault('ชื่อผู้ใช้ต้องเป็น a-z, 0-9, จุด ขีด หรือขีดล่าง 3–40 ตัว');if(!name||name.length>80)fault('กรุณาระบุชื่อผู้ใช้ 1–80 ตัวอักษร');return {username,name}}

function configuredOrigin(value){
  if(value==='')return null;
  let url;try{url=new URL(value)}catch{throw new Error('ORDER_HUB_PUBLIC_ORIGIN must be a single HTTPS origin')}
  if(typeof value!=='string'||!/^https:\/\/[^\s\\/?#]+\/?$/i.test(value)||url.protocol!=='https:'||url.username||url.password||url.hostname.includes('*')||url.pathname!=='/'||url.search||url.hash)throw new Error('ORDER_HUB_PUBLIC_ORIGIN must be a single HTTPS origin without a path, credentials, query or fragment');
  return url;
}

export function createApp({dbPath=process.env.ORDER_HUB_DB||path.join(root,'.local','order-hub.sqlite'),publicOrigin=process.env.ORDER_HUB_PUBLIC_ORIGIN||'',attempts=new Map()}={}){
  const external=configuredOrigin(publicOrigin),cookieFlags=`HttpOnly; SameSite=Strict; Path=/${external?'; Secure':''}`;
  if(!(attempts instanceof Map))throw new Error('Authentication attempt storage must be a Map');
  const clearedCookie=`oh_session=; ${cookieFlags}; Max-Age=0`;
  fs.mkdirSync(path.dirname(dbPath),{recursive:true,mode:0o700});
  const db=new DatabaseSync(dbPath);try{fs.chmodSync(dbPath,0o600)}catch{}
  try{initializeStorage(db)}catch(error){db.close();throw error}
  const ttl=8*60*60*1000;
  const transact=fn=>transaction(db,fn);
  const lookupUser=id=>db.prepare('SELECT u.*,t.name store_name,t.code store_code FROM users u JOIN tenants t ON t.id=u.tenant_id WHERE u.id=? AND t.active=1').get(id);
  const record=(actor,action,target)=>db.prepare('INSERT INTO security_audit(at,tenant_id,actor_id,action,target_id) VALUES(?,?,?,?,?)').run(new Date().toISOString(),actor.tenant_id,actor.id,action,target||null);
  function send(res,status,data,headers={}){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...headers});res.end(JSON.stringify(data))}
  function session(req){
    const token=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('oh_session='))?.slice(11);
    if(!token||!/^[a-f0-9]{64}$/.test(token))return null;
    return db.prepare('SELECT u.*,t.name store_name,t.code store_code,s.csrf,s.token_hash,s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id JOIN tenants t ON t.id=u.tenant_id WHERE s.token_hash=? AND s.expires_at>? AND u.active=1 AND t.active=1').get(digest(token),Date.now())||null;
  }
  function checkStoreContext(req,u){
    if(req.headers['x-store-id']&&req.headers['x-store-id']!==u.tenant_id)throw Object.assign(new Error('บัญชีเปลี่ยนร้าน กรุณาเข้าสู่ระบบใหม่'),{status:409,code:'SESSION_CHANGED'});
  }
  function freshSession(req,role){
    const u=session(req);if(!u)fault('กรุณาเข้าสู่ระบบใหม่',401);
    checkStoreContext(req,u);
    if(req.headers['x-csrf-token']!==u.csrf)fault('Session verification failed',403);
    if(role&&u.role!==role)fault('เฉพาะ Admin ของร้านนี้เท่านั้น',403);
    return u;
  }
  function issue(user){
    const token=randomBytes(32).toString('hex'),csrf=randomBytes(24).toString('hex');
    db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(Date.now());
    db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(digest(token),user.id,csrf,Date.now()+ttl);
    return {csrf,cookie:`oh_session=${token}; ${cookieFlags}; Max-Age=${ttl/1000}`};
  }
  function authReply(res,status,u){const s=issue(u);send(res,status,{user:safeUser(u),store:storeOf(u),csrf:s.csrf,permissions:ROLES[u.role]},{'Set-Cookie':s.cookie})}
  function addOwner(store,fields,hash){
    const u={id:randomBytes(16).toString('hex'),tenant_id:store.id,...fields,role:'admin',active:1};
    db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?,?)').run(u.id,u.tenant_id,u.username,u.name,hash,u.role,1,new Date().toISOString());
    return lookupUser(u.id);
  }
  async function body(req){
    if(!String(req.headers['content-type']||'').startsWith('application/json'))fault('Content-Type must be application/json',415);
    let size=0;const chunks=[];
    for await(const chunk of req){size+=chunk.length;if(size>65536)fault('Request too large',413);chunks.push(chunk)}
    try{const b=JSON.parse(Buffer.concat(chunks).toString());if(!b||typeof b!=='object'||Array.isArray(b))fault('Invalid body');return b}catch{fault('ข้อมูลที่ส่งไม่ถูกต้อง')}
  }
  function readStoreState(u){const row=db.prepare('SELECT data FROM tenant_state WHERE tenant_id=?').get(u.tenant_id);if(!row)fault('ไม่พบข้อมูลร้าน',404);return JSON.parse(row.data)}

  const handler=async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try{
      const port=server.address()?.port,hosts=external?[external.host]:[`127.0.0.1:${port}`,`localhost:${port}`];
      if(!hosts.includes(req.headers.host))fault('Host not allowed',403);
      const url=new URL(req.url,external?.origin||'http://'+req.headers.host),route=url.pathname,mutating=!['GET','HEAD'].includes(req.method);
      const origins=external?[external.origin]:hosts.map(h=>'http://'+h);
      if(mutating&&!origins.includes(req.headers.origin))fault('Origin not allowed',403);
      let user=session(req);
      if(route.startsWith('/api/')){
        if(route==='/api/auth/status'&&req.method==='GET'){
          const stores=db.prepare('SELECT code FROM tenants WHERE active=1 LIMIT 2').all();
          send(res,200,{needsSetup:db.prepare('SELECT COUNT(*) n FROM users').get().n===0,legacyStoreCode:stores.length===1?stores[0].code:'',user:user?safeUser(user):null,store:user?storeOf(user):null,csrf:user?.csrf||null,permissions:user?ROLES[user.role]:null});return;
        }
        if(route==='/api/auth/setup'&&req.method==='POST'){
          if(db.prepare('SELECT COUNT(*) n FROM users').get().n)fault('สร้าง Admin เริ่มต้นแล้ว',409);
          const b=await body(req),fields=accountFields(b),storeFieldsValue=storeFields(b,true),hash=await hashPassword(passwordValid(b.password));
          const u=transact(()=>{
            if(db.prepare('SELECT COUNT(*) n FROM users').get().n)fault('สร้าง Admin เริ่มต้นแล้ว',409);
            const store=insertStore(db,storeFieldsValue,createSeed()),owner=addOwner(store,fields,hash);
            record(owner,'setup_store_admin',owner.id);return owner;
          });
          authReply(res,201,u);return;
        }
        if(route==='/api/auth/login'&&req.method==='POST'){
          const b=await body(req),username=String(b.username||'').trim().toLowerCase();
          if(typeof b.password!=='string'||b.password.length>128)fault('รหัสร้าน ชื่อผู้ใช้ หรือรหัสผ่านไม่ถูกต้อง',401);
          let code=String(b.storeCode||'').trim().toLowerCase();
          if(!code){const stores=db.prepare('SELECT code FROM tenants WHERE active=1 LIMIT 2').all();if(stores.length===1)code=stores[0].code}
          const key=digest((req.socket.remoteAddress||'')+'|'+code+'|'+username),ipKey=digest(req.socket.remoteAddress||'');
          for(const [k,v]of attempts)if(Date.now()-v.at>900000)attempts.delete(k);
          if(attempts.get(key)?.count>=6||attempts.get(ipKey)?.count>=30)fault('ลองเข้าสู่ระบบมากเกินไป กรุณารอ 15 นาที',429);
          const u=db.prepare('SELECT u.*,t.name store_name,t.code store_code FROM users u JOIN tenants t ON t.id=u.tenant_id WHERE t.code=? AND t.active=1 AND u.username=?').get(code,username);
          const valid=await verifyPassword(b.password,u?.password_hash||await getDummyPasswordHash()),current=u?lookupUser(u.id):null;
          if(!valid||!current?.active||current.password_hash!==u.password_hash||current.tenant_id!==u.tenant_id||current.store_code!==code){
            for(const k of [key,ipKey])attempts.set(k,{count:(attempts.get(k)?.count||0)+1,at:Date.now()});fault('รหัสร้าน ชื่อผู้ใช้ หรือรหัสผ่านไม่ถูกต้อง',401);
          }
          attempts.delete(key);if(user)db.prepare('DELETE FROM sessions WHERE token_hash=?').run(user.token_hash);
          record(current,'login');authReply(res,200,current);return;
        }
        if(!user)fault('กรุณาเข้าสู่ระบบ',401);
        checkStoreContext(req,user);
        if(mutating&&req.headers['x-csrf-token']!==user.csrf)fault('Session verification failed',403);
        if(route==='/api/auth/logout'&&req.method==='POST'){
          db.prepare('DELETE FROM sessions WHERE token_hash=?').run(user.token_hash);record(user,'logout');
          send(res,200,{ok:true},{'Set-Cookie':clearedCookie});return;
        }
        if(route==='/api/auth/password'&&req.method==='POST'){
          const b=await body(req);if(typeof b.currentPassword!=='string'||b.currentPassword.length>128||!await verifyPassword(b.currentPassword,user.password_hash))fault('รหัสผ่านปัจจุบันไม่ถูกต้อง',400);
          const hash=await hashPassword(passwordValid(b.password));user=freshSession(req);
          transact(()=>{db.prepare('UPDATE users SET password_hash=? WHERE id=? AND tenant_id=?').run(hash,user.id,user.tenant_id);db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);record(user,'change_password',user.id)});
          send(res,200,{ok:true},{'Set-Cookie':clearedCookie});return;
        }
        if(route==='/api/state'&&req.method==='GET'){
          send(res,200,{data:projectData(readStoreState(user),user.role),user:safeUser(user),store:storeOf(user),permissions:ROLES[user.role]});return;
        }
        if(route==='/api/actions'&&req.method==='POST'){
          const b=await body(req);user=freshSession(req);
          if(!ROLES[user.role].actions.includes(b.action))fault('บัญชีนี้ไม่มีสิทธิ์ทำรายการนี้',403);
          if(b.requestId!==undefined&&!/^[a-zA-Z0-9-]{16,80}$/.test(b.requestId))fault('รหัสรายการไม่ถูกต้อง');
          const fingerprint=digest(JSON.stringify(b));
          const result=transact(()=>{
            if(b.requestId){const previous=db.prepare('SELECT * FROM action_requests WHERE tenant_id=? AND actor_id=? AND request_id=?').get(user.tenant_id,user.id,b.requestId);if(previous){if(previous.fingerprint!==fingerprint)fault('รหัสรายการนี้ใช้กับข้อมูลอื่นแล้ว',409);return JSON.parse(previous.result)}}
            const data=readStoreState(user),out=perform(data,b.action,b,user);
            db.prepare('UPDATE tenant_state SET data=? WHERE tenant_id=?').run(JSON.stringify(data),user.tenant_id);record(user,b.action,b.id||b.sku);
            if(b.requestId)db.prepare('INSERT INTO action_requests VALUES(?,?,?,?,?)').run(user.tenant_id,user.id,b.requestId,fingerprint,JSON.stringify(out));
            return out;
          });send(res,200,{ok:true,result});return;
        }
        if(route==='/api/store'&&req.method==='GET'){send(res,200,{store:storeOf(user)});return}
        if(route==='/api/store'&&req.method==='PATCH'){
          const b=await body(req);user=freshSession(req,'admin');const name=String(b.name||'').trim();
          if(!name||name.length>80)fault('กรุณาระบุชื่อร้าน 1–80 ตัวอักษร');
          if(b.code!==undefined&&b.code!==user.store_code)fault('รหัสร้านเปลี่ยนไม่ได้');
          transact(()=>{db.prepare('UPDATE tenants SET name=? WHERE id=?').run(name,user.tenant_id);record(user,'update_store',user.tenant_id)});
          send(res,200,{store:{...storeOf(user),name}});return;
        }
        if(route==='/api/stores'&&req.method==='POST'){
          if(user.role!=='admin')fault('เฉพาะ Admin ของร้านนี้เท่านั้น',403);
          const b=await body(req),fields=accountFields(b),storeFieldsValue=storeFields(b),hash=await hashPassword(passwordValid(b.password));
          user=freshSession(req,'admin');
          const store=transact(()=>{
            if(db.prepare('SELECT id FROM tenants WHERE code=?').get(storeFieldsValue.code))fault('รหัสร้านนี้ถูกใช้แล้ว',409);
            const store=insertStore(db,storeFieldsValue),owner=addOwner(store,fields,hash);
            record(user,'provision_store',store.id);record(owner,'setup_store_admin',owner.id);return store;
          });send(res,201,{ok:true,store,ownerCreated:true});return;
        }
        if(route==='/api/users'&&req.method==='GET'){
          if(user.role!=='admin')fault('เฉพาะ Admin ของร้านนี้เท่านั้น',403);
          send(res,200,{users:db.prepare('SELECT id,username,name,role,active,created_at FROM users WHERE tenant_id=? ORDER BY created_at').all(user.tenant_id),roles:ROLES,store:storeOf(user)});return;
        }
        if(route==='/api/users'&&req.method==='POST'){
          if(user.role!=='admin')fault('เฉพาะ Admin ของร้านนี้เท่านั้น',403);
          const b=await body(req),fields=accountFields(b);if(!Object.hasOwn(ROLES,b.role))fault('สิทธิ์ไม่ถูกต้อง');
          const hash=await hashPassword(passwordValid(b.password));user=freshSession(req,'admin');
          const id=transact(()=>{
            if(db.prepare('SELECT id FROM users WHERE tenant_id=? AND username=?').get(user.tenant_id,fields.username))fault('ชื่อผู้ใช้นี้มีแล้วในร้านนี้',409);
            const id=randomBytes(16).toString('hex');db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?,?)').run(id,user.tenant_id,fields.username,fields.name,hash,b.role,1,new Date().toISOString());record(user,'create_user',id);return id;
          });send(res,201,{ok:true,id});return;
        }
        if(route.startsWith('/api/users/')&&req.method==='PATCH'){
          if(user.role!=='admin')fault('เฉพาะ Admin ของร้านนี้เท่านั้น',403);
          const id=route.slice('/api/users/'.length),b=await body(req);user=freshSession(req,'admin');
          const existing=db.prepare('SELECT * FROM users WHERE id=? AND tenant_id=?').get(id,user.tenant_id);if(!existing)fault('ไม่พบผู้ใช้',404);
          const providedName=b.name===undefined?undefined:String(b.name).trim();
          if(b.role!==undefined&&!Object.hasOwn(ROLES,b.role)||b.active!==undefined&&typeof b.active!=='boolean'||providedName!==undefined&&(!providedName||providedName.length>80))fault('ข้อมูลผู้ใช้ไม่ถูกต้อง');
          const hash=b.password===undefined?null:await hashPassword(passwordValid(b.password));user=freshSession(req,'admin');
          let sessionRevoked=false;
          transact(()=>{
            const current=db.prepare('SELECT * FROM users WHERE id=? AND tenant_id=?').get(id,user.tenant_id);if(!current)fault('ไม่พบผู้ใช้',404);
            const role=b.role??current.role,active=b.active===undefined?!!current.active:b.active,name=providedName??current.name;
            const adminCount=db.prepare("SELECT COUNT(*) n FROM users WHERE tenant_id=? AND active=1 AND role='admin'").get(user.tenant_id).n;
            if(current.role==='admin'&&current.active&&(!active||role!=='admin')&&adminCount<=1)fault('ต้องเหลือ Admin ที่ใช้งานได้อย่างน้อย 1 คนในร้านนี้',409);
            db.prepare('UPDATE users SET name=?,role=?,active=?,password_hash=COALESCE(?,password_hash) WHERE id=? AND tenant_id=?').run(name,role,active?1:0,hash,id,user.tenant_id);
            const revoke=role!==current.role||active!==!!current.active||!!hash;if(revoke)db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
            sessionRevoked=id===user.id&&revoke;record(user,'update_user',id);
          });send(res,200,{ok:true,sessionRevoked});return;
        }
        if(route==='/api/connections'&&req.method==='GET'){
          if(user.role!=='admin')fault('เฉพาะ Admin ของร้านนี้เท่านั้น',403);
          send(res,200,{drafts:db.prepare('SELECT channel,data,updated_at FROM connection_drafts WHERE tenant_id=?').all(user.tenant_id).map(r=>({...JSON.parse(r.data),channel:r.channel,updatedAt:r.updated_at})),live:false});return;
        }
        if(route==='/api/connections'&&req.method==='POST'){
          const b=await body(req);user=freshSession(req,'admin');const channels=['Shopee','Lazada','TikTok Shop','Facebook','LINE OA','Review','Offline sales'];
          if(!channels.includes(b.channel))fault('ช่องทางไม่ถูกต้อง');
          const name=String(b.storeName||'').trim(),storeUrl=String(b.storeUrl||'').trim();if(!name||name.length>80)fault('กรุณาระบุชื่อร้านไม่เกิน 80 ตัวอักษร');
          if(storeUrl){let u;try{u=new URL(storeUrl)}catch{fault('ลิงก์ร้านไม่ถูกต้อง')}if(u.protocol!=='https:')fault('ลิงก์ร้านต้องขึ้นต้นด้วย https://');if(storeUrl.length>500)fault('ลิงก์ร้านยาวเกินไป')}
          const data={storeName:name,storeUrl,warehouse:'คลังกลาง',syncStock:true,status:'draft',connectionMode:['Review','Offline sales'].includes(b.channel)?'manual':'pending_provider_setup'};
          transact(()=>{db.prepare('INSERT INTO connection_drafts VALUES(?,?,?,?,?) ON CONFLICT(tenant_id,channel) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at,actor_id=excluded.actor_id').run(user.tenant_id,b.channel,JSON.stringify(data),new Date().toISOString(),user.id);record(user,'save_connection_draft',b.channel)});
          send(res,200,{ok:true,draft:data,live:false});return;
        }
        fault('ไม่พบรายการที่เรียก',404);
      }
      if(!['GET','HEAD'].includes(req.method))fault('Method not allowed',405);
      const asset=route==='/'?'index.html':route.slice(1),allow=/^(index\.html|brand-logo\.jpeg|brand-icon\.png|styles\.css|auth\.css|order-editor\.css|app\.js|features\.js|stock-sync\.js|auth-client\.js|order-editor\.js|connections\.js|fonts\/[A-Za-z0-9._-]+\.(ttf|woff2)|channels\/[A-Za-z0-9._-]+\.(svg|png|webp))$/;
      if(!allow.test(asset))fault('Not found',404);
      const file=path.join(root,'dist',asset);if(!fs.existsSync(file))fault('Not found',404);
      const types={'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.ttf':'font/ttf','.svg':'image/svg+xml','.png':'image/png','.jpeg':'image/jpeg','.webp':'image/webp'};
      res.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store'});res.end(req.method==='HEAD'?undefined:fs.readFileSync(file));
    }catch(e){const status=e.status||500;if(status===500)console.error('Order Hub request failed:',e.message);send(res,status,{error:status===500?'ระบบขัดข้อง กรุณาลองใหม่':e.message,...(e.code==='SESSION_CHANGED'?{code:e.code}:{})})}
  };
  const server=http.createServer(handler);
  let closed=false;
  const close=()=>{if(!closed){db.close();closed=true}};
  server.on('close',close);return {server,db,handler,close};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const host=process.env.ORDER_HUB_HOST||'127.0.0.1',port=Number(process.env.ORDER_HUB_PORT||process.env.PORT||4180);
  if(!['127.0.0.1','0.0.0.0'].includes(host))throw new Error('ORDER_HUB_HOST must be 127.0.0.1 or 0.0.0.0');
  if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Server port must be an integer from 1 to 65535');
  if(host!=='127.0.0.1'&&!process.env.ORDER_HUB_PUBLIC_ORIGIN)throw new Error('Set ORDER_HUB_PUBLIC_ORIGIN to the exact HTTPS origin before binding publicly');
  const {server}=createApp();
  server.listen(port,host,()=>console.log(`Order Hub ready: ${process.env.ORDER_HUB_PUBLIC_ORIGIN||`http://127.0.0.1:${server.address().port}`}`));
}
