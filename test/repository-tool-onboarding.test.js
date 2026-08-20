import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RepositoryToolOnboarding } from '../src/runtime/repository-tool-onboarding.js';
import { REPOSITORY_EXECUTION_RESULT_PROTOCOL, REPOSITORY_EXECUTION_STATUS_PROTOCOL } from '../src/runtime/repository-execution.js';

test('probes through repository execution and registers persisted operation only with exact scope', async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'db-probe-')); const manifests=path.join(root,'manifests'); await mkdir(manifests);
 const registered=new Map(); const calls=[];
 const registry={has:n=>registered.has(n),register(n,a){registered.set(n,a)}};
 const execution={inspect(){return {protocol:REPOSITORY_EXECUTION_STATUS_PROTOCOL,state:'ready',ready:true,identity:'vm',reason:null}},async execute(req){calls.push(req);return {protocol:REPOSITORY_EXECUTION_RESULT_PROTOCOL,exitCode:0,signal:null,timedOut:false,aborted:false,outputTruncated:false,stdout:'Usage: magic --json\n',stderr:'',startedAt:null,finishedAt:null,lastOutputAt:null,evidence:{identity:'execution-one',scope:req.scope}}}};
 try{
  const service=new RepositoryToolOnboarding({operationRegistry:registry,repositoryExecution:execution,manifestDirectory:manifests,entries:[{command:'magic',operation:'tool.magic',helpArgs:['--help']}]});
  const noScope=await service.reconcile(); assert.equal(noScope.events[0].state,'repository-scope-required'); assert.equal(calls.length,0);
  const result=await service.reconcile({repository:'owner/project',repositoryId:'42',runId:'run-1'}); assert.equal(result.changed,true); assert.equal(result.events[0].state,'registered-probed'); assert.equal(calls[0].operation,'tool.probe:tool.magic'); assert.equal(calls[0].scope.repositoryId,'42'); assert.equal(registered.has('tool.magic'),true);
  const persisted=JSON.parse(await readFile(path.join(manifests,'auto-tool.magic.json'),'utf8')); assert.equal(persisted.executable,'magic'); assert.equal(persisted.source.kind,'help-synthesized');
 }finally{await rm(root,{recursive:true,force:true})}
});
