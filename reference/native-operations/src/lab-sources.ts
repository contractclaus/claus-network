import {textWindow,textPrefix} from './text.ts';
import {publicUrl,type Source} from './lab-schema.js';
import {readPublicUrl,readRenderedUrl} from './research.js';
import {readXThread} from './x.js';

function postId(raw:string){
  const url=new URL(raw);
  return /^(?:www\.|mobile\.)?(?:x\.com|twitter\.com)$/.test(url.hostname)
    ? url.pathname.match(/^\/(?:[a-z0-9_]+|i)\/status\/(\d{1,19})(?:\/|$)/i)?.[1]
    : undefined;
}

// X's HTML is a sign-in shell. Read the public post through the existing X
// reader; credentials never go to a URL supplied by a post or the model.
export type LabSourceOptions={offset?:number;rendered?:boolean};
export async function readLabSource(raw:string,source?:Source|null,readThread=readXThread,readPage=readPublicUrl,options:LabSourceOptions={}){
  const offset=options.offset??0;
  if(!Number.isSafeInteger(offset)||offset<0||offset>1000000||options.rendered!==undefined&&typeof options.rendered!=='boolean')throw Error('lab_invalid_source_options');
  let url=publicUrl(raw);
  let thread:Awaited<ReturnType<typeof readXThread>>|undefined;
  if(new URL(url).hostname==='t.co'&&source&&postId(source.url)){
    thread=await readThread(postId(source.url)!);
    const entity=thread.posts.flatMap(p=>p.entities?.urls??[]).find(u=>u.url===url);
    if(!entity?.expanded_url)throw Error('lab_source_link_unresolved');
    url=publicUrl(entity.expanded_url);
  }
  const id=postId(url);
  if(!id){
    const page=await (options.rendered?readRenderedUrl(url,offset):readPage(url,0,offset));
    const content=textPrefix(page.content,12000),end=(page.offset??offset)+content.length;
    const nextOffset=page.totalChars>end?end:null;
    return {...page,content,nextOffset,truncated:nextOffset!==null};
  }
  if(!thread?.posts.some(p=>p.id===id))thread=await readThread(id);
  const content=JSON.stringify({posts:thread.posts.map(p=>({id:p.id,username:p.username,text:p.text,
    createdAt:p.created_at,url:p.url,references:p.referenced_tweets??[],
    links:(p.entities?.urls??[]).map((u:any)=>({url:u.url,expandedUrl:u.expanded_url})),
    images:p.images??[]})),incomplete:thread.incomplete,nextParentId:thread.nextParentId,
    instructionAuthority:false});
  return {url:`https://x.com/i/status/${id}`,...textWindow(content,offset,12000),observedAt:thread.observedAt,totalChars:content.length};
}
