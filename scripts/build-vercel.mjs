import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const projectRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const VERCEL_OUTPUT_DIRECTORY='.vercel-static';
export const REQUIRED_PUBLIC_ASSETS=Object.freeze([
  'index.html','brand-logo.jpeg','brand-icon.png','styles.css','auth.css','order-editor.css',
  'app.js','features.js','stock-sync.js','auth-client.js','order-editor.js','connections.js',
  'fonts/Manrope-Variable.ttf','fonts/SukhumvitThai-400.ttf','fonts/SukhumvitThai-600.ttf','fonts/SukhumvitThai-700.ttf',
  'channels/facebook.svg','channels/shopee.svg','channels/tiktok.svg','channels/lazada.svg','channels/line.png'
]);
const requiredBackendFiles=['package-lock.json','api/order-hub.mjs','server/index.mjs','server/model.mjs','server/storage.mjs','server/seed.json','server/vercel-demo.mjs','server/demo-postgres.mjs','server/email-auth.mjs','server/migration-backup.mjs'];
const sensitiveName=/^(?:\.env(?:\..*)?|(?:secrets?|credentials?|sessions?)(?:\..*)?)$|\.(?:sqlite(?:3)?|db)(?:-(?:wal|shm))?$|\.(?:pem|key)$/i;

function directory(file){
  const stat=fs.lstatSync(file);
  if(stat.isSymbolicLink()||!stat.isDirectory())throw new Error('Vercel build directories must be real directories, without symbolic links.');
}

function inspectTree(folder,{rejectSecrets=false}={}){
  directory(folder);
  for(const entry of fs.readdirSync(folder,{withFileTypes:true})){
    const file=path.join(folder,entry.name);
    if(entry.isSymbolicLink())throw new Error('Vercel build inputs and output must not contain symbolic links.');
    if(rejectSecrets&&sensitiveName.test(entry.name))throw new Error('Remove private database or credential files from Vercel function inputs.');
    if(entry.isDirectory())inspectTree(file,{rejectSecrets});
    else if(!entry.isFile())throw new Error('Vercel build inputs and output must contain only regular files and directories.');
  }
}

function requiredFile(root,relative){
  const components=relative.split('/');
  let file=root;
  for(const [index,component]of components.entries()){
    file=path.join(file,component);
    const stat=fs.lstatSync(file);
    if(stat.isSymbolicLink())throw new Error('Vercel build inputs must not contain symbolic links.');
    if(index<components.length-1&&!stat.isDirectory())throw new Error('A required Vercel input directory is missing.');
  }
  const stat=fs.lstatSync(file);
  if(!stat.isFile()||stat.size===0)throw new Error(`Required Vercel input is missing or empty: ${relative}`);
}

export function buildVercel({root=projectRoot,nodeVersion=process.versions.node}={}){
  const major=Number(String(nodeVersion).split('.')[0]);
  if(!Number.isInteger(major)||major<24)throw new Error('Order Hub on Vercel requires Node.js 24 or newer.');
  root=path.resolve(root);directory(root);
  for(const relative of requiredBackendFiles)requiredFile(root,relative);
  for(const asset of REQUIRED_PUBLIC_ASSETS)requiredFile(root,'dist/'+asset);
  for(const folder of ['api','server','dist'])inspectTree(path.join(root,folder),{rejectSecrets:true});

  // Vercel rejects an empty static output directory. Generate only a harmless
  // marker; the catch-all route still sends every request to the Node function.
  const output=path.join(root,VERCEL_OUTPUT_DIRECTORY);
  if(fs.existsSync(output))inspectTree(output);
  else {
    // existsSync is false for a broken symlink; lstat still detects it.
    try{fs.lstatSync(output);throw new Error('Vercel output must not be a symbolic link.')}catch(error){if(error.code!=='ENOENT')throw error}
  }
  fs.rmSync(output,{recursive:true,force:true});
  fs.mkdirSync(output,{mode:0o755});
  fs.writeFileSync(path.join(output,'build-ready.txt'),'Order Hub deployment build output.\n',{mode:0o644});
  return {outputDirectory:output,assetCount:REQUIRED_PUBLIC_ASSETS.length};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const result=buildVercel();
  console.log(`Vercel build checked ${result.assetCount} assets; all requests use the Order Hub Node function.`);
}
