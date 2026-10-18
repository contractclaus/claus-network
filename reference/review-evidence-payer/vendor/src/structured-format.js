const object=v=>!!v&&typeof v==='object'&&!Array.isArray(v);
const fail=()=>{throw Error('invalid_structured_format');};
export function validateText(text){
 if(text===undefined)return;
 if(!object(text)||Object.keys(text).some(k=>k!=='format')||!object(text.format))fail();const f=text.format;
 if(f.type==='text'||f.type==='json_object'){if(Object.keys(f).length!==1)fail();return;}
 if(f.type!=='json_schema'||f.strict!==true||typeof f.name!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(f.name)||Object.keys(f).some(k=>!['type','name','strict','schema','description'].includes(k))||f.description!==undefined&&(typeof f.description!=='string'||f.description.length>2000)||JSON.stringify(f.schema??null).length>100000)fail();
 let nodes=0;
 function schema(s,depth=0){
  if(!object(s)||++nodes>3000||depth>16||Object.keys(s).some(k=>!['type','properties','required','additionalProperties','items','enum','anyOf','description'].includes(k)))fail();
  if(s.description!==undefined&&(typeof s.description!=='string'||s.description.length>2000))fail();
  if(s.anyOf!==undefined){if(Object.keys(s).some(k=>!['anyOf','description'].includes(k))||!Array.isArray(s.anyOf)||!s.anyOf.length||s.anyOf.length>12)fail();for(const x of s.anyOf)schema(x,depth+1);return;}
  const types=Array.isArray(s.type)?s.type:[s.type];if(!types.length||types.some(x=>!['object','array','string','number','integer','boolean','null'].includes(x))||new Set(types).size!==types.length)fail();
  if(s.enum!==undefined&&(!Array.isArray(s.enum)||!s.enum.length||s.enum.length>1000||s.enum.some(x=>x!==null&&!['string','number','boolean'].includes(typeof x))))fail();
  if(types.includes('object')){if(!object(s.properties)||s.additionalProperties!==false||!Array.isArray(s.required)||new Set(s.required).size!==s.required.length||s.required.length!==Object.keys(s.properties).length||s.required.some(x=>!Object.hasOwn(s.properties,x)))fail();for(const [k,v]of Object.entries(s.properties)){if(['__proto__','prototype','constructor'].includes(k))fail();schema(v,depth+1);}}
  else if(s.properties!==undefined||s.required!==undefined||s.additionalProperties!==undefined)fail();
  if(types.includes('array'))schema(s.items,depth+1);else if(s.items!==undefined)fail();
 }
 if(f.schema?.type!=='object'||f.schema.anyOf)fail();schema(f.schema);
}
export function inspectStructuredOutput(text,message,status){
 if(!text||text.format.type==='text')return null;
 if(message?.responseItems?.some(x=>x.type==='message'&&x.content?.some(c=>c.type==='refusal')))return {valid:false,reason:'refusal'};
 if(status!=='completed')return {valid:false,reason:'incomplete'};
 let value;try{value=JSON.parse(message.content);}catch{return {valid:false,reason:'invalid_json'};}
 if(text.format.type==='json_object')return {valid:object(value),reason:object(value)?null:'schema_mismatch'};
 function match(s,v){
  if(s.anyOf)return s.anyOf.some(x=>match(x,v));const types=Array.isArray(s.type)?s.type:[s.type];
  const ok=types.some(t=>t==='null'?v===null:t==='object'?object(v):t==='array'?Array.isArray(v):t==='integer'?Number.isInteger(v):t==='number'?typeof v==='number'&&Number.isFinite(v):typeof v===t);
  if(!ok||s.enum&&!s.enum.some(x=>x===v))return false;
  if(object(v))return Object.keys(v).length===s.required.length&&s.required.every(k=>Object.hasOwn(v,k)&&match(s.properties[k],v[k]));
  if(Array.isArray(v))return v.every(x=>match(s.items,x));return true;
 }
 const valid=match(text.format.schema,value);return {valid,reason:valid?null:'schema_mismatch'};
}
