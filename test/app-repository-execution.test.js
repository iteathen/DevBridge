import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile, lstat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRepositoryExecution } from '../src/app/repository-execution.js';
import { ENVIRONMENT_ACTIVITY_POLICY_PROTOCOL, normalizeEnvironmentActivityPolicy } from '../src/runtime/environment-activity-policy.js';
import { resolveBuiltInHelper } from '../src/app/builtin-helper-resolver.js';
import { composeWorkRunner } from '../src/app/work-runner-composition.js';
import { REPOSITORY_EXECUTION_REQUEST_PROTOCOL } from '../src/runtime/repository-execution.js';
import { WorkerExchange } from '../src/runtime/worker-exchange.js';
import { lifecycleRoundtripDiagnosticProfile } from '../src/runtime/builtin-tool-profiles.js';
import { LIFECYCLE_ROUNDTRIP_NONCE } from '../src/runtime/lifecycle-roundtrip-probe.js';

async function command(program,args,{cwd,input=null,env=process.env}={}){return new Promise((resolve,reject)=>{const child=spawn(program,args,{cwd,env,shell:false,stdio:['pipe','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',c=>stdout+=c);child.stderr.on('data',c=>stderr+=c);child.once('error',reject);child.once('exit',(code,signal)=>resolve({exitCode:code,signal,stdout,stderr}));if(input==null)child.stdin.end();else child.stdin.end(input);});}
async function initGit(root){await command('git',['init','-q'],{cwd:root});await command('git',['config','user.name','Host'],{cwd:root});await command('git',['config','user.email','host@localhost'],{cwd:root});await command('git',['add','-A'],{cwd:root});await command('git',['commit','-q','-m','base'],{cwd:root});}
async function visible(root){const r=await command('git',['ls-files','-co','--exclude-standard','-z'],{cwd:root});assert.equal(r.exitCode,0,r.stderr);return r.stdout.split('\0').filter(Boolean);}

function localChannel(root){const classes={};for(const name of ['input','work','output','cache','scratch'])classes[name]=path.join(root,name);const ensure=async()=>{for(const dir of Object.values(classes))await mkdir(dir,{recursive:true});};const locate=async(location,{forInput=false}={})=>{await ensure();const candidate=path.join(classes[location.class],...location.path.split('/').filter(x=>x!=='.'));if(!forInput)await mkdir(path.dirname(candidate),{recursive:true});return candidate;};return {
 async health(){await ensure();return{ready:true,version:'1.0.0',features:['health','execute','observe','cancel','put','get'],reason:null};},
 async put(_target,source,destination,{maxBytes=32*1024*1024}={}){const file=await locate(destination);let offset=0;const chunks=[];while(true){const part=await source.read({offset,limit:Math.min(16*1024,maxBytes-offset)});const data=Buffer.from(part.data);chunks.push(data);offset+=data.length;if(part.eof)break;if(offset>=maxBytes)throw new Error('put limit');}await writeFile(file,Buffer.concat(chunks));return{bytes:offset,digest:'x'};},
 async get(_target,source,sink,{maxBytes=32*1024*1024}={}){const file=await locate(source,{forInput:true});const data=await readFile(file);if(data.length>maxBytes)throw new Error('get limit');await sink.write({offset:0,data,eof:true,digest:'x'});return{bytes:data.length,digest:'x'};},
 async execute(_target,operation,{signal=null,onActivity=null}={}){await ensure();const args=[];for(const arg of operation.arguments){if(typeof arg==='string')args.push(arg);else args.push(await locate(arg,{forInput:arg.class==='input'}));}const cwd=operation.directory.path==='.'?classes[operation.directory.class]:await locate(operation.directory);onActivity?.({state:'running'});if(signal?.aborted)return{completion:'observed',result:{exitCode:null,signal:null,timedOut:false,aborted:true,outputTruncated:false,stdout:'',stderr:'',startedAt:null,finishedAt:null,lastOutputAt:null}};const startedAt=new Date().toISOString();const r=await command(operation.program,args,{cwd,input:operation.input,env:{...process.env,...operation.environment}});return{completion:'observed',result:{exitCode:r.exitCode,signal:r.signal,timedOut:false,aborted:false,outputTruncated:false,stdout:r.stdout,stderr:r.stderr,startedAt,finishedAt:new Date().toISOString(),lastOutputAt:r.stdout||r.stderr?new Date().toISOString():null}};}
};}

function request(args,{tool='node',operation='test.operation',environment={CI:'1'}}={}){return{protocol:REPOSITORY_EXECUTION_REQUEST_PROTOCOL,operation,scope:{repository:'owner/repo',repositoryId:'123',runId:'run-1'},invocation:{tool,arguments:args,workingDirectory:'.'},environment,transfers:[],limits:{timeoutMs:120000,maxOutputBytes:1024*1024},stdin:null,signal:null,onActivity:null};}

test('route policy accepts only stable numeric subjects and one validation environment',()=>{assert.throws(()=>normalizeEnvironmentActivityPolicy({protocol:ENVIRONMENT_ACTIVITY_POLICY_PROTOCOL,routes:[{subject:'owner-repo',profile:'linux'}]}),/numeric stable identity/u);assert.throws(()=>normalizeEnvironmentActivityPolicy({protocol:ENVIRONMENT_ACTIVITY_POLICY_PROTOCOL,routes:[{subject:'1',profile:'left',validation:true},{subject:'2',profile:'right',validation:true}]}),/multiple validation routes/u);});

test('production composition round-trips Node/CMake/CTest candidate bytes and preserves ignored guest state across source resync',async()=>{const temp=await mkdtemp(path.join(os.tmpdir(),'db-stage6-app-'));const host=path.join(temp,'host');const guest=path.join(temp,'guest');try{await mkdir(host);await writeFile(path.join(host,'.gitignore'),'build/\n');await writeFile(path.join(host,'a.txt'),'alpha\n');await writeFile(path.join(host,'CMakeLists.txt'),'cmake_minimum_required(VERSION 3.20)\nproject(BridgeFlow NONE)\nenable_testing()\nadd_test(NAME bridge COMMAND "${CMAKE_COMMAND}" -E echo bridge-passed)\n');await initGit(host);const entry={record:{identity:'env-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',subject:'123',profile:'linux-dev'},observation:{exists:true,owned:true,compatible:true,state:'running'}};const fakeState={inspect:async()=>({ready:true,identity:'f'.repeat(32),reason:null}),listEnvironments:async()=>[entry],observeEnvironment:async()=>entry};const channel=localChannel(guest);const routes={protocol:ENVIRONMENT_ACTIVITY_POLICY_PROTOCOL,routes:[{subject:'123',profile:'linux-dev',preferred:true}]};const execution=await createRepositoryExecution({stateDirectory:path.join(temp,'state'),routes,protectedValues:['secret-sentinel'],rootFor:async()=>host,listPaths:async(root)=>visible(root),resolveSubject:async(scope)=>scope.repositoryId,resolveTool:async(tool)=>({program:tool,arguments:[]}),createState:async()=>fakeState,createPreparation:async()=>({ensure:async()=>({generation:'b'.repeat(64)})}),createChannel:async()=>channel});assert.equal(execution.inspect().ready,true);
 const first=await execution.execute(request(['-e',`const fs=require('node:fs');fs.mkdirSync('build',{recursive:true});fs.writeFileSync('build/cache','persist');fs.writeFileSync('a.txt','changed\\n');fs.writeFileSync('new.txt','new\\n');console.log('first')`]));assert.equal(first.exitCode,0);assert.match(first.evidence.identity,/^execution-/u);assert.equal(await readFile(path.join(host,'a.txt'),'utf8'),'changed\n');assert.equal(await readFile(path.join(host,'new.txt'),'utf8'),'new\n');await assert.rejects(readFile(path.join(host,'build','cache')),{code:'ENOENT'});
 await writeFile(path.join(host,'a.txt'),'host-next\n');const second=await execution.execute(request(['-e',`const fs=require('node:fs');process.stdout.write(fs.readFileSync('build/cache','utf8')+'|'+fs.readFileSync('a.txt','utf8'))`]));assert.equal(second.stdout,'persist|host-next\n');assert.equal(await readFile(path.join(guest,'work','build','cache'),'utf8'),'persist');const configured=await execution.execute(request(['-S','.','-B','build'],{tool:'cmake',operation:'cmake.configure'}));assert.equal(configured.exitCode,0,configured.stderr);const tested=await execution.execute(request(['--test-dir','build','-C','Debug','--output-on-failure'],{tool:'ctest',operation:'ctest.run'}));assert.equal(tested.exitCode,0,tested.stderr);assert.match(tested.stdout,/100% tests passed/u);await assert.rejects(()=>execution.execute(request(['--version'],{environment:{CI:'contains-secret-sentinel-value'}})),/protected control-plane value/u);
 }finally{await rm(temp,{recursive:true,force:true});}});

test('authoritative source drift during guest execution rejects candidate import',async()=>{const temp=await mkdtemp(path.join(os.tmpdir(),'db-stage6-drift-'));const host=path.join(temp,'host');const guest=path.join(temp,'guest');try{await mkdir(host);await writeFile(path.join(host,'a.txt'),'alpha\n');await initGit(host);const entry={record:{identity:'env-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',subject:'123',profile:'linux-dev'},observation:{exists:true,owned:true,compatible:true,state:'running'}};const fakeState={inspect:async()=>({ready:true,identity:'e'.repeat(32),reason:null}),listEnvironments:async()=>[entry],observeEnvironment:async()=>entry};const base=localChannel(guest);const channel={...base,async execute(target,operation,options){const result=await base.execute(target,operation,options);const hasRun=operation.arguments.some((arg)=>arg==='run');if(hasRun&&operation.arguments.some((arg)=>typeof arg==='object'&&arg.class==='input'&&arg.path.startsWith('control/operation-')))await writeFile(path.join(host,'a.txt'),'external-drift\n');return result;}};const execution=await createRepositoryExecution({stateDirectory:path.join(temp,'state'),routes:{protocol:ENVIRONMENT_ACTIVITY_POLICY_PROTOCOL,routes:[{subject:'123',profile:'linux-dev'}]},rootFor:async()=>host,listPaths:async(root)=>visible(root),resolveSubject:async()=> '123',resolveTool:async(tool)=>({program:tool,arguments:[]}),createState:async()=>fakeState,createPreparation:async()=>({ensure:async()=>({generation:'c'.repeat(64)})}),createChannel:async()=>channel});await assert.rejects(()=>execution.execute(request(['-e',`require('node:fs').writeFileSync('a.txt','guest-change\\n')`])),/authoritative source changed during repository execution|stale/u);assert.equal(await readFile(path.join(host,'a.txt'),'utf8'),'external-drift\n');}finally{await rm(temp,{recursive:true,force:true});}});

test('one persistent environment admits only one active source/candidate session', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'db-stage6-lock-'));
  const host = path.join(temp, 'host');
  const guest = path.join(temp, 'guest');
  let releaseRun;
  let observeRun;
  const entered = new Promise((resolve) => { observeRun = resolve; });
  const released = new Promise((resolve) => { releaseRun = resolve; });
  try {
    await mkdir(host);
    await writeFile(path.join(host, 'a.txt'), 'alpha\n');
    await initGit(host);
    const entry = {
      record: { identity: 'env-dddddddddddddddddddddddddddddddd', subject: '123', profile: 'serial' },
      observation: { exists: true, owned: true, compatible: true, state: 'running' },
    };
    const state = { inspect: async () => ({ ready: true, identity: 'f'.repeat(32) }), listEnvironments: async () => [entry], observeEnvironment: async () => entry };
    const base = localChannel(guest);
    const channel = {
      ...base,
      async execute(target, operation, options) {
        const isWork = operation.arguments.some((value) => value === 'run') && operation.arguments.some((value) => typeof value === 'object' && value.path?.startsWith('control/operation-'));
        if (isWork) { observeRun(); await released; }
        return base.execute(target, operation, options);
      },
    };
    const execution = await createRepositoryExecution({
      stateDirectory: path.join(temp, 'state'),
      routes: { protocol: ENVIRONMENT_ACTIVITY_POLICY_PROTOCOL, routes: [{ subject: '123', profile: 'serial' }] },
      rootFor: async () => host, listPaths: async (root) => visible(root), resolveSubject: async () => '123', resolveTool: async (tool) => ({ program: tool, arguments: [] }),
      createState: async () => state, createPreparation: async () => ({ ensure: async () => ({ generation: 'a'.repeat(64) }) }), createChannel: async () => channel,
    });
    const first = execution.execute(request(['-e', 'process.stdout.write("first")']));
    await entered;
    await assert.rejects(() => execution.execute(request(['-e', 'process.stdout.write("second")'])), /already has an active session/u);
    releaseRun();
    assert.equal((await first).stdout, 'first');
    assert.equal((await execution.execute(request(['-e', 'process.stdout.write("third")']))).stdout, 'third');
  } finally {
    releaseRun?.();
    await rm(temp, { recursive: true, force: true });
  }
});

