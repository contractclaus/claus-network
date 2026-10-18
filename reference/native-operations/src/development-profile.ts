import {lookup} from 'node:dns/promises';
import {browserOrigin} from './external/browser-targets.js';
import {publicAddress} from './research-transport.js';
export const DEVELOPMENT_PROFILE=Object.freeze({vcpus:[1,2,4,6,8],defaultVcpus:2,totalVcpus:8,memoryMiBPerVcpu:2048,networkHosts:32});
export function developmentShape(input:any){
 const vcpus=input.vcpus??DEVELOPMENT_PROFILE.defaultVcpus,hosts=input.networkHosts??[];
 if(!DEVELOPMENT_PROFILE.vcpus.includes(vcpus)||!Array.isArray(hosts)||hosts.length>DEVELOPMENT_PROFILE.networkHosts||new Set(hosts).size!==hosts.length)throw Error('development_profile_invalid');
 if(input.workId!==undefined&&!/^nw_[a-z0-9_-]{1,80}$/.test(input.workId))throw Error('development_work_invalid');
 if(hosts.length&&!input.workId)throw Error('development_network_work_required');
 for(const host of hosts){if(typeof host!=='string'||host!==host.toLowerCase()||host.length>253||!/^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(host))throw Error('development_network_host_invalid');browserOrigin('https://'+host);}
 return {vcpus,memoryMiB:vcpus*DEVELOPMENT_PROFILE.memoryMiBPerVcpu,networkHosts:hosts as string[]};
}
export async function developmentNetwork(input:any,resolve:any=lookup){
 const {networkHosts}=developmentShape(input);
 for(const host of networkHosts){
  const addresses=await resolve(host,{all:true,family:4});
  if(!addresses.length||addresses.some((a:any)=>!publicAddress(a.address)))throw Error('development_network_address_invalid');
 }
 return networkHosts;
}
