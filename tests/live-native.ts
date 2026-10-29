// Explicit live smoke check: one short prompt, no tools or repository changes.
import {spawn} from 'node:child_process';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createInterface} from 'node:readline';
const profileId=process.argv[2]??'codex';
const dir=mkdtempSync(join(tmpdir(),'bb-central-live-'));
const script=`import {createInterface} from 'node:readline';import {experimental_providerBridge as b} from './dist/host.js';b.start({pluginId:'central',dataDir:process.env.TEST_DIR,tempDir:process.env.TEST_DIR});createInterface({input:process.stdin}).on('line',l=>b.handleLine(l)).on('close',()=>{b.onClose();setTimeout(()=>process.exit(0),2500)});`;
const child=spawn(process.execPath,['--input-type=module','-e',script],{env:{...process.env,TEST_DIR:dir},stdio:['pipe','pipe','pipe']});
let seq=0;
const waiters=new Map<number,{resolve:(v:any)=>void,reject:(e:Error)=>void}>();
let identity:string|undefined;
let text='';
let completedResolve:()=>void;
let completedReject:(e:Error)=>void;
const completed=new Promise<void>((resolve,reject)=>{completedResolve=resolve;completedReject=reject});
const timer=setTimeout(()=>{completedReject(new Error('Live check timed out'));child.kill()},90000);
createInterface({input:child.stdout!}).on('line',line=>{
 const x=JSON.parse(line);
 if(x.id&&waiters.has(x.id)){const w=waiters.get(x.id)!;waiters.delete(x.id);x.error?w.reject(new Error(x.error.message)):w.resolve(x.result);return}
 if(x.method){
  if(x.id){child.stdin!.write(JSON.stringify({jsonrpc:'2.0',id:x.id,result:{outcome:'denied'}})+'\n');return}
  const p=x.params;
  if(p?.providerThreadId)identity=p.providerThreadId;
  const deltas=p?.deltas??(p?.delta?[p.delta]:[]);
  for(const d of deltas){
   if(d.kind==='thread.identity')identity=d.providerThreadId;
   if(d.kind==='item.textDelta')text+=d.text??'';
   if(d.kind==='turn.boundary'){d.status==='completed'?completedResolve():completedReject(new Error('Turn '+d.status+': '+JSON.stringify(d.error??{})))}
  }
 }
});
child.stderr!.on('data',()=>{});
function rpc(method:string,params:unknown):Promise<any>{const id=++seq;return new Promise((resolve,reject)=>{waiters.set(id,{resolve,reject});child.stdin!.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n')})}
const native=profileId;
const providerOptions={centralProfile:{id:profileId,displayName:'Work test',agent:profileId==='claude-code'?'claude':profileId,bridge:native,args:[]},centralCommand:'central',builtinPluginsDirectory:'',providerSubagentsEnabled:false,memoryEnabled:false};
const options={permissionMode:'accept-edits',permissionScope:'workspace',approvalReviewer:'user',permissionEscalation:'deny',providerOptions};
try{
 await rpc('initialize',{protocolVersion:2,client:{name:'central-test',version:'1'},grammarVersions:[2,3]});
 const start=await rpc('thread/start',{threadId:'central-smoke',cwd:dir,options,instructionMode:'append'});
 identity??=start.providerThreadId;
 if(!identity)throw new Error('Missing native session identity');
 await rpc('turn/start',{threadId:'central-smoke',providerThreadId:identity,input:[{type:'text',text:'Reply with exactly CENTRAL_OK. Do not use any tools.',mentions:[]}],clientRequestId:'creq_23456789ab',options});
 await completed;
 if(text!=='CENTRAL_OK')throw new Error('Unexpected response: '+text);
 await rpc('thread/stop',{threadId:'central-smoke',providerThreadId:identity,intent:'release',activeTurnId:null});
 const resumed=await rpc('thread/resume',{threadId:'central-smoke',providerThreadId:identity,cwd:dir,options,instructionMode:'append'});
 if(resumed.providerThreadId!==identity)throw new Error('Session identity changed on resume');
 console.log('LIVE CHECK PASSED');
}catch(e){console.error(e instanceof Error?e.message:e);process.exitCode=1}
finally{clearTimeout(timer);child.stdin!.end()}
