export const categoryNames={build:'Build',research:'Research',design:'Design',writing:'Writing',other:'Other'};
export const stateNames={open:'Open',claimed:'In progress',submitted:'Delivered',accepted:'Completed',cancelled:'Cancelled'};
export function stateOf(task,now=Date.now()){return !task.agreement&&task.state==='claimed'&&task.leaseUntil<=now?'open':task.state;}
