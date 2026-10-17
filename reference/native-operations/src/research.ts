import {textWindow} from './text.ts';
import {researchUrl,researchContentType,researchText} from './research-policy.js';
import {readPublicBytes} from './research-transport.js';
export {publicAddress} from './research-transport.js';

export function sourceText(text:string,type:string,baseUrl?:string) {
  if(!/text\/html/i.test(type))return text;
  const entities:Record<string,string>={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '};
  const decode=(value:string)=>value.replace(/&(amp|lt|gt|quot|apos|nbsp);|&#(x[0-9a-f]+|[0-9]+);/gi,(_match,key:string,numeric:string)=>{
    if(key)return entities[key.toLowerCase()];
    const code=numeric[0].toLowerCase()==='x'?parseInt(numeric.slice(1),16):Number(numeric);
    return code>0&&code<=0x10ffff&&!(code>=0xd800&&code<=0xdfff)?String.fromCodePoint(code):'\uFFFD';
  });
  // Network byte limits do not bound regex backtracking. Walk forward once,
  // including malformed tags, so an untrusted page cannot stall every worker.
  const lower=text.replace(/[A-Z]/g,c=>c.toLowerCase()),out:string[]=[],anchors:string[]=[];
  let at=0,outputSize=0;
  const append=(value:string,entities=true)=>{const content=entities?decode(value):value;out.push(content);outputSize+=content.length;};
  const space=(c:string)=>c===' '||c==='\t'||c==='\n'||c==='\r'||c==='\f';
  const hrefFrom=(start:number,end:number)=>{
    let p=start;
    while(p<end){
      while(p<end&&(space(text[p])||text[p]==='/'))p++;
      const key=p;
      while(p<end&&!space(text[p])&&text[p]!=='='&&text[p]!=='/')p++;
      const name=lower.slice(key,p);
      while(p<end&&space(text[p]))p++;
      if(text[p]!=='='){if(p===key)p++;continue;}
      p++;while(p<end&&space(text[p]))p++;
      const quote=text[p]==='"'||text[p]==="'"?text[p++]:'';
      const value=p;
      while(p<end&&(quote?text[p]!==quote:!space(text[p])))p++;
      const raw=text.slice(value,p);if(quote&&p<end)p++;
      if(name==='href')return raw;
    }
    return '';
  };
  while(at<text.length&&outputSize<2000000){
    if(text[at]!=='<'){
      const next=text.indexOf('<',at),end=next<0?text.length:next;
      append(text.slice(at,end));at=end;continue;
    }
    if(text.startsWith('<!--',at)){
      const end=text.indexOf('-->',at+4);at=end<0?text.length:end+3;continue;
    }
    let p=at+1;
    const closing=text[p]==='/';if(closing)p++;
    const nameStart=p;
    while(p<text.length&&/[a-z0-9]/.test(lower[p]))p++;
    if(p===nameStart||!/[a-z]/.test(lower[nameStart])){append('<');at++;continue;}
    const name=lower.slice(nameStart,p),attributes=p;
    let quote='';
    while(p<text.length){
      const c=text[p];
      if(quote){if(c===quote)quote='';}
      else if(c==='"'||c==="'")quote=c;
      else if(c==='>'||c==='<')break;
      p++;
    }
    if(text[p]!=='>'){append(text.slice(at,p));at=p;continue;}
    at=p+1;
    if(!closing&&(name==='script'||name==='style')){
      let end=lower.indexOf('</'+name,at);
      while(end>=0){
        const after=lower[end+name.length+2];
        if(after==='>'||after==='/'||space(after))break;
        end=lower.indexOf('</'+name,end+name.length+2);
      }
      at=end<0?text.length:end;continue;
    }
    if(name==='a'){
      if(closing){const url=anchors.pop();if(url)append(' ('+url+')',false);}
      else {
        let href='';
        try {
          const raw=hrefFrom(attributes,p);
          if(raw){const url=new URL(decode(raw),baseUrl);if(url.protocol==='http:')url.protocol='https:';
            if(url.protocol==='https:'&&!url.username&&!url.password&&url.href.length<=2000)href=url.href;}
        }catch{/* Invalid links remain plain text. */}
        anchors.push(href);
      }
    }
    append(name==='br'||closing&&/^(p|div|section|h[1-6]|li|tr|pre)$/.test(name)?'\n':' ');
  }
  if(at<text.length)append('\n[Source text truncated]\n');
  // Collapse empty lines in another forward pass, without a retrying regex.
  const lines=out.join('').split('\n'),clean:string[]=[];
  let blank=false;
  for(const line of lines){const empty=line.trim().length===0;if(!empty||!blank)clean.push(line);blank=empty;}
  return clean.join('\n');
}

export async function readPublicImage(raw:string,redirects=0):Promise<{dataUrl:string;url:string}> {
  const result=await readPublicBytes(raw,{limit:1900000,timeoutMs:20000,redirects,headers:{Accept:'image/png,image/jpeg,image/webp'},contentType(headers){
    const type=String(headers['content-type']??'').split(';')[0].trim().toLowerCase();
    if(!['image/png','image/jpeg','image/webp'].includes(type))throw Error('unsupported_public_image');
    return type;
  }});
  return {dataUrl:publicImageData(result.bytes,result.type),url:result.url};
}
export function publicImageData(b:Buffer,type:string){
  const actual=b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'image/png':b.length>=3&&b[0]===255&&b[1]===216&&b[2]===255?'image/jpeg':b.length>=12&&b.toString('ascii',0,4)==='RIFF'&&b.toString('ascii',8,12)==='WEBP'?'image/webp':null;
  if(actual!==type)throw Error('unsupported_public_image');
  return `data:${type};base64,${b.toString('base64')}`;
}
export async function readRenderedUrl(raw:string,offset=0) {
  const url=researchUrl(raw);
  // Original target and renderer share one deadline and public-address checks.
  const result=await readPublicUrl(`https://r.jina.ai/${url.href}`,0,offset,{timeoutMs:30000,validateTarget:url.href,headers:{'X-Timeout':'20','X-No-Cache':'true'}});
  return {...result,url:url.href,transport:'jina-rendered-public-page',readerUrl:result.url};
}
export async function readPublicUrl(raw:string,redirects=0,offset=0,options:{timeoutMs?:number;headers?:Record<string,string>;validateTarget?:string}={}):Promise<{url:string;content:string;offset?:number;observedAt:string;totalChars:number;nextOffset:number|null;truncated:boolean;instructionAuthority:false}> {
  if(!Number.isSafeInteger(offset)||offset<0||offset>1000000)throw new Error('invalid_source_offset');
  const result=await readPublicBytes(raw,{limit:1000000,timeoutMs:options.timeoutMs??15000,redirects,validateTarget:options.validateTarget,headers:{Accept:'text/html,text/plain,text/markdown,application/json',...options.headers},contentType:(headers,url)=>researchContentType(headers['content-type']??'',headers['content-disposition'],url)});
  const content=sourceText(researchText(result.bytes),result.type,result.url),page=textWindow(content,offset,24000);
  return {url:result.url,observedAt:new Date().toISOString(),...page,totalChars:content.length,truncated:page.nextOffset!==null,instructionAuthority:false};
}
