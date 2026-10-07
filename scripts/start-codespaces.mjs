import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const projectRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));

export function codespacesConfig(environment=process.env,root=projectRoot){
  const name=environment.CODESPACE_NAME,domain=environment.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN;
  if(typeof name!=='string'||name.length>100||!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name))throw new Error('Open this demo in GitHub Codespaces: a valid CODESPACE_NAME is required.');
  if(typeof domain!=='string'||domain.length>150||!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain))throw new Error('GitHub Codespaces must provide GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN.');
  const publicOrigin=`https://${name}-4180.${domain}`,dbPath=path.join(root,'.local','codespaces-demo.sqlite');
  const configured=key=>environment[key]!==undefined&&environment[key]!=='';
  if(configured('ORDER_HUB_PUBLIC_ORIGIN')&&environment.ORDER_HUB_PUBLIC_ORIGIN!==publicOrigin&&environment.ORDER_HUB_PUBLIC_ORIGIN!==publicOrigin+'/')throw new Error('ORDER_HUB_PUBLIC_ORIGIN conflicts with this Codespace. Existing configuration was not changed.');
  if(configured('ORDER_HUB_HOST')&&environment.ORDER_HUB_HOST!=='0.0.0.0')throw new Error('ORDER_HUB_HOST conflicts with the Codespaces demo. Existing configuration was not changed.');
  for(const key of ['ORDER_HUB_PORT','PORT'])if(configured(key)&&environment[key]!=='4180')throw new Error(`${key} conflicts with demo port 4180. Existing configuration was not changed.`);
  if(configured('ORDER_HUB_DB')&&path.resolve(root,environment.ORDER_HUB_DB)!==dbPath)throw new Error('ORDER_HUB_DB points to a different database. It was not opened or changed.');
  return {root,publicOrigin,dbPath,host:'0.0.0.0',port:4180,serverPath:path.join(root,'server','index.mjs'),logPath:path.join(root,'.local','codespaces-demo.log'),markerPath:path.join(root,'.local','codespaces-process.json')};
}

function isAlive(pid){
  if(!Number.isSafeInteger(pid)||pid<=0)return false;
  try{process.kill(pid,0);return true}catch(error){if(error.code==='ESRCH')return false;throw error}
}

function ownProcess(marker,config){
  if(!marker||!isAlive(marker.pid))return false;
  if(!/^[a-f0-9]{32}$/.test(marker.id)||marker.publicOrigin!==config.publicOrigin||marker.dbPath!==config.dbPath||marker.host!==config.host||marker.port!==config.port||marker.serverPath!==config.serverPath)return false;
  try{
    const command=fs.readFileSync(`/proc/${marker.pid}/cmdline`,'utf8').split('\0').filter(Boolean);
    return command.length===3&&command[0]===process.execPath&&command[1]===config.serverPath&&command[2]===`--order-hub-codespaces-id=${marker.id}`;
  }catch(error){if(error.code==='ENOENT')return false;throw new Error('Could not verify the existing demo process; no process was stopped.');}
}

function readMarker(markerPath){
  try{return JSON.parse(fs.readFileSync(markerPath,'utf8'))}catch(error){if(error.code==='ENOENT')return null;throw new Error('The demo process marker is unreadable. No process or database was changed.');}
}

export function demoStatus(config){
  return new Promise((resolve,reject)=>{
    const request=http.get({hostname:'127.0.0.1',port:config.port,path:'/api/auth/status',headers:{Host:new URL(config.publicOrigin).host},timeout:1000},response=>{
      let body='';response.setEncoding('utf8');response.on('data',chunk=>{body+=chunk;if(body.length>65536)request.destroy(new Error('Unexpected readiness response.'));});
      response.on('end',()=>{
        try{const status=JSON.parse(body);if(response.statusCode!==200||typeof status.needsSetup!=='boolean'||status.user!==null)throw new Error('The listener did not return the expected anonymous Order Hub status.');resolve(status)}catch(error){reject(error)}
      });
      response.on('error',reject);
    });
    request.on('timeout',()=>request.destroy(new Error('Demo readiness timed out.')));request.on('error',reject);
  });
}

async function ready(config,marker,timeoutMs){
  const deadline=Date.now()+timeoutMs;let failure;
  while(Date.now()<deadline){
    if(!ownProcess(marker,config))throw new Error(`The Order Hub demo stopped during startup. See ${config.logPath}.`);
    try{return await demoStatus(config)}catch(error){failure=error;await wait(100)}
  }
  throw new Error(`The demo did not become ready: ${failure?.message||'timeout'}. See ${config.logPath}.`);
}

