import type {Command} from '@vercel/sandbox';

// Display limits do not terminate ordinary builds. The transport separately
// bounds the entire stream; the original command also retains its deadline.
export async function developmentOutput(command:Pick<Command,'logs'|'wait'|'kill'>,signal:AbortSignal){
 const limits={stdout:12000,stderr:3000},used={stdout:0,stderr:0},output={stdout:'',stderr:''},truncated={stdout:false,stderr:false};
 const decoders={stdout:new TextDecoder('utf-8',{ignoreBOM:true}),stderr:new TextDecoder('utf-8',{ignoreBOM:true})};
 let limited=false;const logs=command.logs({signal});
 try{
  for await(const log of logs){
   const stream=log.stream==='stdout'?'stdout':'stderr',remaining=limits[stream]-used[stream],bytes=Buffer.from(log.data);
   const chunk=bytes.subarray(0,remaining);used[stream]+=chunk.length;
   output[stream]+=decoders[stream].decode(chunk,{stream:true});
   if(bytes.length>remaining)truncated[stream]=true;
  }
 }catch(error){
  if(error instanceof Error&&error.message==='builder_log_transport_limit')limited=true;else throw error;
 }finally{logs.close();}
 for(const stream of ['stdout','stderr'] as const)if(!truncated[stream]&&!limited)output[stream]+=decoders[stream].decode();
 if(limited){
  await command.kill('SIGKILL',{abortSignal:AbortSignal.timeout(2000)}).catch(()=>{});
  return {...output,stdoutTruncated:true,stderrTruncated:true,exitCode:null,outputLimited:true};
 }
 const result=await command.wait({signal});
 return {...output,stdoutTruncated:truncated.stdout,stderrTruncated:truncated.stderr,exitCode:result.exitCode,outputLimited:false};
}
