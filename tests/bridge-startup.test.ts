import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,delimiter} from 'node:path';
import {createInterface} from 'node:readline';

test('cold start acknowledges BB skills setup, then applies roots before thread/start',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'central-cold-start-'));
 const builtin=join(dir,'builtins');
 const moduleDir=join(builtin,'provider-codex','dist');mkdirSync(moduleDir,{recursive:true});
 writeFileSync(join(moduleDir,'package.json'),JSON.stringify({type:'module'}));
 writeFileSync(join(moduleDir,'host.js'),`
 let roots;
 const reply=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');
 export const experimental_providerBridge={experimental_apiVersion:1,handleLine(line){
  const x=JSON.parse(line);
  if(x.method==='initialize')reply(x.id,{protocolVersion:2,capabilities:{}});
  else if(x.method==='skills/configure'){roots=x.params.roots;reply(x.id,{ok:true});}
  else if(x.method==='thread/start')reply(x.id,{providerThreadId:'work-session',roots,providerOptions:x.params.options.providerOptions});
 },onClose(){},onSigterm(){}};
 `);
 const bin=join(dir,'bin');mkdirSync(bin);
 writeFileSync(join(bin,'codex'),'#!/bin/sh\nexit 0\n',{mode:0o700});
 const script=`import {createInterface} from 'node:readline';import {experimental_providerBridge as b} from './dist/host.js';b.start({pluginId:'jetbrains-central',dataDir:process.env.TEST_DIR,tempDir:process.env.TEST_DIR});createInterface({input:process.stdin}).on('line',l=>b.handleLine(l)).on('close',()=>{b.onClose();setTimeout(()=>process.exit(0),2300)});`;
 const child=spawn(process.execPath,['--input-type=module','-e',script],{env:{...process.env,TEST_DIR:dir,PATH:bin+delimiter+process.env.PATH},stdio:['pipe','pipe','pipe']});
 let seq=0;
 const waiters=new Map<number,{resolve:(result:any)=>void;reject:(error:Error)=>void;timer:NodeJS.Timeout}>();
 const responses:number[]=[];
 createInterface({input:child.stdout!}).on('line',line=>{
  const x=JSON.parse(line);responses.push(x.id);const w=waiters.get(x.id);if(!w)return;
  clearTimeout(w.timer);waiters.delete(x.id);x.error?w.reject(new Error(x.error.message)):w.resolve(x.result);
 });
 child.stderr!.resume();
 child.on('exit',()=>{for(const w of waiters.values()){clearTimeout(w.timer);w.reject(new Error('Bridge exited'))}waiters.clear()});
 function rpc(method:string,params:unknown):Promise<any>{const id=++seq;return new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{waiters.delete(id);reject(new Error('Timeout: '+method))},5000);
  waiters.set(id,{resolve,reject,timer});child.stdin!.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
 })}
 try{
  await rpc('initialize',{protocolVersion:2,client:{name:'test',version:'1'},grammarVersions:[2,3]});
  const roots=[{id:'bb-test-skills',path:join(dir,'skills'),skills:[{name:'example',description:'A BB-injected skill'}]}];
  assert.deepEqual(await rpc('skills/configure',{roots}),{ok:true});
  const providerOptions={centralProfile:{id:'codex',displayName:'Codex JetBrains Air',agent:'codex',bridge:'codex',args:[]},centralCommand:'central',builtinPluginsDirectory:builtin};
  const options={permissionMode:'accept-edits',permissionScope:'workspace',approvalReviewer:'user',permissionEscalation:'deny',providerOptions};
  const started=await rpc('thread/start',{threadId:'cold-start',cwd:dir,options,instructionMode:'append'});
  assert.equal(started.providerThreadId,'work-session');
  assert.deepEqual(started.roots,roots);
  assert.equal(started.providerOptions.centralProfile.agent,'codex');
  assert.equal(responses.filter(id=>id===2).length,1,'Skills replay must not send a duplicate response');
 }finally{
  child.stdin!.end();
  await new Promise<void>(resolve=>{child.once('exit',()=>resolve());setTimeout(()=>{child.kill('SIGKILL');resolve()},3500).unref()});
  rmSync(dir,{recursive:true,force:true});
 }
});
