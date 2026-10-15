import {digest} from '../shared/index.mjs';

// Only add optional object fields. Existing fields, constraints and visibility
// remain unchanged, so all stored documents and old writers keep their meaning.
export function additiveSchema(before,after) {
 if(digest(before)===digest(after))return true;
 if(before.type!=='object'||after.type!=='object')return false;
 if(before.additionalProperties!==after.additionalProperties||digest([...before.required].sort())!==digest([...after.required].sort()))return false;
 for(const [name,value] of Object.entries(before.properties)){
  if(!Object.hasOwn(after.properties,name)||!additiveSchema(value,after.properties[name]))return false;
 }
 return true;
}
export function additiveCollection(before,after) {
 return !!after&&before.id===after.id&&before.visibility===after.visibility&&additiveSchema(before.schema,after.schema);
}
