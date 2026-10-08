import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Readable} from 'node:stream';
import {backup} from 'node:sqlite';
import {createHash,randomBytes} from 'node:crypto';
import {createApp} from './index.mjs';

const projectRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const maxSnapshotBytes=10*1024*1024,maxBodyBytes=65536;
const sqliteHeader=Buffer.from('SQLite format 3\0');
const securityHeaders={
  'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY',
  'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
};
const assetAllow=/^(index\.html|brand-logo\.jpeg|brand-icon\.png|styles\.css|auth\.css|order-editor\.css|app\.js|features\.js|stock-sync\.js|auth-client\.js|order-editor\.js|connections\.js|fonts\/[A-Za-z0-9._-]+\.(ttf|woff2)|channels\/[A-Za-z0-9._-]+\.(svg|png|webp))$/;
const assetTypes={'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.ttf':'font/ttf','.woff2':'font/woff2','.svg':'image/svg+xml','.png':'image/png','.jpeg':'image/jpeg','.webp':'image/webp'};
const apiAllow=/^\/api\/(?:auth\/(?:status|setup|login|logout|password|demo-reset)|state|actions|store|stores|users(?:\/[a-f0-9]{32})?|connections)$/;
const failed=(status,message)=>Object.assign(new Error(message),{status});

