import fs from 'node:fs';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {DatabaseSync,backup} from 'node:sqlite';

// Invoke before opening a writable application connection. Local CLI startup
// keeps the backup file. The hosting adapter retains it in PostgreSQL within the
// same transaction as the upgraded snapshot, before cleaning temporary files.
export async function backupStorageBeforeMigration(dbPath){
  if(!fs.existsSync(dbPath))return null;
  const stat=fs.lstatSync(dbPath);if(!stat.isFile()||stat.isSymbolicLink())throw new Error('Migration backup requires a regular SQLite file');
  const source=new DatabaseSync(dbPath,{readOnly:true});let destination;
  try{
    const exists=source.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").get();
    if(!exists)return null;
    const columns=source.prepare('PRAGMA table_info(users)').all(),version=source.prepare('PRAGMA user_version').get().user_version;
    if(version>=4&&columns.some(column=>column.name==='email')&&columns.some(column=>column.name==='email_verified_at'))return null;
    const directory=path.join(path.dirname(dbPath),'backups');
    if(fs.existsSync(directory)&&(!fs.lstatSync(directory).isDirectory()||fs.lstatSync(directory).isSymbolicLink()))throw new Error('Migration backup directory is unavailable');
    fs.mkdirSync(directory,{recursive:true,mode:0o700});fs.chmodSync(directory,0o700);
    destination=path.join(directory,`order-hub-before-schema-4-${Date.now()}-${randomBytes(6).toString('hex')}.sqlite`);
    const fd=fs.openSync(destination,'wx',0o600);fs.closeSync(fd);
    await backup(source,destination);
    fs.chmodSync(destination,0o600);
    const saved=new DatabaseSync(destination,{readOnly:true});
    try{if(saved.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw new Error('Migration backup failed SQLite integrity verification')}finally{saved.close()}
    return {path:destination,fromVersion:version,toVersion:4};
  }catch(error){if(destination)try{fs.rmSync(destination,{force:true})}catch{}throw new Error('SQLite backup failed; migration has not started',{cause:error})}
  finally{source.close()}
}
