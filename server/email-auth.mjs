import {createHash,createHmac,randomBytes,randomInt,timingSafeEqual} from 'node:crypto';
import {transaction} from './storage.mjs';
import {fault} from './model.mjs';

const TTL=600_000,COOLDOWN=60_000,WINDOW=3_600_000;
const digest=value=>createHash('sha256').update(value).digest('hex');
const equal=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
export function normalizeEmail(value){
  if(typeof value!=='string')fault('กรุณาระบุอีเมลที่ใช้งานได้');
  const email=value.trim().toLowerCase();
  if(email.length>254||!/^[-a-z0-9.!#$%&'*+/=?^_`{|}~]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(email)||email.split('@')[0].length>64||email.startsWith('.')||email.includes('..')||email.includes('.@'))fault('กรุณาระบุอีเมลที่ใช้งานได้');
  return email;
}

export function createResendEmailAuth(environment=process.env){
  const key=environment.RESEND_API_KEY,from=environment.ORDER_HUB_EMAIL_FROM,secret=environment.ORDER_HUB_EMAIL_OTP_SECRET;
  if(!key||!from||!secret||Buffer.byteLength(secret)<32||/[\r\n]/.test(from))return null;
  return {secret,sendOtp:async({email,code,purpose,storeCode,challengeId})=>{
    const label=purpose==='reset'?'ตั้งรหัสผ่านใหม่':purpose==='bind'?'ยืนยันอีเมลบัญชี':'ยืนยันอีเมลสมัครใช้งาน';
    let response;
    try{response=await fetch('https://api.resend.com/emails',{method:'POST',redirect:'error',signal:AbortSignal.timeout(10_000),headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json','Idempotency-Key':`order-hub-${challengeId}`},body:JSON.stringify({from,to:[email],subject:`Order Hub: ${label}`,text:`รหัส OTP สำหรับ${label}ใน Order Hub${storeCode?` ร้าน ${storeCode}`:''} คือ ${code}\nรหัสนี้ใช้ได้ 10 นาทีและใช้ได้ครั้งเดียว\nหากคุณไม่ได้ขอรหัสนี้ ไม่ต้องดำเนินการใด ๆ และอย่าส่งรหัสให้ผู้อื่น`})})}catch{throw new Error('Email delivery unavailable')}
    if(!response.ok)throw new Error('Email delivery unavailable');
  }};
}

// Jobs contain the one-time code only in process memory. Hosting adapters must
// run this after the durable snapshot commits; never serialize or log jobs.
export async function deliverEmailJobs(jobs){
  for(const job of jobs)try{await job()}catch{fault('ส่งอีเมลไม่สำเร็จ กรุณารอ 60 วินาทีแล้วขอ OTP ใหม่ หรือติดต่อผู้ดูแลระบบ',424)}
}

export function createEmailAuthService({db,configuration,now=()=>Date.now()}){
  if(configuration!==null&&configuration!==undefined&&(typeof configuration.sendOtp!=='function'||typeof configuration.secret!=='string'||Buffer.byteLength(configuration.secret)<32))throw new Error('Invalid email authentication configuration');
  const configured=!!configuration;
  const requireEnabled=()=>{if(!configured)throw Object.assign(new Error('ระบบยืนยันอีเมลยังไม่พร้อม กรุณาติดต่อผู้ดูแลเว็บไซต์'),{status:503,code:'EMAIL_NOT_CONFIGURED'})};
  const hashCode=(challenge,code)=>createHmac('sha256',configuration.secret).update(`${challenge.id}|${challenge.purpose}|${challenge.scope_hash}|${challenge.email}|${code}`).digest('hex');
  function cleanup(at){
    db.prepare('DELETE FROM email_challenges WHERE expires_at<?').run(at-WINDOW);
    db.prepare('DELETE FROM email_rate_limits WHERE started_at<?').run(at-WINDOW);
  }
  function currentAccount(challenge){
    if(!challenge.user_id)return null;
    return db.prepare('SELECT u.*,t.code store_code FROM users u JOIN tenants t ON t.id=u.tenant_id WHERE u.id=? AND u.tenant_id=? AND u.active=1 AND t.active=1').get(challenge.user_id,challenge.tenant_id)||null;
  }
  function accountMatches(challenge,actor){
    if(challenge.purpose==='signup')return true;
    const user=currentAccount(challenge);
    if(!user||digest(user.password_hash)!==challenge.account_version)return false;
    if(challenge.purpose==='bind')return actor?.id===user.id&&actor.tenant_id===user.tenant_id;
    return user.email===challenge.email&&!!user.email_verified_at;
  }
  function request({purpose,email,storeCode,username,user,ip=''}){
    requireEnabled();
    if(!['signup','reset','bind'].includes(purpose))fault('ประเภทการยืนยันอีเมลไม่ถูกต้อง');
    email=normalizeEmail(email);
    const scope=purpose==='bind'?`${user.tenant_id}|${user.id}`:`${storeCode}|${username}`;
    const scopeHash=digest(scope),at=now(),id=randomBytes(16).toString('hex');
    let allowed=true,limited=false,code,challenge;
    transaction(db,()=>{
      cleanup(at);
      const latest=db.prepare('SELECT created_at FROM email_challenges WHERE purpose=? AND scope_hash=? ORDER BY created_at DESC LIMIT 1').get(purpose,scopeHash);
      if(latest&&at-latest.created_at<COOLDOWN){allowed=false;limited=true;return}
      const keys=[['ip',ip,30],['email',email,10],['account',scope,10]];
      for(const [kind,value,limit]of keys){
        const key=digest(`email-request|${kind}|${value}`),row=db.prepare('SELECT * FROM email_rate_limits WHERE key=?').get(key);
        const count=row&&at-row.started_at<WINDOW?row.count:0;
        if(count>=limit)allowed=false;
        db.prepare('INSERT INTO email_rate_limits VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET count=excluded.count,started_at=excluded.started_at').run(key,count+1,count?row.started_at:at);
      }
      if(!allowed){limited=true;return}
      challenge={id,purpose,scope_hash:scopeHash,email,tenant_id:user?.tenant_id||null,user_id:user?.id||null,account_version:user?digest(user.password_hash):null};
      code=randomInt(0,1_000_000).toString().padStart(6,'0');
      db.prepare('UPDATE email_challenges SET used_at=? WHERE purpose=? AND scope_hash=? AND used_at IS NULL').run(at,purpose,scopeHash);
      db.prepare('INSERT INTO email_challenges(id,purpose,scope_hash,email,tenant_id,user_id,account_version,code_hash,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,purpose,scopeHash,email,challenge.tenant_id,challenge.user_id,challenge.account_version,hashCode(challenge,code),at+TTL,at);
    });
    // Recovery always reports the same shape, including unknown accounts and
    // limits. A random unusable ID does not reveal whether the mailbox exists.
    if(limited&&purpose!=='reset')fault('ขอ OTP บ่อยเกินไป กรุณารออย่างน้อย 60 วินาทีแล้วลองใหม่',429);
    const send=allowed&&(purpose!=='reset'||user);
    const job=send?async()=>{try{await configuration.sendOtp({email,code,purpose,storeCode,challengeId:id})}catch(error){if(purpose!=='reset')throw error}}:null;
    return {job,data:{ok:true,challengeId:id,expiresIn:TTL/1000,resendAfter:COOLDOWN/1000,message:purpose==='reset'?'หากข้อมูลตรงกับบัญชีที่ยืนยันอีเมลแล้ว ระบบจะส่ง OTP ไปยังอีเมลนั้น':'ส่ง OTP ไปยังอีเมลแล้ว กรุณาตรวจกล่องจดหมายและสแปม'}};
  }
  function verify({challengeId,code,actor}){
    requireEnabled();
    if(typeof challengeId!=='string'||!/^[a-f0-9]{32}$/.test(challengeId))fault('OTP ไม่ถูกต้องหรือหมดอายุ');
    const at=now();let token,valid=false;
    transaction(db,()=>{
      const challenge=db.prepare('SELECT * FROM email_challenges WHERE id=?').get(challengeId);
      if(!challenge||challenge.used_at||challenge.verified_at||challenge.expires_at<=at||challenge.attempts>=5)return;
      db.prepare('UPDATE email_challenges SET attempts=attempts+1 WHERE id=?').run(challenge.id);
      if(typeof code!=='string'||!/^\d{6}$/.test(code)||!accountMatches(challenge,actor)||!equal(challenge.code_hash,hashCode(challenge,code)))return;
      token=randomBytes(32).toString('hex');
      db.prepare('UPDATE email_challenges SET proof_hash=?,verified_at=?,code_hash=NULL WHERE id=?').run(digest(token),at,challenge.id);valid=true;
    });
    if(!valid)fault('OTP ไม่ถูกต้องหรือหมดอายุ');
    return {ok:true,verificationToken:token};
  }
  // Consume inside the caller's transaction, after its final authorization and
  // uniqueness checks. Any account/stock mutation failure rolls consumption back.
  function checkProof({purpose,email,storeCode,username,verificationToken,actor}){
    requireEnabled();email=normalizeEmail(email);
    if(typeof verificationToken!=='string'||!/^[a-f0-9]{64}$/.test(verificationToken))fault('กรุณายืนยันอีเมลด้วย OTP ก่อนดำเนินการ');
    const scope=purpose==='bind'?`${actor.tenant_id}|${actor.id}`:`${storeCode}|${username}`,at=now();
    const challenge=db.prepare('SELECT * FROM email_challenges WHERE proof_hash=?').get(digest(verificationToken));
    if(!challenge||challenge.purpose!==purpose||challenge.email!==email||challenge.scope_hash!==digest(scope)||!challenge.verified_at||challenge.used_at||challenge.expires_at<=at||!accountMatches(challenge,actor))fault('การยืนยันอีเมลไม่ถูกต้องหรือหมดอายุ กรุณาขอ OTP ใหม่');
    return {challenge,email,verifiedAt:at,userId:challenge.user_id,tenantId:challenge.tenant_id};
  }
  function consume(details){const verified=checkProof(details);db.prepare('UPDATE email_challenges SET used_at=? WHERE id=? AND used_at IS NULL').run(verified.verifiedAt,verified.challenge.id);return {email:verified.email,verifiedAt:verified.verifiedAt,userId:verified.userId,tenantId:verified.tenantId}}
  function revokeUser(userId){db.prepare('UPDATE email_challenges SET used_at=? WHERE user_id=? AND used_at IS NULL').run(now(),userId)}
  return {configured,request,verify,checkProof,consume,revokeUser,requireEnabled};
}
