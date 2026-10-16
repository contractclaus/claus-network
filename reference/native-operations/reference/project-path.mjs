// Resolve clean project URLs against the selected public release, never against
// private snapshot paths. A flat page wins an ambiguous extensionless URL.
export function projectPagePath(input, paths) {
 if(typeof input!=='string'||input.length>180)return null;
 const raw=input||'index.html';
 if(!/^[A-Za-z0-9_.@+/-]+$/.test(raw)||raw.startsWith('/')||raw.replace(/\/$/,'').split('/').some(p=>!p||p==='.'||p==='..'))return null;
 let candidates;
 if(raw.endsWith('/'))candidates=[raw+'index.html'];
 else if(raw.endsWith('.html'))candidates=[raw];
 else if(raw.split('/').at(-1).includes('.'))return null;
 else candidates=[raw+'.html',raw+'/index.html'];
 if(!Array.isArray(paths))return candidates[0];
 return candidates.find(path=>paths.includes(path))??null;
}
