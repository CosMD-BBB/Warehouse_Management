// Offline operator utility. This module is never routed by the web server.
// An operator must already control the actual database and its credentials.
import fs from 'node:fs/promises';
import {constants as fsConstants} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync,backup} from 'node:sqlite';
import {randomBytes,scrypt} from 'node:crypto';
import {promisify} from 'node:util';
import {StringDecoder} from 'node:string_decoder';
import {createInterface} from 'node:readline/promises';
import {createPostgresSnapshotStore} from '../server/demo-postgres.mjs';

const scryptAsync=promisify(scrypt),sqliteHeader=Buffer.from('SQLite format 3\0');
export class RecoveryError extends Error {}
const fail=message=>{throw new RecoveryError(message)};
const ownerUid=()=>typeof process.getuid==='function'?process.getuid():fail('ต้องใช้ระบบที่รองรับสิทธิ์ไฟล์ POSIX');

function targetFields({storeCode,username,confirmation}){
  if(typeof storeCode!=='string'||!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(storeCode)||storeCode.length<3||storeCode.length>40)fail('ระบุรหัสร้านให้ถูกต้อง');
  if(typeof username!=='string'||!/^[a-z0-9._-]{3,40}$/.test(username))fail('ระบุชื่อผู้ใช้ให้ถูกต้อง');
  if(confirmation!==storeCode+'/'+username)fail('ยกเลิก: ไม่ได้ยืนยันรหัสร้านและชื่อผู้ใช้ตรงกัน');
  return {storeCode,username};
}
export function validateRecoveryPassword(password){
  if(typeof password!=='string'||password.length<6||password.length>128||/[\u0000-\u001f\u007f]/.test(password))fail('กำหนดรหัสผ่านใหม่ 6–128 ตัวอักษร โดยไม่มีอักขระควบคุม');
  return password;
}
export async function recoveryPasswordHash(password){
  validateRecoveryPassword(password);
  const salt=randomBytes(16).toString('hex'),hash=await scryptAsync(password,salt,64,{N:32768,r:8,p:1,maxmem:64*1024*1024});
  return salt+':'+hash.toString('hex');
}

async function existingFile(file){
  if(typeof file!=='string'||!path.isAbsolute(file))fail('ระบุเส้นทางไฟล์แบบเต็ม');
  let value;try{value=await fs.lstat(file)}catch{fail('ไม่พบไฟล์ที่ระบุ')}
  if(!value.isFile()||value.isSymbolicLink()||value.nlink!==1)fail('ไฟล์ต้องเป็นไฟล์ธรรมดาที่ไม่มี symlink หรือ hardlink');
  return value;
}
async function privateParent(file){
  if(typeof file!=='string'||!path.isAbsolute(file))fail('ระบุเส้นทางสำรองข้อมูลแบบเต็ม');
  const parent=path.dirname(file);let info;
  try{info=await fs.lstat(parent)}catch{fail('สร้างโฟลเดอร์สำรองข้อมูลส่วนตัวก่อน')}
  if(!info.isDirectory()||info.isSymbolicLink()||info.uid!==ownerUid()||(info.mode&0o777)!==0o700)fail('โฟลเดอร์สำรองต้องเป็นของผู้รันคำสั่งและมีสิทธิ์ 0700');
  try{await fs.lstat(file);fail('ไฟล์สำรองมีอยู่แล้ว: เลือกชื่อใหม่เพื่อไม่เขียนทับ')}catch(error){if(error instanceof RecoveryError)throw error;if(error.code!=='ENOENT')throw error}
  return parent;
}
async function syncDirectory(directory){const handle=await fs.open(directory,fsConstants.O_RDONLY);try{await handle.sync()}finally{await handle.close()}}

export async function readRecoveryPasswordFile(file){
  await existingFile(file);
  const handle=await fs.open(file,fsConstants.O_RDONLY|fsConstants.O_NOFOLLOW);
  try{
    const info=await handle.stat();
    if(!info.isFile()||info.nlink!==1||info.uid!==ownerUid()||(info.mode&0o777)!==0o600||info.size>1024)fail('ไฟล์รหัสผ่านต้องเป็นของผู้รันคำสั่ง มีสิทธิ์ 0600 และมีรหัสผ่านเพียงหนึ่งบรรทัด');
    let value=await handle.readFile({encoding:'utf8'});
    if(value.endsWith('\r\n'))value=value.slice(0,-2);else if(value.endsWith('\n'))value=value.slice(0,-1);
    return validateRecoveryPassword(value);
  }finally{await handle.close()}
}

