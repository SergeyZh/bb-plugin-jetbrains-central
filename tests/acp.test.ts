import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createInterface} from 'node:readline';

test('ACP profile launches through Central and relays a single bridge handshake',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'central-acp-'));
 const command=join(dir,'fake-central');
 writeFileSync(command,`#!/usr/bin/env node
+const {createInterface}=require('node:readline');
+if(JSON.stringify(process.argv.slice(2))!==JSON.stringify(['run','gemini','--','--acp']))process.exit(2);
+createInterface({input:process.stdin}).on('line',line=>{
+ const x=JSON.parse(line);if(x.id===undefined)return;
+ let result={};
+ if(x.method==='initialize')result={protocolVersion:1,agentCapabilities:{loadSession:true},agentInfo:{name:'test',version:'1'},authMethods:[]};
+ if(x.method==='session/new')result={sessionId:'acp-work',models:{currentModelId:'work-model',availableModels:[{modelId:'work-model',name:'Work Model'}]}};
+ process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:x.id,result})+'\\n');
+});
`.replaceAll('\n+','\n'),{mode:0o700});
 const script=`import {createInterface} from 'node:readline';import {experimental_providerBridge as b} from './dist/host.js';b.start({pluginId:'central',dataDir:process.env.TEST_DIR,tempDir:process.env.TEST_DIR});createInterface({input:process.stdin}).on('line',l=>b.handleLine(l)).on('close',()=>{b.onClose();setTimeout(()=>process.exit(0),2300)});`;
 const child=spawn(process.execPath,['--input-type=module','-e',script],{env:{...process.env,TEST_DIR:dir},stdio:['pipe','pipe','pipe']});
 const messages:any[]=[];
 try{
  const result=await new Promise<any>((resolve,reject)=>{
   const timeout=setTimeout(()=>reject(new Error('ACP test timed out')),15000);
   child.once('exit',code=>{clearTimeout(timeout);reject(new Error('Bridge exited '+code))});
   child.stderr!.resume();
   createInterface({input:child.stdout!}).on('line',line=>{
    const x=JSON.parse(line);messages.push(x);
    if(x.id===2){clearTimeout(timeout);x.error?reject(new Error(x.error.message)):resolve(x.result)}
   });
   child.stdin!.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:2,client:{name:'test',version:'1'},grammarVersions:[2,3]}})+'\n');
   child.stdin!.write(JSON.stringify({jsonrpc:'2.0',id:3,method:'skills/configure',params:{roots:[]}})+'\n');
   child.stdin!.write(JSON.stringify({jsonrpc:'2.0',id:2,method:'model/list',params:{cwd:dir,providerId:'central-gemini',providerOptions:{centralCommand:command,builtinPluginsDirectory:'',centralProfile:{id:'gemini',displayName:'Gemini Work',agent:'gemini',bridge:'acp',args:['--acp']}}}})+'\n');
  });
  assert.equal(messages.filter(x=>x.id===1).length,1);
  assert.deepEqual(messages.filter(x=>x.id===3).map(x=>x.result),[{ok:true}]);
  assert.ok(result.models.some((m:any)=>m.id==='work-model'),JSON.stringify(result));
 }finally{
  child.stdin!.end();
  await new Promise<void>(resolve=>{child.once('exit',()=>resolve());setTimeout(()=>{child.kill('SIGKILL');resolve()},3500).unref()});
  rmSync(dir,{recursive:true,force:true});
 }
});
