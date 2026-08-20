import test from 'node:test';
import assert from 'node:assert/strict';
import { RepositoryEnvironmentExecution } from '../src/runtime/repository-environment-execution.js';
import { REPOSITORY_EXECUTION_REQUEST_PROTOCOL, REPOSITORY_EXECUTION_STATUS_PROTOCOL } from '../src/runtime/repository-execution.js';

function request(extra={}) { return {
 protocol:REPOSITORY_EXECUTION_REQUEST_PROTOCOL, operation:'node.test', scope:{repository:'owner/repo',repositoryId:'123',runId:'run-1'},
 invocation:{tool:'node',arguments:['--test',{kind:'input',name:'context'},{kind:'output',name:'result'}],workingDirectory:'.'}, environment:{CI:'1'},
 transfers:[{name:'context',direction:'input',port:{read:async()=>({data:Buffer.from('x'),eof:true})}},{name:'result',direction:'output',port:{write:async()=>{}}}],
 limits:{timeoutMs:5000,maxOutputBytes:4096}, stdin:null, signal:null,onActivity:null,...extra}; }
const status={protocol:REPOSITORY_EXECUTION_STATUS_PROTOCOL,state:'ready',ready:true,identity:'environment-execution',reason:null};

test('orchestrates neutral session studs without external topology', async()=>{
 const calls=[]; const execution=new RepositoryEnvironmentExecution({status,open:async(scope)=>{calls.push(['open',scope]);return {
  prepare:async()=>{calls.push(['prepare']);return {identity:'evidence-123'};}, input:async(name)=>calls.push(['input',name]),
  run:async(value)=>{calls.push(['run',value.invocation.tool]);return {completion:'observed',result:{exitCode:0,signal:null,timedOut:false,aborted:false,outputTruncated:false,stdout:'ok',stderr:'',startedAt:null,finishedAt:null,lastOutputAt:null}};},
  output:async(name)=>calls.push(['output',name]), collect:async()=>calls.push(['collect'])};}});
 const result=await execution.execute(request()); assert.equal(result.stdout,'ok'); assert.match(result.evidence.identity,/^execution-[a-f0-9]{64}$/u);
 assert.deepEqual(calls.map(c=>c[0]),['open','prepare','input','run','output','collect']);
});

test('indeterminate completion fails closed and does not collect', async()=>{
 let collected=false; const execution=new RepositoryEnvironmentExecution({status,open:async()=>({prepare:async()=>({identity:'evidence-123'}),input:async()=>{},run:async()=>({completion:'indeterminate'}),output:async()=>{},collect:async()=>{collected=true;}})});
 await assert.rejects(()=>execution.execute(request()),/refusing to infer success/u); assert.equal(collected,false);
});

test('timeout and abort do not import outputs or candidate state', async()=>{
 for (const flag of ['timedOut','aborted']) { let output=false,collect=false; const execution=new RepositoryEnvironmentExecution({status,open:async()=>({prepare:async()=>({identity:'evidence-123'}),input:async()=>{},run:async()=>({completion:'observed',result:{exitCode:null,signal:null,timedOut:flag==='timedOut',aborted:flag==='aborted',outputTruncated:false,stdout:'',stderr:'',startedAt:null,finishedAt:null,lastOutputAt:null}}),output:async()=>{output=true;},collect:async()=>{collect=true;}})}); const result=await execution.execute(request()); assert.equal(result[flag],true); assert.equal(output,false); assert.equal(collect,false); }
});

test('a control signal raised after execution prevents output and candidate import and closes the session', async()=>{
 const controller=new AbortController(); let output=false,collect=false,closed=false;
 const execution=new RepositoryEnvironmentExecution({status,open:async()=>({prepare:async()=>({identity:'evidence-123'}),input:async()=>{},run:async()=>{controller.abort(new Error('lease lost'));return {completion:'observed',result:{exitCode:0,signal:null,timedOut:false,aborted:false,outputTruncated:false,stdout:'',stderr:'',startedAt:null,finishedAt:null,lastOutputAt:null}};},output:async()=>{output=true;},collect:async()=>{collect=true;},close:async()=>{closed=true;}})});
 await assert.rejects(()=>execution.execute(request({signal:controller.signal})),/lease lost/u); assert.equal(output,false); assert.equal(collect,false); assert.equal(closed,true);
});
