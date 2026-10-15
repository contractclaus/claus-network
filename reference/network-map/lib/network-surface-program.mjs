import {newQuickJSWASMModuleFromVariant} from 'quickjs-emscripten';
import {createRequire} from 'node:module';

let enginePromise;

// Candidate code only sees a JSON copy inside QuickJS. No host handles are installed.
export async function transformPublicNetwork(source,input,{milliseconds=80}={}){
 if(typeof source!=='string'||Buffer.byteLength(source)>24000)throw Error('surface_program_size');
 const json=JSON.stringify(input);if(Buffer.byteLength(json)>768000)throw Error('surface_input_size');
 const variant=createRequire(import.meta.url)('@jitl/quickjs-singlefile-cjs-release-sync').default;
 const engine=await (enginePromise??=newQuickJSWASMModuleFromVariant(variant)),runtime=engine.newRuntime();
 runtime.setMemoryLimit(24*1024*1024);runtime.setMaxStackSize(256*1024);
 const end=Date.now()+milliseconds;runtime.setInterruptHandler(()=>Date.now()>end);
 const context=runtime.newContext();
 try{
  const result=context.evalCode('"use strict";\n'+source+'\nJSON.stringify(transform(JSON.parse('+JSON.stringify(json)+')));');
  if(result.error){result.error.dispose();throw Error('surface_program_failed');}
  let output;try{output=context.getString(result.value);}finally{result.value.dispose();}
  if(output.length>1000000)throw Error('surface_output_size');
  const value=JSON.parse(output);
  // Presentation may add bounded derived fields or reorder nodes, never rewrite facts.
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('surface_output_shape');
  for(const key of Object.keys(input))if(key!=='nodes'&&JSON.stringify(value[key])!==JSON.stringify(input[key]))throw Error('surface_fact_changed');
  if(Array.isArray(input.nodes)){
   if(!Array.isArray(value.nodes)||value.nodes.length!==input.nodes.length)throw Error('surface_nodes_changed');
   const nodes=new Map(value.nodes.map(n=>[n?.id,n]));
   if(nodes.size!==input.nodes.length)throw Error('surface_nodes_changed');
   for(const node of input.nodes){const next=nodes.get(node.id);if(!next)throw Error('surface_nodes_changed');for(const key of Object.keys(node))if(JSON.stringify(next[key])!==JSON.stringify(node[key]))throw Error('surface_fact_changed');}
  }
  return value;
 }finally{context.dispose();runtime.dispose();}
}
