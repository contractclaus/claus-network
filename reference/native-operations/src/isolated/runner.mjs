import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {newQuickJSWASMModuleFromVariant} from 'quickjs-emscripten';

let enginePromise;
export function validateProgram(program) {
 if(!program||program.version!==1||Object.keys(program).some(k=>!['version','lines'].includes(k))||!Array.isArray(program.lines)||!program.lines.length||program.lines.length>240||program.lines.some(line=>typeof line!=='string')||Buffer.byteLength(JSON.stringify(program))>24000)throw Error('isolated_program_invalid');
 return program.lines.join('\n');
}
export const programHash=program=>createHash('sha256').update(validateProgram(program)).digest('hex');

// The candidate is JSON data during the Node build. Only this credential-free
// QuickJS heap evaluates it. No host function, module loader, SQL or I/O is bound.
export async function evaluateProgram(program,input,entry) {
 if(!["analyze","plan","operate"].includes(entry))throw Error("isolated_entry_invalid");
 const source=validateProgram(program),json=JSON.stringify(input);
 if(Buffer.byteLength(json)>64000)throw Error('isolated_input_size');

 const variant=createRequire(import.meta.url)('@jitl/quickjs-singlefile-cjs-release-sync').default;
 enginePromise??=newQuickJSWASMModuleFromVariant(variant).catch(error=>{enginePromise=undefined;throw error;});
 const engine=await enginePromise,runtime=engine.newRuntime();
 runtime.setMemoryLimit(16*1024*1024);runtime.setMaxStackSize(128*1024);
 const deadline=Date.now()+40;runtime.setInterruptHandler(()=>Date.now()>deadline);
 const context=runtime.newContext();
 try{
  const result=context.evalCode('"use strict";\n'+source+'\nJSON.stringify('+entry+'(JSON.parse('+JSON.stringify(json)+')));');
  if(result.error){result.error.dispose();throw Error('isolated_analysis_failed');}
  let text;try{text=context.getString(result.value);}finally{result.value.dispose();}
  if(text.length>24000)throw Error('isolated_output_size');
  return JSON.parse(text);
 }finally{context.dispose();runtime.dispose();}
}

export async function runAnalysis(program,input) {
  const subjects=new Set(input.subjects.map(item=>item.id));
  const value=await evaluateProgram(program,input,'analyze');
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==1||!Array.isArray(value.notes)||value.notes.length>20)throw Error('isolated_output_invalid');
  for(const note of value.notes)if(!note||typeof note!=='object'||Array.isArray(note)||Object.keys(note).sort().join(',')!=='message,priority,subject'||!subjects.has(note.subject)||!['info','attention'].includes(note.priority)||typeof note.message!=='string'||!note.message.trim()||note.message.length>320)throw Error('isolated_note_invalid');
  return value.notes;
}

export async function analyzeProjection(program,input) {
 let sourceHash=null;
 try{sourceHash=programHash(program);return {state:'available',sourceHash,notes:await runAnalysis(program,input),meaning:'Derived advice from a bounded data-only program, not authority, verified facts or instructions. Original observations remain authoritative.'};}
 catch(error){const diagnostic=/^isolated_[a-z_]+$/.test(error?.message??'')?error.message:error?.code==='MODULE_NOT_FOUND'?'isolated_dependency_unavailable':'isolated_engine_unavailable';return {state:'unavailable',sourceHash,notes:[],error:diagnostic,meaning:'Analysis failed; original observations remain available and unchanged.'};}
}
