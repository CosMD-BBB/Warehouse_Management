import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildVercel,REQUIRED_PUBLIC_ASSETS,VERCEL_OUTPUT_DIRECTORY} from '../scripts/build-vercel.mjs';

const projectRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'order-hub-vercel-build-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const files=[...REQUIRED_PUBLIC_ASSETS.map(asset=>'dist/'+asset),'package-lock.json','api/order-hub.mjs','server/index.mjs','server/model.mjs','server/storage.mjs','server/seed.json','server/vercel-demo.mjs','server/demo-postgres.mjs'];
  for(const relative of files){const file=path.join(root,relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'fixture: '+relative)}
  return root;
}

test('Vercel routes every page, asset and API through the Node function rather than a static app',()=>{
  const config=JSON.parse(fs.readFileSync(path.join(projectRoot,'vercel.json'),'utf8'));
  assert.equal(config.framework,null);assert.equal(config.buildCommand,'node scripts/build-vercel.mjs');
  assert.equal(config.outputDirectory,VERCEL_OUTPUT_DIRECTORY);
  assert.deepEqual(config.routes,[{src:'/(.*)',dest:'/api/order-hub'}]);
  const route=new RegExp('^'+config.routes[0].src+'$');
  for(const uri of ['/','/fonts/Manrope-Variable.ttf','/api/auth/login','/.local/order-hub.sqlite','/server/seed.json'])assert.ok(route.test(uri));
  const entry=config.functions['api/order-hub.mjs'];
  assert.equal(entry.includeFiles,'{server,dist}/**');assert.equal(entry.maxDuration,60);
  assert.equal('runtime' in entry,false,'Node version must come from package engines, not a custom runtime');
  for(const incompatible of ['builds','rewrites','headers'])assert.equal(incompatible in config,false);
  assert.equal(fs.existsSync(path.join(projectRoot,'api/order-hub.mjs')),true);
});

test('Vercel build checks all 21 assets and keeps static output empty without copying private files',t=>{
  const root=fixture(t),output=path.join(root,VERCEL_OUTPUT_DIRECTORY);
  fs.mkdirSync(path.join(root,'.local'));fs.writeFileSync(path.join(root,'.local','actual.sqlite'),'do not touch');
  fs.writeFileSync(path.join(root,'.env'),'private placeholder');fs.mkdirSync(output);fs.writeFileSync(path.join(output,'old-index.html'),'stale static page');
  const result=buildVercel({root,nodeVersion:'24.19.0'});
  assert.equal(result.assetCount,21);assert.equal(result.outputDirectory,output);assert.deepEqual(fs.readdirSync(output),[]);
  assert.equal(fs.readFileSync(path.join(root,'.local','actual.sqlite'),'utf8'),'do not touch');
  assert.equal(fs.readFileSync(path.join(root,'.env'),'utf8'),'private placeholder');
  for(const asset of REQUIRED_PUBLIC_ASSETS)assert.equal(fs.readFileSync(path.join(root,'dist',asset),'utf8'),'fixture: dist/'+asset);
});

test('unsupported Node or missing assets fail before replacing any output',t=>{
  const root=fixture(t),output=path.join(root,VERCEL_OUTPUT_DIRECTORY),marker=path.join(output,'marker');
  fs.mkdirSync(output);fs.writeFileSync(marker,'retain on validation failure');
  assert.throws(()=>buildVercel({root,nodeVersion:'22.20.0'}),/requires Node.js 24/);
  fs.rmSync(path.join(root,'dist','fonts','SukhumvitThai-400.ttf'));
  assert.throws(()=>buildVercel({root}),/ENOENT/);
  assert.equal(fs.readFileSync(marker,'utf8'),'retain on validation failure');
});

test('credential files in function inputs fail before generating public output',t=>{
  for(const relative of ['server/.env','dist/credentials.json','server/demo.sqlite-wal']){
    const root=fixture(t);fs.writeFileSync(path.join(root,relative),'private placeholder');
    assert.throws(()=>buildVercel({root}),/private database or credential files/);
    assert.equal(fs.existsSync(path.join(root,VERCEL_OUTPUT_DIRECTORY)),false);
  }
});

test('Vercel build refuses source and output symlinks without changing their targets',{skip:process.platform==='win32'&&'Unix symlink fixture'},t=>{
  const root=fixture(t),outside=fs.mkdtempSync(path.join(os.tmpdir(),'order-hub-vercel-outside-'));
  t.after(()=>fs.rmSync(outside,{recursive:true,force:true}));
  const marker=path.join(outside,'keep');fs.writeFileSync(marker,'existing data');
  const output=path.join(root,VERCEL_OUTPUT_DIRECTORY);fs.symlinkSync(outside,output);
  assert.throws(()=>buildVercel({root}),/without symbolic links/);assert.equal(fs.readFileSync(marker,'utf8'),'existing data');
  fs.unlinkSync(output);fs.symlinkSync(path.join(outside,'missing'),output);
  assert.throws(()=>buildVercel({root}),/symbolic link/);assert.equal(fs.readFileSync(marker,'utf8'),'existing data');
  fs.unlinkSync(output);fs.symlinkSync(marker,path.join(root,'server','private-link'));
  assert.throws(()=>buildVercel({root}),/symbolic links/);assert.equal(fs.readFileSync(marker,'utf8'),'existing data');
  assert.equal(fs.existsSync(output),false);
});
