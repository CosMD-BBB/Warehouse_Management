// Terminal-only recovery for an operator who already controls the private DB.
// No HTTP route, credential argument, default password, or email binding.
import fs from 'node:fs/promises';
import {constants as fsConstants} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {randomBytes} from 'node:crypto';
import {createInterface} from 'node:readline/promises';
import {RecoveryError,promptHiddenPassword,recoverPostgresOwner,validateRecoveryPassword} from './recover-owner.mjs';

const maxRows=100,maxSnapshotBytes=10*1024*1024;
const sqliteHeader=Buffer.from('SQLite format 3\0');
const namespacePattern=/^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$/;
const repositoryRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const fail=message=>{throw new RecoveryError(message)};
const within=(directory,parent)=>directory===parent||directory.startsWith(parent+path.sep);

function validateTarget({storeCode,username}){
  if(typeof storeCode!=='string'||!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(storeCode)||storeCode.length<3||storeCode.length>40)fail('ระบุรหัสร้านให้ถูกต้อง');
  if(typeof username!=='string'||!/^[a-z0-9._-]{3,40}$/.test(username))fail('ระบุชื่อผู้ใช้ให้ถูกต้อง');
  return {storeCode,username};
}

export function parseWizardArguments(argv){
  const options={};
  for(let index=0;index<argv.length;index++){
    const flag=argv[index];
    if(flag==='--help'){options.help=true;continue}
    const key=flag==='--store'?'storeCode':flag==='--username'?'username':null;
    if(!key||options[key]!==undefined||!argv[index+1]||argv[index+1].startsWith('--'))fail('ตัวเลือกไม่ถูกต้อง: ใช้ --help และห้ามส่งข้อมูลลับเป็น argument');
    options[key]=argv[++index];
  }
  if(options.help)return options;
  if(!!options.storeCode!==!!options.username)fail('ระบุ --store และ --username คู่กัน หรือไม่ระบุทั้งสองเพื่อกรอกใน terminal');
  if(options.storeCode)validateTarget(options);
  return options;
}

export function postgresRecoveryConfiguration(connectionString){
  let url;
  try{
    if(typeof connectionString!=='string'||connectionString.length>4096||/\s|\\/.test(connectionString))throw new Error();
    url=new URL(connectionString);
    if(!['postgres:','postgresql:'].includes(url.protocol)||!url.hostname||url.hostname.includes('*')||!url.username||!url.password||url.pathname.length<2||url.hash)throw new Error();
    if(/[\u0000-\u001f\u007f]/.test(decodeURIComponent(url.username)+decodeURIComponent(url.password)+decodeURIComponent(url.pathname)))throw new Error();
  }catch{fail('ต้องใช้ PostgreSQL connection URL ที่มีบัญชี รหัส และชื่อฐานข้อมูลจากผู้ให้บริการ โดยกรอกในช่องที่ซ่อนข้อความเท่านั้น')}
  // pg lets SSL query parameters override ssl. Remove every such parameter
  // before requiring certificate-verified TLS; never honor insecure overrides.
  for(const name of [...url.searchParams.keys()])if(name.toLowerCase().startsWith('ssl'))url.searchParams.delete(name);
  return {connectionString:url.toString(),ssl:{rejectUnauthorized:true}};
}

function inspectSnapshot(db,target){
  if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='public_demo_meta'").get())return false;
  const version=db.prepare('PRAGMA user_version').get().user_version;
  if(![3,4].includes(version))fail('พบรูปแบบฐานข้อมูลที่ยังไม่รองรับ: ไม่มีการเปลี่ยนข้อมูล');
  if(db.prepare('PRAGMA quick_check').get().quick_check!=='ok')fail('พบ snapshot ที่ไม่สมบูรณ์: ไม่มีการเปลี่ยนข้อมูล');
  const required={tenants:['id','code','active'],users:['id','tenant_id','username','password_hash','role','active'],sessions:['user_id'],security_audit:['at','tenant_id','actor_id','action','target_id']};
  for(const [table,columns]of Object.entries(required)){
    const actual=db.prepare('PRAGMA table_info('+table+')').all().map(column=>column.name);
    if(columns.some(column=>!actual.includes(column)))fail('พบรูปแบบฐานข้อมูลที่ยังไม่รองรับ: ไม่มีการเปลี่ยนข้อมูล');
  }
  const found=db.prepare("SELECT u.id FROM users u JOIN tenants t ON t.id=u.tenant_id WHERE t.code=? AND t.active=1 AND u.username=? AND u.active=1 AND u.role='admin' LIMIT 2").all(target.storeCode,target.username);
  if(found.length>1)fail('บัญชีใน snapshot ไม่เป็นเอกลักษณ์: ไม่มีการเปลี่ยนข้อมูล');
  return found.length===1;
}

