import {createHash} from 'node:crypto';
import {parse} from 'acorn';
export const surfaceProject='prj_6w9SRvkLFLBOXgQohKyWlpJClCZV';
const paths=new Set(['network/home-map.js','site/network.css','club-footer.css','eyes.js','club-footer.js','site/ink.js','page-transition.js','ui.css','ui.js','site/network.js','network/live.css','index.html','server/network-data.js']);
export const sourceHash=files=>createHash('sha256').update(JSON.stringify([...files].sort((a,b)=>a.path.localeCompare(b.path)))).digest('hex');
export function validateSource(files){
 if(!Array.isArray(files)||files.length!==paths.size||new Set(files.map(f=>f?.path)).size!==paths.size||Buffer.byteLength(JSON.stringify(files))>420000)throw Error('surface_source_invalid');
 for(const file of files){
  if(!file||Object.keys(file).sort().join(',')!=='content,path'||!paths.has(file.path)||typeof file.content!=='string'||file.content.length>140000||file.content.includes('\0'))throw Error('surface_source_invalid');
  if(file.path.endsWith('.js'))parse(file.content,{ecmaVersion:'latest',sourceType:'module'});
 }
 const html=files.find(f=>f.path==='index.html').content;
 if(['id="scene"','id="worlds"','id="panel"','/surface-bridge.js','/network/home-map.js','Claus'].some(s=>!html.includes(s))||/<base\b|http-equiv\s*=\s*["']?refresh/i.test(html))throw Error('surface_required_markup');
 if(Buffer.byteLength(files.find(f=>f.path==='server/network-data.js').content)>24000)throw Error('surface_program_size');
 return sourceHash(files);
}
export function applyChanges(files,changes){
 if(!Array.isArray(changes)||!changes.length||changes.length>8||Buffer.byteLength(JSON.stringify(changes))>64000)throw Error('surface_changes_invalid');
 const next=files.map(f=>({...f}));
 for(const change of changes){
  if(!change||Object.keys(change).sort().join(',')!=='after,before,path'||!paths.has(change.path)||typeof change.before!=='string'||typeof change.after!=='string'||!change.before||change.before===change.after)throw Error('surface_change_invalid');
  const file=next.find(f=>f.path===change.path),at=file?.content.indexOf(change.before)??-1;
  if(at<0||file.content.indexOf(change.before,at+change.before.length)>=0)throw Error('surface_change_not_unique');
  file.content=file.content.slice(0,at)+change.after+file.content.slice(at+change.before.length);
 }
 validateSource(next);return next;
}
