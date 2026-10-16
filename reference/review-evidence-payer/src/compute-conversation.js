// A model response proposes a function call; it never executes it or grants
// the caller additional project, wallet or host authority.
const fail=()=>{throw Object.assign(Error('invalid_inference_conversation'),{code:'invalid_inference_conversation'});};
const keys=(v,list)=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!list.includes(k)))fail();};
const str=(v,max=65536)=>{if(typeof v!=='string'||v.length>max)fail();};
const callId=v=>{str(v,160);if(!/^[a-zA-Z0-9_-]+$/.test(v))fail();};
const name=v=>{str(v,64);if(!/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(v))fail();};
export function validateConversation(input,tools){
 if(typeof input==='string'){if(!input.trim())fail();str(input);}
 else {
  if(!Array.isArray(input)||!input.length||input.length>64)fail();const calls=new Map(),outputs=new Set();
  for(const item of input){
   if(item?.type==='function_call'){
    keys(item,['type','call_id','name','arguments']);callId(item.call_id);name(item.name);str(item.arguments,16000);if(calls.has(item.call_id))fail();try{const a=JSON.parse(item.arguments);if(!a||typeof a!=='object'||Array.isArray(a))fail();}catch{fail();}calls.set(item.call_id,item.name);
   }else if(item?.type==='function_call_output'){
    keys(item,['type','call_id','output']);callId(item.call_id);str(item.output,32000);if(!calls.has(item.call_id)||outputs.has(item.call_id))fail();outputs.add(item.call_id);
   }else {
    keys(item,['role','content']);if(!['user','assistant'].includes(item.role))fail();
    if(typeof item.content==='string')str(item.content);
    else {if(item.role!=='user'||!Array.isArray(item.content)||!item.content.length||item.content.length>8)fail();for(const p of item.content){
     if(p?.type==='input_text'){keys(p,['type','text']);str(p.text);}
     else if(p?.type==='input_image'){keys(p,['type','image_url','detail']);str(p.image_url,60000);if(!/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(p.image_url)||p.detail!==undefined&&!['low','auto'].includes(p.detail))fail();}
     else fail();
    }}
   }
  }
  if(calls.size!==outputs.size)fail();
 }
 if(tools!==undefined){
  if(!Array.isArray(tools)||tools.length>8)fail();const names=new Set();
  for(const t of tools){keys(t,['type','name','description','parameters','strict']);if(t.type!=='function')fail();name(t.name);if(names.has(t.name))fail();names.add(t.name);if(t.description!==undefined)str(t.description,2000);if(t.strict!==undefined&&typeof t.strict!=='boolean')fail();if(!t.parameters||typeof t.parameters!=='object'||Array.isArray(t.parameters)||t.parameters.type!=='object'||JSON.stringify(t.parameters).length>8000)fail();}
 }
 if(Buffer.byteLength(JSON.stringify({input,tools}))>65536)fail();return {input,tools};
}
export const conversationBytes=r=>Buffer.byteLength(typeof r.input==='string'&&!r.tools? r.input:JSON.stringify({input:r.input,tools:r.tools}));
export function validateToolOutput(calls,tools){
 if(!Array.isArray(calls)||calls.length>8)fail();const names=new Set((tools??[]).map(t=>t.name)),ids=new Set();
 for(const c of calls){keys(c,['id','type','function']);if(c.type!=='function')fail();callId(c.id);if(ids.has(c.id))fail();ids.add(c.id);keys(c.function,['name','arguments']);name(c.function.name);if(!names.has(c.function.name))fail();str(c.function.arguments,16000);try{const v=JSON.parse(c.function.arguments);if(!v||typeof v!=='object'||Array.isArray(v))fail();}catch{fail();}}
 return calls;
}
