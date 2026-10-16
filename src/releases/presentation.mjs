// Public presentation data only. Never render project-supplied HTML.
export function imageURL(value,release){
 if(typeof value!=='string'||value.length>2048)return null;
 if(/^https:\/\//.test(value)){
  try{const u=new URL(value),h=u.hostname.toLowerCase();if(u.username||u.password||u.port&&u.port!=='443'||!h.includes('.')||/[\[\]:]/.test(h)||/^\d+(?:\.\d+){3}$/.test(h)||/(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(h))return null;return u.href;}catch{return null;}
 }
 if(!release||!/^https:\/\/claus-network-sites\.vercel\.app\/r\/[a-f0-9]{64}\/index\.html$/.test(release.url??'')||!/^[-a-zA-Z0-9_./]+\.svg$/.test(value)||value.startsWith('/')||value.split('/').some(p=>!p||p==='.'||p==='..')||!release.files?.some(f=>f.path===value))return null;
 return new URL(value,release.url).href;
}
export function presentation(manifest,release){
 if(!manifest||manifest.schema!=='claus-project/1')return null;
 return {name:typeof manifest.name==='string'?manifest.name.trim().slice(0,80):'',description:typeof manifest.description==='string'?manifest.description.trim().slice(0,500):'',logo:imageURL(manifest.logo,release),preview:imageURL(manifest.preview,release)};
}
export function publicPresentation(value){
 if(!value||typeof value!=='object')return null;
 return {name:typeof value.name==='string'?value.name.slice(0,80):'',description:typeof value.description==='string'?value.description.slice(0,500):'',logo:imageURL(value.logo),preview:imageURL(value.preview)};
}
