import {fallback,http} from 'viem';
const publicEndpoints={1:['https://ethereum-rpc.publicnode.com','https://eth.drpc.org'],8453:['https://mainnet.base.org','https://base-rpc.publicnode.com']};
// Every transport sees the same request. Signed transaction retries use the
// original bytes; this layer never picks a nonce or signs a replacement.
export function operatingRpc(chainId,primary,{httpFactory=http,timeout=8000}={}){
 if(!publicEndpoints[chainId])throw Error('wallet_rpc_chain_unsupported');
 const urls=[...new Set([primary,...publicEndpoints[chainId]].filter(Boolean))];
 return fallback(urls.map(url=>httpFactory(url,{timeout,retryCount:0})),{retryCount:0,rank:false});
}