export async function discoverOwnerSnapshots({pool,storeCode,username,temporaryDirectory=os.tmpdir()}){
  const target=validateTarget({storeCode,username});
  let client,directory,transaction=false;
  try{
    client=await pool.connect();
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');transaction=true;
    await client.query("SET LOCAL statement_timeout = '20s'");
    const limits=(await client.query('SELECT count(*) AS count, max(octet_length(snapshot)) AS max_bytes FROM order_hub_demo_snapshots')).rows[0];
    const count=Number(limits?.count),bytes=Number(limits?.max_bytes||0);
    if(!Number.isSafeInteger(count)||count<0||count>maxRows||!Number.isSafeInteger(bytes)||bytes<0||bytes>maxSnapshotBytes)fail('จำนวนหรือขนาด snapshot เกินขอบเขตที่ตรวจได้: ไม่มีการเปลี่ยนข้อมูล');
    // List only small metadata first. Each snapshot is fetched and inspected
    // separately so 100 rows can never materialize up to 1 GiB at once.
    const rows=(await client.query('SELECT namespace, octet_length(snapshot) AS snapshot_bytes, updated_at FROM order_hub_demo_snapshots ORDER BY namespace LIMIT 100')).rows;
    if(!Array.isArray(rows)||rows.length>maxRows||rows.length!==count)fail('รายการ snapshot ไม่สมบูรณ์: ไม่มีการเปลี่ยนข้อมูล');
    directory=await fs.mkdtemp(path.join(temporaryDirectory,'order-hub-recovery-discovery-'));await fs.chmod(directory,0o700);
    const matches=[],seen=new Set();
    for(const metadata of rows){
      if(typeof metadata.namespace!=='string'||!namespacePattern.test(metadata.namespace)||seen.has(metadata.namespace))fail('พบ namespace ที่ไม่ถูกต้อง: ไม่มีการเปลี่ยนข้อมูล');
      seen.add(metadata.namespace);
      if(/^public-demo(?:[._-]|$)/i.test(metadata.namespace)||metadata.snapshot_bytes===null)continue;
      const size=Number(metadata.snapshot_bytes);
      if(!Number.isSafeInteger(size)||size<100||size>maxSnapshotBytes)fail('พบ snapshot ที่ไม่สมบูรณ์: ไม่มีการเปลี่ยนข้อมูล');
      const selected=(await client.query('SELECT namespace, snapshot, updated_at FROM order_hub_demo_snapshots WHERE namespace=$1',[metadata.namespace])).rows;
      if(!Array.isArray(selected)||selected.length!==1||selected[0].namespace!==metadata.namespace)fail('รายการ snapshot ไม่สมบูรณ์: ไม่มีการเปลี่ยนข้อมูล');
      const row=selected[0];
      if(!Buffer.isBuffer(row.snapshot)||row.snapshot.length<100||row.snapshot.length>maxSnapshotBytes||!row.snapshot.subarray(0,16).equals(sqliteHeader))fail('พบ snapshot ที่ไม่สมบูรณ์: ไม่มีการเปลี่ยนข้อมูล');
      if(row.snapshot.length!==size)fail('รายการ snapshot เปลี่ยนระหว่างตรวจ: ไม่มีการเปลี่ยนข้อมูล');
      const updated=new Date(row.updated_at);
      if(!['string','object'].includes(typeof row.updated_at)||row.updated_at===null||!Number.isFinite(updated.getTime()))fail('วันที่ของ snapshot ไม่ถูกต้อง: ไม่มีการเปลี่ยนข้อมูล');
      const file=path.join(directory,randomBytes(16).toString('hex')+'.sqlite');let db;
      try{
        await fs.writeFile(file,row.snapshot,{mode:0o600,flag:'wx'});
        db=new DatabaseSync(file,{readOnly:true});
        if(inspectSnapshot(db,target))matches.push({namespace:row.namespace,updatedAt:updated.toISOString(),...target});
      }finally{try{db?.close()}finally{await fs.rm(file,{force:true})}}
    }
    await client.query('COMMIT');transaction=false;
    return matches;
  }catch(error){
    if(transaction)try{await client.query('ROLLBACK')}catch{}
    if(error instanceof RecoveryError)throw error;
    fail('ตรวจฐานข้อมูลไม่สำเร็จ: ตรวจสิทธิ์ การเชื่อมต่อ และตารางเดิมกับผู้ดูแล ไม่มีการเปลี่ยนข้อมูล');
  }finally{
    try{client?.release()}finally{if(directory)await fs.rm(directory,{recursive:true,force:true})}
  }
}