export function promptHiddenPassword({input=process.stdin,output=process.stdout,label='รหัสผ่านใหม่: '}={}){
  if(!input.isTTY||typeof input.setRawMode!=='function')fail('ต้องใช้ terminal แบบ interactive หรือ --password-file ที่มีสิทธิ์ 0600');
  return new Promise((resolve,reject)=>{
    let value='',finished=false;const decoder=new StringDecoder('utf8'),wasRaw=!!input.isRaw,wasPaused=input.isPaused();
    const finish=(error)=>{
      if(finished)return;finished=true;input.off('data',data);input.off('end',end);input.off('error',errorEvent);
      input.setRawMode(wasRaw);if(wasPaused)input.pause();output.write('\n');
      if(error)reject(error);else resolve(value);
    };
    const end=()=>finish(new RecoveryError('ยกเลิกการกู้คืน'));
    const errorEvent=()=>finish(new RecoveryError('อ่านรหัสผ่านไม่สำเร็จ'));
    const data=chunk=>{
      for(const char of typeof chunk==='string'?chunk:decoder.write(chunk)){
        if(char==='\u0003'||char==='\u0004'){finish(new RecoveryError('ยกเลิกการกู้คืน'));return}
        if(char==='\r'||char==='\n'){finish();return}
        if(char==='\u007f'||char==='\b'){value=Array.from(value).slice(0,-1).join('');continue}
        if(!/[\u0000-\u001f]/.test(char))value+=char;
        if(value.length>128){finish(new RecoveryError('รหัสผ่านยาวเกิน 128 ตัวอักษร'));return}
      }
    };
    input.on('data',data);input.once('end',end);input.once('error',errorEvent);
    output.write(label);input.setRawMode(true);input.resume();
  });
}

function checkSchema(db){
  if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='public_demo_meta'").get())fail('ปฏิเสธฐานข้อมูลผู้ทดลองสาธารณะ: เครื่องมือนี้ใช้กับบัญชีจริงเท่านั้น');
  const required={tenants:['id','code','active'],users:['id','tenant_id','username','password_hash','role','active'],sessions:['user_id'],security_audit:['at','tenant_id','actor_id','action','target_id']};
  for(const [table,columns]of Object.entries(required)){
    const actual=db.prepare('PRAGMA table_info('+table+')').all().map(column=>column.name);
    if(columns.some(column=>!actual.includes(column)))fail('รูปแบบฐานข้อมูลไม่รองรับ: กู้คืนสำรองหรืออัปเดตระบบก่อน โดยไม่สร้างบัญชีใหม่ทับ');
  }
}
function findOwner(db,{storeCode,username}){
  checkSchema(db);
  const user=db.prepare("SELECT u.* FROM users u JOIN tenants t ON t.id=u.tenant_id WHERE t.code=? AND t.active=1 AND u.username=? AND u.active=1 AND u.role='admin'").get(storeCode,username);
  if(!user)fail('ไม่พบบัญชี Admin ที่ใช้งานอยู่ในร้านและชื่อผู้ใช้นี้: ไม่มีการเปลี่ยนข้อมูล');
  return user;
}
function changeOwner(db,target,hash,expected){
  const user=findOwner(db,target);
  if(expected&&(user.id!==expected.id||user.password_hash!==expected.password_hash||user.tenant_id!==expected.tenant_id))fail('บัญชีเปลี่ยนระหว่างดำเนินการ: ยกเลิกเพื่อรักษาข้อมูลล่าสุด');
  const updated=db.prepare("UPDATE users SET password_hash=? WHERE id=? AND tenant_id=? AND active=1 AND role='admin'").run(hash,user.id,user.tenant_id);
  if(updated.changes!==1)fail('บัญชีเปลี่ยนแล้ว: ไม่มีการเปลี่ยนข้อมูล');
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);
  if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='email_challenges'").get())db.prepare('UPDATE email_challenges SET used_at=? WHERE user_id=? AND tenant_id=? AND used_at IS NULL').run(Date.now(),user.id,user.tenant_id);
  db.prepare('INSERT INTO security_audit(at,tenant_id,actor_id,action,target_id) VALUES(?,?,?,?,?)').run(new Date().toISOString(),user.tenant_id,null,'owner_operator_recovery',user.id);
  return {storeCode:target.storeCode,username:target.username,userId:user.id};
}