function assertPortFree(config){
  return new Promise((resolve,reject)=>{
    const probe=net.createServer();probe.once('error',error=>reject(new Error(`Port ${config.port} is unavailable (${error.code}). No existing process was stopped.`)));
    probe.listen(config.port,config.host,()=>probe.close(error=>error?reject(error):resolve()));
  });
}

function assertPrivatePaths(config){
  const paths=new Set([path.dirname(config.dbPath),path.dirname(config.logPath),path.dirname(config.markerPath),config.dbPath,config.logPath,config.markerPath,config.markerPath+'.lock']);
  for(const file of paths){
    let stat;try{stat=fs.lstatSync(file)}catch(error){if(error.code==='ENOENT')continue;throw error}
    if(stat.isSymbolicLink()||stat.isFile()&&stat.nlink>1)throw new Error('Demo storage must not use symbolic links or shared hard links. No database or process was changed.');
  }
}

async function startupLock(config,timeoutMs){
  fs.mkdirSync(path.dirname(config.markerPath),{recursive:true,mode:0o700});
  const lockPath=config.markerPath+'.lock';
  // Debian's flock provides a kernel lock: crashes release it automatically,
  // so a leftover file never authorizes stopping a process or blocks restart.
  const holder=spawn('flock',['--no-fork','--exclusive','--timeout',String(timeoutMs/1000),lockPath,process.execPath,'-e',"process.stdout.write('locked\\n');process.stdin.resume();process.stdin.on('end',()=>process.exit(0));"],{stdio:['pipe','pipe','pipe']});
  holder.stdin.on('error',()=>{});let locked=false,output='';
  const closed=new Promise(resolve=>holder.once('close',resolve));
  await new Promise((resolve,reject)=>{
    holder.once('error',()=>reject(new Error('The standard Debian flock utility is required for safe demo startup. No database or existing process was changed.')));
    holder.stdout.on('data',chunk=>{output+=chunk.toString();if(!locked&&output.includes('locked\n')){locked=true;resolve()}});
    holder.once('close',()=>{if(!locked)reject(new Error('Another demo startup did not release its lock in time. No existing process was stopped.'))});
  });
  return async()=>{holder.stdin.end();await closed};
}

async function startLocked(config,{environment,timeoutMs}){
  const marker=readMarker(config.markerPath);
  if(marker&&isAlive(marker.pid)){
    if(!ownProcess(marker,config))throw new Error('The recorded PID belongs to a different process or configuration. No process or database was changed.');
    const status=await ready(config,marker,timeoutMs);
    return {pid:marker.pid,publicOrigin:config.publicOrigin,needsSetup:status.needsSetup,reused:true};
  }
  await assertPortFree(config);
  fs.mkdirSync(path.dirname(config.dbPath),{recursive:true,mode:0o700});
  fs.mkdirSync(path.dirname(config.markerPath),{recursive:true,mode:0o700});
  fs.mkdirSync(path.dirname(config.logPath),{recursive:true,mode:0o700});
  const id=randomBytes(16).toString('hex'),log=fs.openSync(config.logPath,'a',0o600);
  let child;
  try{
    child=spawn(process.execPath,[config.serverPath,`--order-hub-codespaces-id=${id}`],{cwd:config.root,detached:true,stdio:['ignore',log,log],env:{...environment,ORDER_HUB_HOST:config.host,ORDER_HUB_PORT:String(config.port),PORT:String(config.port),ORDER_HUB_PUBLIC_ORIGIN:config.publicOrigin,ORDER_HUB_DB:config.dbPath}});
    await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject)});
  }finally{fs.closeSync(log)}
  const started={pid:child.pid,id,publicOrigin:config.publicOrigin,dbPath:config.dbPath,host:config.host,port:config.port,serverPath:config.serverPath};
  child.unref();
  try{
    fs.writeFileSync(config.markerPath,JSON.stringify(started)+'\n',{mode:0o600});
    const status=await ready(config,started,timeoutMs);
    return {pid:child.pid,publicOrigin:config.publicOrigin,needsSetup:status.needsSetup,reused:false};
  }catch(error){
    if(ownProcess(started,config))child.kill('SIGTERM');
    throw error;
  }
}

export async function startDemo(config,{environment=process.env,timeoutMs=10000}={}){
  assertPrivatePaths(config);
  const release=await startupLock(config,timeoutMs);
  try{assertPrivatePaths(config);return await startLocked(config,{environment,timeoutMs})}finally{await release()}
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const result=await startDemo(codespacesConfig());
    console.log(`Order Hub demo ready: ${result.publicOrigin}`);
    console.log('Keep port 4180 private. Open its browser URL from the Ports tab if a browser did not open.');
    console.log(result.needsSetup?'Create your own Admin on the setup page; no default password is installed.':'Your existing demo database and accounts were preserved.');
  }catch(error){console.error(`Order Hub demo could not start: ${error.message}`);process.exitCode=1}
}