export async function ensurePrivateBackupDirectory({homeDirectory=os.homedir(),repositoryRoot:repo=repositoryRoot}={}){
  if(typeof process.getuid!=='function')fail('ต้องใช้เครื่องที่รองรับสิทธิ์ไฟล์ POSIX');
  if(typeof homeDirectory!=='string'||!path.isAbsolute(homeDirectory))fail('ต้องใช้โฟลเดอร์บ้านบนดิสก์ถาวรของผู้ดูแล');
  const home=path.resolve(homeDirectory),directory=path.join(home,'.order-hub-backups');
  let homeInfo,realHome;
  try{homeInfo=await fs.lstat(home);realHome=await fs.realpath(home)}catch{fail('ไม่พบโฟลเดอร์บ้านส่วนตัวของผู้ดูแล')}
  if(!homeInfo.isDirectory()||homeInfo.isSymbolicLink()||homeInfo.uid!==process.getuid()||(homeInfo.mode&0o022)!==0||realHome!==home)fail('โฟลเดอร์บ้านต้องเป็นของผู้รันคำสั่ง ไม่มี symlink และไม่ให้ผู้อื่นเขียนในเส้นทาง');
  const forbidden=[path.resolve(repo)];
  for(const root of [os.tmpdir(),'/tmp','/private/tmp','/var/tmp']){
    forbidden.push(path.resolve(root));try{forbidden.push(await fs.realpath(root))}catch{}
  }
  if(forbidden.some(root=>within(directory,root)))fail('สำรองต้องอยู่นอก repository และโฟลเดอร์ชั่วคราวบนดิสก์ถาวร');
  try{await fs.mkdir(directory,{mode:0o700})}catch(error){if(error.code!=='EEXIST')fail('สร้างโฟลเดอร์สำรองส่วนตัวไม่สำเร็จ')}
  let info;
  try{info=await fs.lstat(directory)}catch{fail('ตรวจโฟลเดอร์สำรองไม่สำเร็จ')}
  if(!info.isDirectory()||info.isSymbolicLink()||info.uid!==process.getuid()||(info.mode&0o777)!==0o700||await fs.realpath(directory)!==directory)fail('โฟลเดอร์สำรองต้องเป็นของผู้รันคำสั่ง มีสิทธิ์ 0700 และไม่มี symlink');
  const handle=await fs.open(home,fsConstants.O_RDONLY|fsConstants.O_NOFOLLOW);try{await handle.sync()}finally{await handle.close()}
  return directory;
}

async function defaultPool(configuration){
  const {Pool}=await import('pg');
  const pool=new Pool({...configuration,max:1,connectionTimeoutMillis:5000,idleTimeoutMillis:10000,application_name:'order-hub-owner-recovery'});
  // Idle connection failures may contain provider details. Active queries still
  // fail into the sanitized recovery error path; never dump idle errors.
  pool.on('error',()=>{});
  return pool;
}

async function terminalQuestion(label,{input,output}){
  const readline=createInterface({input,output}),controller=new AbortController();
  const cancel=()=>controller.abort();
  readline.once('SIGINT',cancel);readline.once('close',cancel);
  try{return await readline.question(label,{signal:controller.signal})}
  catch{fail('ยกเลิกการกู้คืน')}
  finally{readline.close()}
}

