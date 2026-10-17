import fs from 'node:fs';
const root=new URL('../src/application/',import.meta.url),code=fs.readFileSync(new URL('main.js',root),'utf8');
if(Buffer.byteLength(code)>100000||code.split('\n').length>2048)throw Error('application_source_too_large');
fs.writeFileSync(new URL('source.json',root),JSON.stringify({version:2,lines:code.split('\n')},null,2)+'\n');
