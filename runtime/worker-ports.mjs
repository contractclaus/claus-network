import {Sandbox as DefaultSandbox} from '@vercel/sandbox';
import {WORKER_LIMITS} from '../src/workers/index.mjs';
import {requireThat} from '../src/shared/index.mjs';

const runner=`import fs from 'node:fs';import {pathToFileURL} from 'node:url';
const module=await import(pathToFileURL('/vercel/sandbox/source/'+process.argv[2]));
if(typeof module.default!=='function')throw Error('default_function_required');
const output=JSON.stringify(await module.default(JSON.parse(fs.readFileSync('/vercel/sandbox/input.json','utf8'))));
if(typeof output!=='string'||Buffer.byteLength(output)>16000)throw Error('output_limit');
fs.writeFileSync('/vercel/sandbox/result.json',output);`;
const vmName=work=>'claus-run-'+work.id.slice(7,47);
export function workerPorts({Sandbox=DefaultSandbox,credentials={}}={}){
 async function stop(work){const box=await Sandbox.get({...credentials,name:vmName(work),resume:false,signal:AbortSignal.timeout(10000)});if(box.status==='running')await box.stop({signal:AbortSignal.timeout(10000)});}
 return {stop,
  async execute(work,files,progress,allowed){
   await progress({phase:'creating',name:vmName(work)});
   const box=await Sandbox.create({...credentials,name:vmName(work),runtime:'node22',persistent:false,resources:{vcpus:1},timeout:WORKER_LIMITS.vmSeconds*1000,networkPolicy:'deny-all',env:{},ports:[],signal:AbortSignal.timeout(20000)});
   let cancelled=false,checking=false;
   const timer=setInterval(async()=>{if(checking)return;checking=true;try{if(!await allowed()){cancelled=true;await box.stop({signal:AbortSignal.timeout(5000)}).catch(()=>{});}}catch{cancelled=true;await box.stop({signal:AbortSignal.timeout(5000)}).catch(()=>{});}finally{checking=false;}},3000);
   try{
    requireThat(await allowed(),'worker_cancelled');
    await box.writeFiles([...files.map(f=>({path:'/vercel/sandbox/source/'+f.path,content:Buffer.from(f.content)})),{path:'/vercel/sandbox/runner.mjs',content:Buffer.from(runner)},{path:'/vercel/sandbox/input.json',content:Buffer.from(work.inputJson)}],{signal:AbortSignal.timeout(10000)});
    await progress({phase:'command-starting',name:vmName(work)});
    requireThat(await allowed(),'worker_cancelled');
    const command=await box.runCommand({cmd:'bash',args:['-c','exec timeout --kill-after=2s 30s node /vercel/sandbox/runner.mjs "$1" >/dev/null 2>/dev/null','claus-worker',work.definition.entry],detached:true,signal:AbortSignal.timeout(10000)});
    await progress({phase:'command-running',name:vmName(work),commandId:command.cmdId});
    const finished=await command.wait({signal:AbortSignal.timeout(35000)});
    requireThat(!cancelled&&await allowed(),'worker_cancelled');requireThat(finished.exitCode===0,'worker_execution_failed');
    const stream=await box.readFile({path:'/vercel/sandbox/result.json'},{signal:AbortSignal.timeout(5000)});requireThat(stream,'worker_invalid_output');const chunks=[];let size=0;
    try{for await(const chunk of stream){size+=chunk.length;requireThat(size<=WORKER_LIMITS.jsonBytes,'worker_invalid_output');chunks.push(chunk);}}finally{stream.destroy();}
    const output=Buffer.concat(chunks).toString('utf8');JSON.parse(output);
    return{output,exitCode:finished.exitCode,provider:{name:vmName(work),commandId:command.cmdId,network:'denied',persistent:false}};
   }finally{clearInterval(timer);await box.stop({signal:AbortSignal.timeout(10000)}).catch(()=>{});}
  }
 };
}