export async function runOwnerRecoveryWizard(argv=process.argv.slice(2),{
  environment=process.env,input=process.stdin,output=process.stdout,
  createPool=defaultPool,promptText,promptHidden=promptHiddenPassword,
  recoverOwner=recoverPostgresOwner,ensureBackupDirectory=ensurePrivateBackupDirectory,
  homeDirectory=os.homedir(),temporaryDirectory=os.tmpdir()
}={}){
  const options=parseWizardArguments(argv);
  if(options.help){output.write('Order Hub — กู้ Admin ผ่าน PostgreSQL โดยผู้ดูแลฐานข้อมูล\nnode scripts/recover-owner-wizard.mjs [--store store-code --username owner]\nกรอก connection URL ในช่องซ่อนข้อความ หรือใช้ secret environment เดิม\nต้องเลือก namespace ที่ตรง deployment และยืนยันบัญชีก่อนเปลี่ยนรหัส\nสำรองใน ~/.order-hub-backups บนเครื่องผู้ดูแล ไม่มีรหัสผ่านเริ่มต้น\n');return}
  if(!input.isTTY)fail('ต้องใช้ terminal แบบ interactive บนเครื่องผู้ดูแลฐานข้อมูล');
  const ask=promptText||((label)=>terminalQuestion(label,{input,output}));
  let pool,password,connectionString;
  try{
    output.write('เครื่องมือนี้ใช้สิทธิ์ฐานข้อมูลของเจ้าของโปรเจกต์ และสำรองก่อนเปลี่ยนบัญชี\nอย่าส่ง connection URL หรือรหัสผ่านในแชต และอย่ารันใน terminal ที่ผู้อื่นดูได้\n');
    if(!options.storeCode){options.storeCode=(await ask('รหัสร้าน: ')).trim();options.username=(await ask('ชื่อผู้ใช้ Admin: ')).trim()}
    validateTarget(options);
    connectionString=environment.ORDER_HUB_DEMO_DATABASE_URL||environment.DATABASE_URL||environment.POSTGRES_URL;
    if(!connectionString)connectionString=await promptHidden({input,output,label:'PostgreSQL connection URL (ซ่อนข้อความ): ',maxLength:4096});
    const configuration=postgresRecoveryConfiguration(connectionString);connectionString=configuration.connectionString;
    output.write('กำลังตรวจบัญชีแบบอ่านอย่างเดียวจาก '+new URL(connectionString).hostname+' ผ่าน TLS\n');
    pool=await createPool(configuration);
    const matches=await discoverOwnerSnapshots({pool,...options,temporaryDirectory});
    if(!matches.length)fail('ไม่พบบัญชี Admin ที่ใช้งานอยู่ตรงรหัสร้านและชื่อผู้ใช้นี้ ไม่มีการเปลี่ยนข้อมูล');
    output.write('บัญชีที่ตรงกัน — ตรวจ namespace ให้ตรง deployment ที่ต้องการกู้\n');
    matches.forEach((entry,index)=>output.write((index+1)+'. '+entry.namespace+' | '+entry.updatedAt+' | '+entry.storeCode+'/'+entry.username+'\n'));
    output.write('หากไม่ทราบว่า deployment ใช้ namespace ใด ให้ยกเลิกและตรวจค่าจาก Vercel ก่อน ไม่เลือกจากวันที่เพียงอย่างเดียว\n');
    const selection=(await ask('เลือกหมายเลขหนึ่งรายการ (เว้นว่าง = ยกเลิก): ')).trim();
    if(!/^[1-9][0-9]*$/.test(selection)||Number(selection)>matches.length)fail('ยกเลิก: ไม่ได้เลือก namespace ที่ตรง deployment อย่างชัดเจน');
    const selected=matches[Number(selection)-1];
    output.write('เลือก namespace: '+selected.namespace+'\nอัปเดต (UTC): '+selected.updatedAt+'\nบัญชี: '+selected.storeCode+'/'+selected.username+'\n');
    const confirmation=(await ask('ยืนยันโดยพิมพ์ '+selected.storeCode+'/'+selected.username+' (อื่น ๆ = ยกเลิก): ')).trim();
    if(confirmation!==selected.storeCode+'/'+selected.username)fail('ยกเลิก: ไม่ได้ยืนยันบัญชีตรงกัน');
    const backupDirectory=await ensureBackupDirectory({homeDirectory});
    password=await promptHidden({input,output,label:'รหัสผ่านใหม่ (6–128 ตัวอักษร): '});validateRecoveryPassword(password);
    if(password!==await promptHidden({input,output,label:'รหัสผ่านใหม่อีกครั้ง: '}))fail('รหัสผ่านสองครั้งไม่ตรงกัน: ไม่มีการเปลี่ยนข้อมูล');
    const backupFile=path.join(backupDirectory,'before-owner-recovery-'+Date.now()+'-'+randomBytes(12).toString('hex')+'.sqlite');
    const result=await recoverOwner({connectionString,namespace:selected.namespace,storeCode:selected.storeCode,username:selected.username,confirmation,password,backupFile});
    output.write('กู้รหัสผ่านแล้วสำหรับ '+result.storeCode+'/'+result.username+' และยกเลิก session เดิม\nสำรองก่อนเปลี่ยน: '+result.backupFile+'\nตรวจ Login และข้อมูลร้านเดิม แล้วผูกอีเมลผ่าน OTP เพื่อกู้ครั้งถัดไป\n');
    return result;
  }catch(error){
    if(error instanceof RecoveryError)throw error;
    fail('กู้คืนยังไม่ยืนยันสำเร็จ: ตรวจ Login ก่อนรันซ้ำหากการเชื่อมต่อขาดระหว่าง commit และเก็บไฟล์สำรองไว้ ห้ามเผยข้อมูลลับ');
  }finally{
    password=undefined;connectionString=undefined;
    if(pool)try{await pool.end()}catch{}
  }
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  runOwnerRecoveryWizard().catch(error=>{process.stderr.write((error instanceof RecoveryError?error.message:'กู้คืนไม่สำเร็จ: ตรวจสิทธิ์กับผู้ดูแลโดยไม่เผยข้อมูลลับ')+'\n');process.exitCode=1});
}