async function durableSqliteBackup(db,backupFile){
  const parent=await privateParent(backupFile),temporary=await fs.mkdtemp(path.join(parent,'.recovery-backup-'));
  try{
    await fs.chmod(temporary,0o700);const working=path.join(temporary,'before.sqlite');
    await backup(db,working);await fs.chmod(working,0o600);
    const file=await fs.open(working,fsConstants.O_RDONLY);try{await file.sync()}finally{await file.close()}
    await fs.link(working,backupFile);await syncDirectory(parent);
  }finally{await fs.rm(temporary,{recursive:true,force:true})}
}

export async function recoverSqliteOwner(options){
  const target=targetFields(options);validateRecoveryPassword(options.password);
  const original=await existingFile(options.dbPath);await privateParent(options.backupFile);
  if(path.resolve(options.dbPath)===path.resolve(options.backupFile))fail('ไฟล์สำรองต้องแยกจากฐานข้อมูล');
  let db,reader,transaction=false;
  try{
    db=new DatabaseSync(options.dbPath);db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
    const expected=findOwner(db,target),hash=await recoveryPasswordHash(options.password);
    const current=await existingFile(options.dbPath);if(current.ino!==original.ino||current.dev!==original.dev)fail('ไฟล์ฐานข้อมูลเปลี่ยนระหว่างดำเนินการ');
    db.exec('BEGIN IMMEDIATE');transaction=true;const locked=findOwner(db,target);
    if(locked.id!==expected.id||locked.password_hash!==expected.password_hash||locked.tenant_id!==expected.tenant_id)fail('บัญชีเปลี่ยนระหว่างดำเนินการ: ยกเลิกเพื่อรักษาข้อมูลล่าสุด');
    // A separate read-only source sees the committed before-image while this
    // writer holds the lock. The SQLite backup API includes committed WAL data.
    reader=new DatabaseSync(options.dbPath,{readOnly:true});await durableSqliteBackup(reader,options.backupFile);reader.close();reader=undefined;
    const result=changeOwner(db,target,hash,expected);db.exec('COMMIT');transaction=false;
    return {...result,backupFile:options.backupFile};
  }catch(error){if(transaction)try{db.exec('ROLLBACK')}catch{}throw error}
  finally{try{reader?.close()}finally{db?.close()}}
}

export async function recoverPostgresOwner(options){
  const target=targetFields(options);validateRecoveryPassword(options.password);await privateParent(options.backupFile);
  if(typeof options.namespace!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$/.test(options.namespace))fail('ระบุ namespace ของบัญชีจริงอย่างชัดเจน ห้ามเดาจาก URL');
  if(/^public-demo(?:[._-]|$)/i.test(options.namespace))fail('ปฏิเสธ namespace ผู้ทดลองสาธารณะ');
  const hash=await recoveryPasswordHash(options.password);
  const store=options.store||createPostgresSnapshotStore({connectionString:options.connectionString,namespace:options.namespace});
  try{
    return await store.transaction(async({snapshot,attempts})=>{
      if(!Buffer.isBuffer(snapshot)||snapshot.length<100||snapshot.length>10*1024*1024||!snapshot.subarray(0,16).equals(sqliteHeader))fail('ไม่พบบัญชีเดิมใน namespace นี้ หรือ snapshot ไม่ถูกต้อง: ห้ามสร้างบัญชีใหม่ทับ');
      const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'order-hub-owner-recovery-'));let db;
      try{
        await fs.chmod(temporary,0o700);const file=path.join(temporary,'account.sqlite');await fs.writeFile(file,snapshot,{mode:0o600,flag:'wx'});
        db=new DatabaseSync(file);db.exec('PRAGMA foreign_keys=ON;');const expected=findOwner(db,target);
        // The immutable backup is durable before any mutation or PG commit.
        await durableSqliteBackup(db,options.backupFile);
        db.exec('BEGIN IMMEDIATE');let result;
        try{result=changeOwner(db,target,hash,expected);db.exec('COMMIT')}catch(error){try{db.exec('ROLLBACK')}catch{}throw error}
        const next=path.join(temporary,'after.sqlite');await backup(db,next);await fs.chmod(next,0o600);
        return {snapshot:await fs.readFile(next),attempts,result:{...result,backupFile:options.backupFile}};
      }finally{try{db?.close()}finally{await fs.rm(temporary,{recursive:true,force:true})}}
    });
  }finally{if(!options.store)await store.close()}
}

