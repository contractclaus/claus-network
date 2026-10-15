import {createRequire} from 'node:module';
import {newQuickJSWASMModuleFromVariant} from 'quickjs-emscripten';
import {validateProgram,programHash} from './runner.mjs';
let enginePromise;
export const serviceProgramHash=programHash;
// No host callbacks, module loader, credentials, clock, network or storage.
// Only JSON crosses this boundary. The caller owns all durable effects.
export async function evaluateService(program,input) {
 const source=validateProgram(program),json=JSON.stringify(input);
 if(Buffer.byteLength(json)>32000)throw Error('isolated_service_input_size');
 enginePromise??=newQuickJSWASMModuleFromVariant(createRequire(import.meta.url)('@jitl/quickjs-singlefile-cjs-release-sync').default).catch(e=>{enginePromise=undefined;throw e;});
 const runtime=(await enginePromise).newRuntime();
 runtime.setMemoryLimit(16*1024*1024);runtime.setMaxStackSize(128*1024);
 const deadline=Date.now()+40;runtime.setInterruptHandler(()=>Date.now()>deadline);
 const context=runtime.newContext();
 try {
  const result=context.evalCode('"use strict";\n'+source+'\nJSON.stringify(serve(JSON.parse('+JSON.stringify(json)+')));');
  if(result.error){result.error.dispose();throw Error('isolated_service_failed');}
  let text;try{text=context.getString(result.value);}finally{result.value.dispose();}
  if(Buffer.byteLength(text)>20000)throw Error('isolated_service_output_size');
  const value=JSON.parse(text);
  if(!value||Array.isArray(value)||typeof value!=='object'||Object.keys(value).some(k=>!['status','body','state'].includes(k))||!Object.hasOwn(value,'body')||!Number.isInteger(value.status)||!((value.status>=200&&value.status<=299)||(value.status>=400&&value.status<=499)))throw Error('isolated_service_output_invalid');
  for(const key of ['body','state'])if(Object.hasOwn(value,key)&&Buffer.byteLength(JSON.stringify(value[key]))>8192)throw Error('isolated_service_output_size');
  return value;
 }finally{context.dispose();runtime.dispose();}
}
