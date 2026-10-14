import {requireThat} from '../shared/index.mjs';

export function dealAsset(value='ETH') {
 requireThat(value==='ETH'||value==='CLAUS','unsupported_deal_asset');
 return value;
}
export const isTokenDeal=value=>dealAsset(value)==='CLAUS';
export const assetFields=value=>isTokenDeal(value)?{asset:'CLAUS'}:{};
export const amountDescription=value=>isTokenDeal(value)?'CLAUS base units (10^18 base units = 1 CLAUS)':'native ETH wei';