test('representative proposal worker uses only logical transfers through the execution bridge', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'db-stage6-worker-'));
  const host = path.join(temp, 'host');
  const guest = path.join(temp, 'guest');
  try {
    await mkdir(host);
    await writeFile(path.join(host, 'worker.mjs'), `import { readFile, writeFile } from 'node:fs/promises';\nconst [,, input, output] = process.argv;\nconst value = JSON.parse(await readFile(input, 'utf8'));\nawait writeFile(output, JSON.stringify({ protocol: 'devbridge/result-v1', status: 'complete', summary: 'bridge worker observed ' + value.objective }));\n`);
    await initGit(host);
    const entry = {
      record: { identity: 'env-cccccccccccccccccccccccccccccccc', subject: '456', profile: 'worker' },
      observation: { exists: true, owned: true, compatible: true, state: 'running' },
    };
    const state = {
      inspect: async () => ({ ready: true, identity: 'd'.repeat(32), reason: null }),
      listEnvironments: async () => [entry],
      observeEnvironment: async () => entry,
    };
    const execution = await createRepositoryExecution({
      stateDirectory: path.join(temp, 'state'),
      platform: 'linux',
      routes: { protocol: ENVIRONMENT_ACTIVITY_POLICY_PROTOCOL, routes: [{ subject: '456', profile: 'worker' }] },
      rootFor: async () => host,
      listPaths: async (root) => visible(root),
      resolveSubject: async () => '456',
      resolveTool: async (tool) => {
        assert.equal(tool, 'fixture-worker');
        return { program: 'node', arguments: [] };
      },
      createState: async () => state,
      createPreparation: async () => ({ ensure: async () => ({ generation: 'e'.repeat(64) }) }),
      createChannel: async () => localChannel(guest),
    });
    const runner = composeWorkRunner({
      mailboxStore: new WorkerExchange({ stateDirectory: path.join(temp, 'control') }),
      activeExecution: execution,
    });
    const runDir = path.join(host, '.devbridge', 'runs', 'turn-1');
    await mkdir(runDir, { recursive: true });
    const result = await runner.run({
      profile: {
        name: 'fixture-worker', args: ['worker.mjs', '{contextFile}', '{resultFile}'], inputMode: 'none',
        timeoutMs: 120_000, maxOutputBytes: 128 * 1024, environment: { pass: [], set: {} },
      },
      projectDir: host,
      runDir,
      runId: 'worker-run',
      repository: 'owner/repo',
      repositoryId: '456',
      context: { objective: 'isolated input' },
    });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.result.status, 'complete');
    assert.equal(result.result.summary, 'bridge worker observed isolated input');
    assert.equal(Object.hasOwn(result, 'execution'), false);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('built-in helper bundle executes through the same neutral VM work contract', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'db-stage6-builtin-'));
  const host = path.join(temp, 'host');
  const guest = path.join(temp, 'guest');
  try {
    await mkdir(host);
    await writeFile(path.join(host, 'README.md'), 'fixture\n');
    await initGit(host);
    const entry = {
      record: { identity: 'env-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', subject: '789', profile: 'built-in' },
      observation: { exists: true, owned: true, compatible: true, state: 'running' },
    };
    const state = {
      inspect: async () => ({ ready: true, identity: 'f'.repeat(32), reason: null }),
      listEnvironments: async () => [entry],
      observeEnvironment: async () => entry,
    };
    const execution = await createRepositoryExecution({
      stateDirectory: path.join(temp, 'state'),
      routes: { protocol: ENVIRONMENT_ACTIVITY_POLICY_PROTOCOL, routes: [{ subject: '789', profile: 'built-in' }] },
      rootFor: async () => host,
      listPaths: async (root) => visible(root),
      resolveSubject: async () => '789',
      resolveTool: resolveBuiltInHelper,
      createState: async () => state,
      createPreparation: async () => ({ ensure: async () => ({ generation: 'a'.repeat(64) }) }),
      createChannel: async () => localChannel(guest),
    });
    const runner = composeWorkRunner({
      mailboxStore: new WorkerExchange({ stateDirectory: path.join(temp, 'control') }),
      activeExecution: execution,
    });
    const runDir = path.join(host, '.devbridge', 'runs', 'turn-1');
    await mkdir(runDir, { recursive: true });
    const result = await runner.run({
      profile: lifecycleRoundtripDiagnosticProfile(),
      projectDir: host,
      runDir,
      runId: 'builtin-run',
      repository: 'owner/repo',
      repositoryId: '789',
      context: {
        protocol: 'devbridge/context-v1',
        sequence: 1,
        objective: `Execute ${LIFECYCLE_ROUNDTRIP_NONCE}.`,
        priorSummary: `Carry ${LIFECYCLE_ROUNDTRIP_NONCE}.`,
      },
    });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.result.status, 'complete');
    assert.match(result.result.summary, /Lifecycle roundtrip passed/u);
    assert.equal(Object.hasOwn(result, 'execution'), false);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
