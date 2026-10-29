import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createFakePluginHost,experimental_scanPublicSdkOnly} from '@get-bb/plugin-sdk/testing';
import plugin from '../server.js';
import {defaults,parseProfiles,centralArgs} from '../profiles.js';
import {stripCentralProfile,codexWrapper,claudeWrapper,nativeLaunchEnv} from '../native.js';
import {isWorkPiModel,piModels} from '../pi.js';

test('package depends only on published SDK entrypoints',()=>{
 const scan=experimental_scanPublicSdkOnly(process.cwd(),{allow:[/^react$/]});
 assert.deepEqual(scan.violations,[]);
 assert.deepEqual(scan.privateDependencies,[]);
});

test('registers separate work identities and never changes personal provider IDs',async()=>{
 const {bb,harness}=createFakePluginHost({experimental_hostEntry:true});
 await plugin(bb);
 const providers=harness.registrations.providerRegistrations;
 assert.deepEqual(providers.map(p=>p.id),['central-codex','central-claude-code','central-pi']);
 assert.ok(providers.every(p=>p.maintenance?.usage===false));
 assert.ok(providers.every(p=>p.deriveProviderOptions?.({} as any).providerSubagentsEnabled===false));
 assert.equal(harness.registrations.providerEnvResolvers.size,0);
 await harness.lifecycle.dispose();
});

test('rejects duplicate IDs and malformed command metadata before registration',()=>{
 assert.throws(()=>parseProfiles([defaults[0],defaults[0]]),/unique/);
 assert.throws(()=>parseProfiles([{...defaults[0],agent:'codex; echo unsafe'}]));
 assert.deepEqual(centralArgs(defaults[0],['app-server']),['run','codex','--','app-server']);
 assert.deepEqual(centralArgs({...defaults[0],agent:'copilot',runArgs:['--provider=openai']},['--acp']),['run','copilot','--provider=openai','--','--acp']);
});

test('removes only unsupported profile selection, retaining Central routing overrides',()=>{
 assert.deepEqual(stripCentralProfile(['--profile','jetbrains-central','-c','model_provider="wire"','app-server']),['-c','model_provider="wire"','app-server']);
 assert.deepEqual(stripCentralProfile(['--profile=work','app-server','--listen','stdio://']),['app-server','--listen','stdio://']);
});

test('Codex shim preserves Central profile in its isolated home and forwards stdio',()=>{
 const dir=mkdtempSync(join(tmpdir(),'central-test-'));
 try{
  const home=join(dir,'work');mkdirSync(home);
  const profile='[features]\nexample=true\n';
  writeFileSync(join(home,'jetbrains-central.config.toml'),profile);
  const fake=join(dir,'fake-codex.cjs');
  writeFileSync(fake,`console.log(JSON.stringify({args:process.argv.slice(2),path:process.env.PATH}));`);
  const shim=join(dir,'shim.cjs');
  writeFileSync(shim,codexWrapper(process.execPath,process.env.PATH??'',home));
  // The executable gets the fixture path as its first surviving argument.
  const result=spawnSync(process.execPath,[shim,'--profile','jetbrains-central',fake,'app-server'],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  assert.equal(readFileSync(join(home,'config.toml'),'utf8'),profile);
  assert.deepEqual(JSON.parse(result.stdout).args,['app-server']);
  assert.equal(JSON.parse(result.stdout).path,process.env.PATH);
 }finally{rmSync(dir,{recursive:true,force:true})}
});

test('Claude wrapper preserves paths and argument boundaries without shell interpolation',()=>{
 const dir=mkdtempSync(join(tmpdir(),'central-shell-'));
 try{
  const fake=join(dir,"central ' quoted");
  writeFileSync(fake,'#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)));\n',{mode:0o700});
  const wrapper=join(dir,'wrapper');writeFileSync(wrapper,claudeWrapper(fake,defaults[1]),{mode:0o700});
  const input='$(touch SHOULD_NOT_EXIST); `echo unsafe`';
  const result=spawnSync(wrapper,['--prompt',input],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  assert.deepEqual(JSON.parse(result.stdout),['run','claude','--','--prompt',input]);
 }finally{rmSync(dir,{recursive:true,force:true})}
});

test('Pi rejects models outside providers overridden by Central',()=>{
 assert.ok(isWorkPiModel('anthropic/claude-sonnet-4-6'));
 assert.ok(isWorkPiModel('openai/model'));
 assert.equal(isWorkPiModel('personal-proxy/model'),false);
 assert.equal(isWorkPiModel('local/model'),false);
});

test('Pi catalog loads extension models and returns complete BB picker entries',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'central-pi-catalog-'));
 try{
  const fake=join(dir,'central');
  writeFileSync(fake,`#!/usr/bin/env node
const {createInterface}=require('node:readline');
createInterface({input:process.stdin}).on('line',line=>{
 const x=JSON.parse(line);
 console.log(JSON.stringify({id:x.id,type:'response',success:true,data:{models:[
  {provider:'anthropic',id:'claude-sonnet-4-6',name:'Sonnet',reasoning:true},
  {provider:'personal',id:'private-model',name:'Personal'}
 ]}}));
});
`,{mode:0o700});
  const models=await piModels(fake,defaults[2]);
  assert.equal(models.length,1);
  assert.equal(models[0].id,'anthropic/claude-sonnet-4-6');
  assert.equal(models[0].isDefault,true);
  assert.equal(typeof models[0].description,'string');
  assert.ok(models[0].supportedReasoningEfforts.length>0);
  assert.equal(models[0].defaultReasoningEffort,'medium');
 }finally{rmSync(dir,{recursive:true,force:true})}
});

test('native launch overrides are isolated to the selected bridge',()=>{
 assert.deepEqual(nativeLaunchEnv(defaults[1],'central','/work/wrapper','/work/data'),{BB_CLAUDE_CODE_EXECUTABLE:'/work/wrapper'});
 const env=nativeLaunchEnv(defaults[0],'central','unused','/work/data');
 assert.equal(env.CODEX_HOME,'/work/data/codex');
 assert.deepEqual(JSON.parse(env.BB_CODEX_BRIDGE_APP_SERVER_ARGS!),['run','codex','--','app-server']);
});
