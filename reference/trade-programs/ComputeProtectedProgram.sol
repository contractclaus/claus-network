// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface IProgramManager { function transfer(address to,uint256 id,uint256 amount) external returns(bool); }
library ProgramTypes {
    struct Trade {uint256 id;address module;address sender;bool buy;int128 amount0;int128 amount1;uint256 feeEth;uint256 moduleFeeEth;uint256 blockNumber;uint256 timestamp;bytes32 dataHash;}
}
interface IProgram {
    function quote(address,bool,int256,uint160,uint128,bytes calldata) external view returns(uint256[6] memory);
    function onTrade(ProgramTypes.Trade calldata,bytes calldata) external returns(bytes4);
}
interface IReceiptHost { function pending(uint256) external view returns(bytes32); }

/// @notice Fixed allocation boundary for Claus' reviewed program lane.
/// @dev The permanent trading core is unchanged. The human owner still holds
/// setModule authority; this adapter constrains the automated installation lane.
contract ComputeProtectedProgram is IProgram {
    address public constant HOST=0xea0436465676eA7001535Bfe2E5cbd4b137b7f91;
    address public constant MANAGER=0x000000000004444c5dc75cB358380D2e3dE08A90;
    address public constant COMPUTE=0x3dc1183Ff95889359e00987b55D9164Aad306762;
    uint256 public constant TREASURY_PIPS=12_000;
    uint256 public constant COMPUTE_PIPS=1_000;
    uint256 public constant MAX_PLAN_PIPS=149_000;
    address public immutable program;
    bytes32 public immutable programCodeHash;
    mapping(uint256=>bool) public computeSettled;
    error InvalidProgram(); error InvalidReceipt();
    event ComputeSettled(uint256 indexed receiptId,uint256 amount);

    constructor(address target,bytes32 codeHash) {
        if(target==address(0)||target==HOST||target==MANAGER||target==COMPUTE||target==address(this)
            ||target.code.length==0||target.codehash!=codeHash) revert InvalidProgram();
        program=target; programCodeHash=codeHash;
    }
    function defaults() private pure returns(uint256[6] memory) {
        return [TREASURY_PIPS,3_000,1_500,2_000,3_500,COMPUTE_PIPS];
    }
    function quote(address sender,bool buy,int256 amountSpecified,uint160 price,uint128 liquidity,bytes calldata data)
        external view returns(uint256[6] memory a)
    {
        if(program.codehash!=programCodeHash) return defaults();
        bytes memory input=abi.encodeCall(IProgram.quote,(sender,buy,amountSpecified,price,liquidity,data));
        address target=program; bool ok;
        assembly("memory-safe") {
            ok:=staticcall(50000,target,add(input,32),mload(input),a,192)
            ok:=and(ok,eq(returndatasize(),192))
        }
        if(!ok) return defaults();
        a[0]=TREASURY_PIPS;
        uint256 sum=TREASURY_PIPS;
        for(uint256 i=1;i<6;i++) {
            if(a[i]>MAX_PLAN_PIPS) return defaults();
            sum+=a[i];
        }
        if(sum+COMPUTE_PIPS>MAX_PLAN_PIPS) return defaults();
        // Compute replaces one tenth of a percentage point of the old owner
        // share. An inner program's own allocation remains available to it.
        a[5]+=COMPUTE_PIPS;
    }
    function computeAmount(ProgramTypes.Trade calldata trade) public pure returns(uint256 amount) {
        if((trade.buy&&trade.amount0>0)||(!trade.buy&&trade.amount0<0)) revert InvalidReceipt();
        // The core records pool deltas before hook fees: buy gross is the ETH
        // spent by the pool plus the fee, sell gross is the pool's ETH output.
        uint256 gross=trade.buy?uint256(-int256(trade.amount0))+trade.feeEth:uint256(int256(trade.amount0));
        amount=gross*COMPUTE_PIPS/1_000_000;
        if(amount>trade.moduleFeeEth) revert InvalidReceipt();
    }
    /// @notice Settle compute even when the inner program cannot execute.
    /// Anyone may submit an original pending receipt, once, to a fixed collector.
    function settleCompute(ProgramTypes.Trade calldata trade) public {
        if(trade.module!=address(this)) revert InvalidReceipt();
        if(msg.sender!=HOST&&IReceiptHost(HOST).pending(trade.id)!=keccak256(abi.encode(trade))) revert InvalidReceipt();
        if(computeSettled[trade.id]) return;
        uint256 amount=computeAmount(trade);
        computeSettled[trade.id]=true;
        if(amount!=0&&!IProgramManager(MANAGER).transfer(COMPUTE,0,amount)) revert InvalidReceipt();
        emit ComputeSettled(trade.id,amount);
    }
    function onTrade(ProgramTypes.Trade calldata trade,bytes calldata data) external returns(bytes4) {
        if(msg.sender!=HOST||trade.module!=address(this)||program.codehash!=programCodeHash) revert InvalidReceipt();
        settleCompute(trade);
        uint256 programFee=trade.moduleFeeEth-computeAmount(trade);
        if(programFee!=0&&!IProgramManager(MANAGER).transfer(program,0,programFee)) revert InvalidReceipt();
        ProgramTypes.Trade memory inner=trade;
        inner.moduleFeeEth=programFee;
        if(IProgram(program).onTrade(inner,data)!=IProgram.onTrade.selector) revert InvalidReceipt();
        return IProgram.onTrade.selector;
    }
}
