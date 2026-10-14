const contentTypes={html:'text/html; charset=utf-8',css:'text/css; charset=utf-8',js:'text/javascript; charset=utf-8',
  json:'application/json; charset=utf-8',svg:'image/svg+xml'};
export async function render(request,{fetcher=fetch,apiOrigin='https://claus-network-api.vercel.app',
  siteOrigin='https://claus-network-sites.vercel.app',frameOrigin='https://claus.si'}={}){
  for(const origin of [apiOrigin,siteOrigin,frameOrigin])if(new URL(origin).origin!==origin||new URL(origin).protocol!=='https:')throw Error('invalid_host_configuration');
  if(siteOrigin===apiOrigin||siteOrigin===frameOrigin)throw Error('release_origin_not_isolated');
  const url=new URL(request.url),match=/^\/r\/([0-9a-f]{64})\/([a-zA-Z0-9_.@+/-]+\.(html|css|js|json|svg))$/.exec(url.pathname);
  const headers={'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer',
    'permissions-policy':'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'access-control-allow-origin':'*','cross-origin-resource-policy':'cross-origin',
    'content-security-policy':`sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' ${siteOrigin}; style-src 'unsafe-inline' ${siteOrigin}; img-src data: ${siteOrigin}; connect-src 'none'; worker-src 'none'; font-src data:; media-src data:; form-action 'none'; base-uri 'none'; object-src 'none'; frame-src 'none'; frame-ancestors ${frameOrigin}`};
  if(!match||match[2].split('/').some(p=>!p||p==='.'||p==='..')||url.search||!['GET','HEAD'].includes(request.method))return new Response('Not found',{status:404,headers});
  try{
    const response=await fetcher(apiOrigin+'/v1/public/releases/sha256%3A'+match[1]+'/file?filePath='+encodeURIComponent(match[2]),{redirect:'error',signal:AbortSignal.timeout(10000)});
    if(response.status===404)return new Response('Not found',{status:404,headers});
    if(!response.ok)throw Error('unavailable');
    const length=Number(response.headers.get('content-length')??0);if(length>3200000)throw Error('invalid_release');
    const body=await response.text();if(Buffer.byteLength(body)>3200000)throw Error('invalid_release');
    const release=JSON.parse(body);
    if(release.id!=='sha256:'+match[1]||!(release.expiresAt===null||Number.isSafeInteger(release.expiresAt)&&release.expiresAt>Date.now()))throw Error('invalid_release');
    const file=release.file??release.files?.find(file=>file.path===match[2]);
    if(!file||file.path!==match[2]||typeof file.content!=='string'||Buffer.byteLength(file.content)>1000000)return new Response('Not found',{status:404,headers});
    return new Response(request.method==='HEAD'?null:file.content,{headers:{...headers,'content-type':contentTypes[match[3]]}});
  }catch{return new Response('Temporarily unavailable',{status:503,headers});}
}
