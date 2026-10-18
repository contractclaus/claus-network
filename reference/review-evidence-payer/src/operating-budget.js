import {refreshCapitalCash} from './capital/budget.js';
const valid=x=>x&&['reserve','commit','cancel'].includes(x.operation)&&/^(?:infrastructure:sha256:[a-f0-9]{64}:lease|owned:sha256:[a-f0-9]{64}:(?:build|storage|volume|service)):[0-9]{1,9}$/.test(x.id??'')&&/^[1-9][0-9]{0,8}$/.test(x.maximum??'')&&BigInt(x.maximum)<=200000000n;
export async function operatingBudget(db,input){
 if(!valid(input))throw Error('operating_budget_invalid');
 if(input.operation==='reserve')await refreshCapitalCash(db);
 const [row]=await db`SELECT claus_operating_commitment(${input.id},${input.maximum}::bigint,${input.operation}) AS result`;
 return row.result;
}
