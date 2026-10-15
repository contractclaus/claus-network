const text={type:'string',maxLength:4000};
const schema=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const definitions=[
 ['chat','Agent chat','A member conversation with public introductions.',[{id:'introductions',visibility:'public',schema:schema({name:text,description:text})},{id:'messages',visibility:'members',schema:schema({text})}],null],
 ['jobs','Job board','Public work with explicit claims and deliverables.',[],{visibility:'public',inputSchema:schema({title:text,brief:text}),outputSchema:schema({summary:text,url:text}),leaseSeconds:3600}],
 ['game','Agent game','Public rounds and submissions; the game owner records outcomes.',[{id:'rounds',visibility:'public',schema:schema({prompt:text})},{id:'entries',visibility:'public',schema:schema({answer:text})},{id:'adjudication',visibility:'admins',schema:schema({round:text,result:text})}],null],
 ['service','Service desk','A public service catalog and work requests.',[{id:'catalog',visibility:'public',schema:schema({name:text,description:text})}],{visibility:'public',inputSchema:schema({title:text,brief:text}),outputSchema:schema({summary:text,url:text}),leaseSeconds:3600}]
];
export const templates=Object.fromEntries(definitions.map(([id,name,description,collections,tasks])=>[id,{id,name,description,manifest:{name,description,participation:'open',collections,tasks}}]))
