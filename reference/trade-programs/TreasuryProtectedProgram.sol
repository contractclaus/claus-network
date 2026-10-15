// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface IProgramManager { function transfer(address to,uint256 id,uint256 amount) external returns(bool); }
library ProgramTypes {
 struct Trade {uint256 id;address module;address sender;bool buy;int128 amount0;int128 amount1;uint256 feeEth;uint256 moduleFeeEth;uint256 blockNumber;uint256 timestamp;bytes32 dataHash;}
}
interface IProgram {
 function quote(address sender,bool buy,int256 amountSpecified,uint160 price,uint128 liquidity,bytes calldata data) external view returns(uint256[6] memory);
 function onTrade(ProgramTypes.Trade calldata trade,bytes calldata data) external returns(bytes4);
}
/// @notice Adapter for native-approved trade programs. The r3 core, recipient
/// contracts and owner rights are unchanged. This protects the native lane;
/// it does not claim to revoke the existing human owner's setModule authority.
contract TreasuryProtectedProgram is IProgram {
 address public constant HOST=0xea0436465676eA7001535Bfe2E5cbd4b137b7f91;
 address public constant MANAGER=0x000000000004444c5dc75cB358380D2e3dE08A90;
 uint256 public constant TREASURY_PIPS=13_000;
 uint256 public constant MAX_PLAN_PIPS=149_000;
 address public immutable program;
 bytes32 public immutable programCodeHash;
 error InvalidProgram();error InvalidReceipt();
 constructor(address target,bytes32 codeHash){
  if(target==address(0)||target==HOST||target==MANAGER||target==address(this)||target.code.length==0||target.codehash!=codeHash)revert InvalidProgram();
  program=target;programCodeHash=codeHash;
 }
 function defaults() private pure returns(uint256[6] memory a){return [uint256(13000),3000,1500,2000,3500,0];}
 function quote(address sender,bool buy,int256 amountSpecified,uint160 price,uint128 liquidity,bytes calldata data) external view returns(uint256[6] memory a){
  if(program.codehash!=programCodeHash)return defaults();
  bytes memory input=abi.encodeCall(IProgram.quote,(sender,buy,amountSpecified,price,liquidity,data));address target=program;bool ok;
  assembly("memory-safe"){ok:=staticcall(50000,target,add(input,32),mload(input),a,192) ok:=and(ok,eq(returndatasize(),192))}
  if(!ok)return defaults();
  a[0]=TREASURY_PIPS;uint256 sum=TREASURY_PIPS;
  for(uint256 i=1;i<6;i++){if(a[i]>MAX_PLAN_PIPS)return defaults();sum+=a[i];}
  if(sum>MAX_PLAN_PIPS)return defaults();
 }
 function onTrade(ProgramTypes.Trade calldata trade,bytes calldata data) external returns(bytes4){
  if(msg.sender!=HOST||trade.module!=address(this)||program.codehash!=programCodeHash)revert InvalidReceipt();
  // Only the exact program-fee claim attested by the fixed host moves. There
  // is no ETH sender, allowance, arbitrary recipient or treasury withdrawal.
  if(trade.moduleFeeEth!=0&&!IProgramManager(MANAGER).transfer(program,0,trade.moduleFeeEth))revert InvalidReceipt();
  if(IProgram(program).onTrade(trade,data)!=IProgram.onTrade.selector)revert InvalidReceipt();
  return IProgram.onTrade.selector;
 }
}
