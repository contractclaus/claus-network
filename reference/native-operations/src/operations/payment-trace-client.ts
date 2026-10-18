const origin='https://claus-ecosystem-payments.vercel.app';
export async function readPaymentTrace(id:string,{request=fetch,secret,base=origin}:{request?:typeof fetch;secret?:string;base?:string}={}){
 if(typeof id!=='string'||!/^[a-zA-Z0-9:_-]{1,160}$/.test(id))throw Error('payment_trace_id_invalid');
 if(base!==origin||!secret)return {id,found:null,unavailable:'payment_trace_not_configured',readOnly:true,holdsChanged:false};
 try{
  const r=await request(origin+'/api/trace/'+encodeURIComponent(id),{method:'GET',redirect:'error',headers:{authorization:'Bearer '+secret},signal:AbortSignal.timeout(15000)});
  if(!r.ok)return {id,found:null,unavailable:'payment_trace_http_'+r.status,readOnly:true,holdsChanged:false};
  const raw=await r.text();if(Buffer.byteLength(raw)>100000)throw Error('payment_trace_size');const value=JSON.parse(raw);
  if(value.id!==id||value.readOnly!==true||value.holdsChanged!==false||!Array.isArray(value.records)||value.records.length>3)throw Error('payment_trace_shape');return value;
 }catch{return {id,found:null,unavailable:'payment_trace_transport_unavailable',readOnly:true,holdsChanged:false};}
}