export function parseRecoveryArguments(argv){
  const result={},values=new Map([['--sqlite','dbPath'],['--namespace','namespace'],['--store','storeCode'],['--username','username'],['--backup-file','backupFile'],['--password-file','passwordFile'],['--confirm','confirmation']]);
  for(let index=0;index<argv.length;index++){
    const flag=argv[index];if(flag==='--help'){result.help=true;continue}if(flag==='--postgres'){if(result.postgres)fail('ระบุ --postgres ซ้ำ');result.postgres=true;continue}
    const key=values.get(flag);if(!key||result[key]!==undefined||!argv[index+1]||argv[index+1].startsWith('--'))fail('ตัวเลือกคำสั่งไม่ถูกต้อง: ใช้ --help (ห้ามส่งรหัสผ่านเป็น argument)');result[key]=argv[++index];
  }
  if(result.help)return result;
  if(!!result.dbPath===!!result.postgres)fail('เลือก --sqlite หรือ --postgres อย่างใดอย่างหนึ่ง');
  if(!result.storeCode||!result.username||!result.backupFile)fail('ต้องระบุ --store --username และ --backup-file โดยไม่มีบัญชีหรือรหัสผ่านเริ่มต้น');
  if(result.postgres&&!result.namespace)fail('Postgres ต้องระบุ --namespace ให้ตรงค่าที่ใช้กับบัญชีเดิม');
  if(result.passwordFile&&!result.confirmation)fail('--password-file ต้องใช้ --confirm รหัสร้าน/ชื่อผู้ใช้');
  return result;
}

export async function runOwnerRecovery(argv=process.argv.slice(2),{environment=process.env,input=process.stdin,output=process.stdout}={}){
  const options=parseRecoveryArguments(argv);
  if(options.help){output.write('Order Hub — กู้คืน Admin โดยผู้ดูแลฐานข้อมูลเท่านั้น\nnode scripts/recover-owner.mjs --sqlite /absolute/account.sqlite --store store-code --username owner --backup-file /private/backups/before.sqlite\nหรือ --postgres --namespace exact-private-namespace (ใช้ ORDER_HUB_DEMO_DATABASE_URL / DATABASE_URL / POSTGRES_URL จาก secret environment)\nไม่รับรหัสผ่านผ่าน argument หรือ environment; ระบุเองใน terminal หรือ --password-file /private/password.txt --confirm store-code/owner\nอ่าน ACCOUNT_RECOVERY.md ก่อนใช้\n');return}
  if(!options.confirmation){
    if(!input.isTTY)fail('ต้องยืนยันใน terminal หรือใช้ --confirm รหัสร้าน/ชื่อผู้ใช้ ร่วมกับไฟล์รหัสผ่าน 0600');
    const readline=createInterface({input,output});try{options.confirmation=await readline.question('ยืนยันบัญชีโดยพิมพ์ '+options.storeCode+'/'+options.username+' (อื่น ๆ = ยกเลิก): ')}finally{readline.close()}
  }
  targetFields(options);
  let password;
  try{
    password=options.passwordFile?await readRecoveryPasswordFile(options.passwordFile):await promptHiddenPassword({input,output});validateRecoveryPassword(password);
    if(!options.passwordFile&&password!==await promptHiddenPassword({input,output,label:'รหัสผ่านใหม่อีกครั้ง: '}))fail('รหัสผ่านสองครั้งไม่ตรงกัน: ยกเลิก');
    const result=options.postgres?await recoverPostgresOwner({...options,password,connectionString:environment.ORDER_HUB_DEMO_DATABASE_URL||environment.DATABASE_URL||environment.POSTGRES_URL}):await recoverSqliteOwner({...options,password});
    output.write('กู้คืนรหัสผ่านแล้วสำหรับ '+result.storeCode+'/'+result.username+' และยกเลิก session เดิม\nสำรองข้อมูลก่อนเปลี่ยน: '+result.backupFile+'\nไม่มีการเพิ่มหรือยืนยันอีเมล ให้เข้าสู่ระบบแล้วผูกอีเมลผ่าน OTP\n');return result;
  }finally{password=undefined}
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  runOwnerRecovery().catch(error=>{process.stderr.write((error instanceof RecoveryError?error.message:'กู้คืนไม่สำเร็จ ไม่มีการยืนยันการเปลี่ยนบัญชี: ตรวจฐานข้อมูลและไฟล์สำรองกับผู้ดูแล ห้ามเผย connection string หรือรหัสผ่าน')+'\n');process.exitCode=1});
}
