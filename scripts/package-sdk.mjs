import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const root=path.resolve(import.meta.dirname,'..'),output=path.resolve(process.argv[2]??path.join(root,'dist-sdk'));
const source=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
if(!/^[a-f0-9]{40}$/.test(source))throw Error('Immutable source required');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'claus-sdk-'));
try{
 const manifest=JSON.parse(fs.readFileSync(root+'/interfaces/sdk-package.json','utf8'));
 const files=['interfaces/sdk.mjs','interfaces/agent-client.mjs','interfaces/contract.mjs','interfaces/data-routes.mjs','interfaces/data-record-routes.mjs','interfaces/work-planning-routes.mjs','interfaces/infrastructure-routes.mjs','src/work-planning/actions.mjs'];
 const hashes={};for(const file of files){const bytes=fs.readFileSync(root+'/'+file);fs.mkdirSync(path.dirname(temp+'/'+file),{recursive:true});fs.writeFileSync(temp+'/'+file,bytes);hashes[file]=createHash('sha256').update(bytes).digest('hex');}
 fs.writeFileSync(temp+'/package.json',JSON.stringify(manifest,null,2)+'\n');
 fs.writeFileSync(temp+'/index.mjs',"export {createClient,ClausNetworkError,DEFAULT_API_ORIGIN} from './interfaces/sdk.mjs';\nexport {createAgentClient} from './interfaces/agent-client.mjs';\nexport {ROUTES,API_VERSION} from './interfaces/contract.mjs';\n");
 fs.writeFileSync(temp+'/README.md',fs.readFileSync(root+'/docs/sdk-package.md'));
 fs.writeFileSync(temp+'/LICENSE','MIT License\n\nCopyright (c) 2026 Claus\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.\n');
 fs.writeFileSync(temp+'/provenance.json',JSON.stringify({repository:manifest.repository.url,source,version:manifest.version,files:hashes},null,2)+'\n');
 fs.mkdirSync(output,{recursive:true});
 const packed=JSON.parse(execFileSync('npm',['pack','--ignore-scripts','--json','--pack-destination',output],{cwd:temp,encoding:'utf8'}));
 const file=packed[0].filename,bytes=fs.readFileSync(path.join(output,file));
 fs.writeFileSync(output+'/SHA256SUMS',createHash('sha256').update(bytes).digest('hex')+'  '+file+'\n');
 fs.writeFileSync(output+'/provenance.json',fs.readFileSync(temp+'/provenance.json'));
 console.log(JSON.stringify({file,bytes:bytes.length,source,version:manifest.version}));
}finally{fs.rmSync(temp,{recursive:true,force:true});}
