// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

interface IClausManagedRegistry {
    function moduleCode(bytes32 id) external view returns(address,bytes32);
    function moduleState(bytes32 id) external view returns(address,bytes32,uint64,bytes memory);
}

/// @notice Candidate general-code proxy. The upgrade registry is outside module storage.
/// The fixed selectors below cannot be replaced by a project's implementation.
contract ClausManagedProject {
    error ExecutorOnly();
    error InvalidModule();
    address public immutable executor;
    bytes32 public immutable projectId;

    constructor(bytes32 id) { executor=msg.sender; projectId=id; }
    function implementation() external view returns(address value) { (value,,,)=IClausManagedRegistry(executor).moduleState(projectId); }
    function implementationCodeHash() external view returns(bytes32 value) { (,value,,)=IClausManagedRegistry(executor).moduleState(projectId); }
    function version() external view returns(uint64 value) { (,,value,)=IClausManagedRegistry(executor).moduleState(projectId); }
    function configuration() external view returns(bytes memory value) { (,,,value)=IClausManagedRegistry(executor).moduleState(projectId); }

    function initialize(bytes calldata data) external {
        if(msg.sender!=executor)revert ExecutorOnly();
        if(data.length==0)return;
        address module=_implementation();
        (bool success,bytes memory result)=module.delegatecall(data);
        if(!success)assembly("memory-safe"){revert(add(result,32),mload(result))}
    }
    function _implementation() private view returns(address module) {
        bytes32 expected;
        (module,expected)=IClausManagedRegistry(executor).moduleCode(projectId);
        if(module.code.length==0||module==address(this)||module==executor||module.codehash!=expected)revert InvalidModule();
    }
    fallback() external payable { _delegate(); }
    receive() external payable { _delegate(); }
    function _delegate() private {
        address module=_implementation();
        assembly {
            calldatacopy(0,0,calldatasize())
            let success:=delegatecall(gas(),module,0,calldatasize(),0,0)
            returndatacopy(0,0,returndatasize())
            switch success case 0 { revert(0,returndatasize()) } default { return(0,returndatasize()) }
        }
    }
}