function exactOrigin(value){
  if(typeof value!=='string'||!/^https:\/\/[^\s\\/?#]+\/?$/i.test(value))throw Error('Invalid public origin configuration');
  let url;try{url=new URL(value)}catch{throw Error('Invalid public origin configuration')}
  if(url.protocol!=='https:'||url.username||url.password||url.hostname.includes('*')||url.pathname!=='/'||url.search||url.hash)throw Error('Invalid public origin configuration');
  return url.origin;
}
function approvedOrigins(environment){
  if(environment.ORDER_HUB_PUBLIC_ORIGIN)return [exactOrigin(environment.ORDER_HUB_PUBLIC_ORIGIN)];
  const values=[environment.VERCEL_URL,environment.VERCEL_BRANCH_URL,environment.VERCEL_PROJECT_PRODUCTION_URL].filter(value=>value!==undefined&&value!=='');
  if(!values.length)throw Error('Missing public origin configuration');
  return [...new Set(values.map(value=>{
    if(typeof value!=='string'||!/^[A-Za-z0-9.-]+(?::[0-9]+)?$/.test(value))throw Error('Invalid Vercel origin configuration');
    return exactOrigin('https://'+value);
  }))];
}
export function vercelDemoNamespace(environment=process.env){
  if(environment.ORDER_HUB_DEMO_NAMESPACE!==undefined){
    const value=environment.ORDER_HUB_DEMO_NAMESPACE;
    if(typeof value!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$/.test(value))throw Error('Invalid demo namespace configuration');
    return value;
  }
  const value=environment.VERCEL_PROJECT_PRODUCTION_URL;
  if(typeof value!=='string'||!/^[A-Za-z0-9.-]+(?::[0-9]+)?$/.test(value))throw Error('Missing stable Vercel project identity');
  const host=new URL(exactOrigin('https://'+value)).host;
  const target=environment.VERCEL_ENV===undefined?'preview':environment.VERCEL_ENV;
  if(!['production','preview','development'].includes(target))throw Error('Invalid Vercel environment configuration');
  return 'vercel-'+createHash('sha256').update(host+'|'+target).digest('hex').slice(0,24);
}
export function publicDemoEnabled(environment=process.env){
  return environment.VERCEL_ENV==='preview'&&environment.VERCEL_GIT_COMMIT_REF==='vercel-demo';
}
function publicVisitor(req){
  const matches=String(req.headers.cookie||'').split(';').map(value=>value.trim()).filter(value=>value.startsWith('__Host-oh_demo='));
  if(matches.length!==1)return null;
  const value=matches[0].slice('__Host-oh_demo='.length);
  return /^[a-f0-9]{64}$/.test(value)?value:null;
}
function sendJSON(res,status,error){
  res.writeHead(status,{...securityHeaders,'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
  res.end(JSON.stringify({error}));
}
function attemptsMap(records){
  if(!Array.isArray(records)||records.length>10000)throw Error('Invalid persisted login limits');
  const map=new Map(),seen=new Set(),now=Date.now();
  for(const item of records){
    if(!Array.isArray(item)||item.length!==2||typeof item[0]!=='string'||!/^[a-f0-9]{64}$/.test(item[0])||seen.has(item[0]))throw Error('Invalid persisted login limits');
    const value=item[1];
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='at,count'||!Number.isSafeInteger(value.count)||value.count<=0||!Number.isSafeInteger(value.at)||value.at<0)throw Error('Invalid persisted login limits');
    seen.add(item[0]);
    if(now-value.at<=900000)map.set(item[0],{count:value.count,at:value.at});
  }
  return map;
}
function validateSnapshot(snapshot){
  if(snapshot===null)return;
  if(!Buffer.isBuffer(snapshot)||snapshot.length<100||snapshot.length>maxSnapshotBytes||!snapshot.subarray(0,16).equals(sqliteHeader))throw Error('Invalid persisted demo snapshot');
}
function bufferedResponse(){
  const headers=new Map(),chunks=[];let ended=false,size=0;
  const res={
    statusCode:200,
    setHeader(name,value){if(ended)throw Error('Response already ended');headers.set(name.toLowerCase(),value);return res},
    getHeader(name){return headers.get(name.toLowerCase())},
    hasHeader(name){return headers.has(name.toLowerCase())},
    removeHeader(name){headers.delete(name.toLowerCase())},
    writeHead(status,reasonOrHeaders,otherHeaders){
      res.statusCode=status;const values=typeof reasonOrHeaders==='string'?otherHeaders:reasonOrHeaders;
      for(const [name,value]of Object.entries(values||{}))res.setHeader(name,value);return res;
    },
    write(value,encoding){
      if(ended)throw Error('Response already ended');const chunk=Buffer.isBuffer(value)?value:Buffer.from(value,encoding);
      size+=chunk.length;if(size>maxSnapshotBytes)throw Error('Demo response is too large');chunks.push(chunk);return true;
    },
    end(value,encoding){if(value!==undefined&&value!==null)res.write(value,encoding);ended=true;return res},
    result(){if(!ended)throw Error('Incomplete demo response');return {status:res.statusCode,headers:Object.fromEntries(headers),body:Buffer.concat(chunks)}}
  };
  return res;
}

// Vercel's Node runtime can parse and consume IncomingMessage before invoking a
// function. Replay that body through the same bounded JSON parser as the local app.
function normalizedRequest(req){
  const contentLength=req.headers['content-length'];
  if(contentLength!==undefined&&(!/^\d+$/.test(String(contentLength))||Number(contentLength)>maxBodyBytes))throw failed(413,'Request too large');
  let body;try{body=req.body}catch{throw failed(400,'ข้อมูลที่ส่งไม่ถูกต้อง')}
  if(body===undefined)return req;
  let bytes;
  try{
    if(Buffer.isBuffer(body))bytes=body;
    else if(body instanceof Uint8Array)bytes=Buffer.from(body);
    else if(typeof body==='string')bytes=Buffer.from(body);
    else bytes=Buffer.from(JSON.stringify(body));
  }catch{throw failed(400,'ข้อมูลที่ส่งไม่ถูกต้อง')}
  if(bytes.length>maxBodyBytes)throw failed(413,'Request too large');
  const replay=Readable.from([bytes]);
  replay.method=req.method;replay.url=req.url;replay.headers={...req.headers};replay.socket={remoteAddress:req.socket?.remoteAddress||'vercel-proxy'};
  return replay;
}

export function createVercelDemoHandler({store,environment=process.env,root=projectRoot}={}){
  const publicDemo=publicDemoEnabled(environment);
  let storePromise;
  async function durableStore(){
    if(store)return store;
    if(!storePromise)storePromise=(async()=>{
      const connectionString=environment.ORDER_HUB_DEMO_DATABASE_URL||environment.DATABASE_URL||environment.POSTGRES_URL;
      let namespace;try{namespace=vercelDemoNamespace(environment)}catch{throw Object.assign(Error('Demo database configuration required'),{code:'DEMO_CONFIGURATION'})}
      if(typeof connectionString!=='string'||!connectionString)throw Object.assign(Error('Demo database configuration required'),{code:'DEMO_CONFIGURATION'});
      const {createPostgresSnapshotStore}=await import('./demo-postgres.mjs');
      return createPostgresSnapshotStore({connectionString,namespace});
    })();
    // A failed connection/configuration is retried on the next request. There is
    // deliberately no process-local database fallback.
    try{return await storePromise}catch(error){storePromise=undefined;throw error}
  }
  return async function vercelDemo(req,res){
    try{
      const origins=approvedOrigins(environment),origin=origins.find(value=>new URL(value).host===req.headers.host);
      if(!origin)throw failed(403,'Host not allowed');
      if(!['GET','HEAD','POST','PATCH'].includes(req.method))throw failed(405,'Method not allowed');
      if(typeof req.url!=='string'||!req.url.startsWith('/')||req.url.startsWith('//'))throw failed(404,'Not found');
      const url=new URL(req.url,origin),rawPath=req.url.split('?')[0],route=url.pathname;
      if(rawPath!==route||/[\\%\0]/.test(rawPath)||rawPath.includes('//'))throw failed(404,'Not found');
      if(!['GET','HEAD'].includes(req.method)&&req.headers.origin!==origin)throw failed(403,'Origin not allowed');
      if(!route.startsWith('/api/')){
        if(!['GET','HEAD'].includes(req.method))throw failed(405,'Method not allowed');
        const asset=route==='/'?'index.html':route.slice(1);
        if(!assetAllow.test(asset))throw failed(404,'Not found');
        let bytes;try{bytes=await fs.readFile(path.join(root,'dist',asset))}catch(error){if(error.code==='ENOENT')throw failed(404,'Not found');throw error}
        res.writeHead(200,{...securityHeaders,'Content-Type':assetTypes[path.extname(asset)]||'application/octet-stream','Cache-Control':'no-store'});
        res.end(req.method==='HEAD'?undefined:bytes);return;
      }
      if(!apiAllow.test(route))throw failed(404,'Not found');
      if(route==='/api/auth/demo-reset'&&!publicDemo)throw failed(404,'Not found');
      const starting=publicDemo&&route==='/api/auth/status'&&req.method==='GET';
      let visitor=publicDemo?publicVisitor(req):null;
      if(publicDemo&&!visitor){
        if(!starting)throw failed(401,'กรุณาเปิดหน้าเว็บเพื่อเริ่มทดลองใช้งาน');
        visitor=randomBytes(32).toString('hex');
      }
      const request=normalizedRequest(req),persistence=await durableStore();
      const reply=await persistence.transaction(async({snapshot,attempts})=>{
        validateSnapshot(snapshot);const limits=attemptsMap(attempts),directory=await fs.mkdtemp(path.join(os.tmpdir(),'order-hub-vercel-'));let app;
        try{
          await fs.chmod(directory,0o700);const dbPath=path.join(directory,'request.sqlite');
          if(snapshot!==null)await fs.writeFile(dbPath,snapshot,{mode:0o600,flag:'wx'});
          app=createApp({dbPath,publicOrigin:origin,attempts:limits,publicDemo});
          const response=bufferedResponse();await app.handler(request,response);const result=response.result();
          if(result.status>=500)throw Error('Demo backend failed');
          const snapshotPath=path.join(directory,'committed.sqlite');await backup(app.db,snapshotPath);
          await fs.chmod(snapshotPath,0o600);const nextSnapshot=await fs.readFile(snapshotPath);validateSnapshot(nextSnapshot);
          const nextAttempts=Array.from(limits);attemptsMap(nextAttempts);
          return {snapshot:nextSnapshot,attempts:nextAttempts,result};
        }finally{try{app?.close()}finally{await fs.rm(directory,{recursive:true,force:true})}}
      },publicDemo?{visitor:createHash('sha256').update(visitor).digest('hex'),allowCreate:starting}:{});
      // Session cookies and successful replies must not escape before COMMIT.
      if(starting&&reply.status===200){
        const value=reply.headers['set-cookie'];
        reply.headers['set-cookie']=[...(value===undefined?[]:Array.isArray(value)?value:[value]),`__Host-oh_demo=${visitor}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=86400`];
      }
      res.writeHead(reply.status,reply.headers);res.end(req.method==='HEAD'?undefined:reply.body);
    }catch(error){
      const status=error.status&&[400,401,403,404,405,413,415].includes(error.status)?error.status:503;
      const unavailable=error.code==='PUBLIC_DEMO_CAPACITY'?'มีผู้ทดลองใช้งานเต็มแล้ว กรุณาลองใหม่ภายหลัง':error.code==='PUBLIC_DEMO_SIZE'?'ข้อมูลทดลองเต็มแล้ว กรุณากดเริ่มทดลองใหม่':error.code==='DEMO_CONFIGURATION'?'กรุณาเชื่อมต่อฐานข้อมูล Neon/Postgres ใน Vercel แล้ว Deploy อีกครั้ง เพื่อเปิดระบบสาธิต':'ระบบสาธิตยังไม่พร้อมใช้งาน กรุณาตรวจการเชื่อมต่อฐานข้อมูลใน Vercel';
      sendJSON(res,status,status===503?unavailable:error.message);
    }
  };
}
