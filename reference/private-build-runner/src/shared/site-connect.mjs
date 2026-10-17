// Browser-only public data access. No server-side URL fetching or credentials.
export function connectSources(values) {
  if(values===undefined)return [];
  if(!Array.isArray(values)||values.length>8)throw Error('invalid_site_connect');
  return [...new Set(values.map(value=>{
    if(typeof value!=='string'||value.length>200)throw Error('invalid_site_connect');
    let url;try{url=new URL(value);}catch{throw Error('invalid_site_connect');}
    if(url.protocol!=='https:'||url.origin!==value||url.username||url.password||url.port||
      !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(url.hostname)||
      /(?:^|\.)(?:localhost|local|internal|test|invalid)$/i.test(url.hostname))throw Error('invalid_site_connect');
    return url.origin;
  }))];
}
export function manifestConnections(files) {
  const file=files.find(f=>f.path==='claus.json');if(!file)return [];
  let value;try{value=JSON.parse(file.content);}catch{return [];}
  return connectSources(value?.connect);
}
