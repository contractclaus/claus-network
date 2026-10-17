// Fresh offline JavaScript prototypes use high reasoning to reduce long-provider-call risk.
// Existing requests retain their stored profile. Reviewed publishing and Solidity keep max.
export function builderModelProfile(work?:{purpose:string;runtime:string}){
 const prototype=work?.purpose==='prototype'&&work.runtime==='javascript';
 return {model:'gpt-6.1-sol',provider:'openai',reasoning:{effort:prototype?'high':'max',context:'all_turns'}};
}
