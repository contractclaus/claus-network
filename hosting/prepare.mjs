import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
// Produce a deployable site-host directory from canonical repository source.
// Refuse an existing output directory rather than overwrite unrelated work.
const root=fileURLToPath(new URL('../',import.meta.url));
if(process.argv.length!==3)throw Error('Usage: node hosting/prepare.mjs NEW_OUTPUT_DIRECTORY');
const output=path.resolve(process.argv[2]);
await fs.mkdir(output);
for(const name of ['hosting/render.mjs','hosting/navigation.mjs','src/shared/index.mjs','src/shared/site-connect.mjs','src/domains/index.mjs']){
 await fs.mkdir(path.dirname(path.join(output,name)),{recursive:true});
 await fs.copyFile(path.join(root,name),path.join(output,name));
}
await fs.mkdir(path.join(output,'api'));
const gateway=await fs.readFile(path.join(root,'hosting/gateway.mjs'),'utf8');
await fs.writeFile(path.join(output,'api/gateway.mjs'),gateway.replace("from './render.mjs'","from '../hosting/render.mjs'"));
await fs.copyFile(path.join(root,'hosting/vercel.json'),path.join(output,'vercel.json'));
await fs.writeFile(path.join(output,'package.json'),JSON.stringify({name:'claus-network-sites',version:'0.5.0',private:true,type:'module',engines:{node:'24.x'}}));
await fs.mkdir(path.join(output,'scripts'));
await fs.writeFile(path.join(output,'scripts/prepare.mjs'),"import {mkdir,writeFile} from 'node:fs/promises';await mkdir('public',{recursive:true});await writeFile('public/index.html','<!doctype html><title>Claus | Network</title>');\n");
console.log(output);
