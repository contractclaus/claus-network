// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;
import {Test} from "forge-std/Test.sol";
import {ClausManagedExecutor} from "./ClausManagedExecutor.sol";
import {ClausManagedProject} from "./ClausManagedProject.sol";
contract ManagedCounter {
    uint256 public count;
    function set(uint256 value) external {count=value;}
    function add() external {++count;}
    function overwrite(address fake) external {assembly{sstore(0,fake) sstore(1,fake) sstore(2,fake) sstore(3,fake)}}
}
contract CounterV2 is ManagedCounter { function addTen() external {count+=10;} }
contract RevertingModule { fallback() external {revert("initializer failed");} }
contract ClausManagedExecutorTest is Test {
    ClausManagedExecutor executor;ClausManagedProject target;ManagedCounter first;CounterV2 second;
    uint256 constant CLAUS=0xA11CE;uint256 constant OWNER=0xB0B;bytes32 id;
    function sign(uint256 key,bytes32 hash) internal pure returns(bytes memory){(uint8 v,bytes32 r,bytes32 s)=vm.sign(key,hash);return abi.encodePacked(r,s,v);}
    function registration(bytes32 salt) internal view returns(ClausManagedExecutor.Registration memory r){
        r.projectId=executor.projectKey(vm.addr(OWNER),salt);r.owner=vm.addr(OWNER);r.salt=salt;r.implementation=address(first);
        r.codeHash=address(first).codehash;r.initCallHash=keccak256(abi.encodeCall(first.set,(7)));r.mandateHash=keccak256("mandate");
        r.policyVersion=keccak256("policy");r.nonce=uint256(salt);r.expiresAt=uint64(block.timestamp+1 days);
        r.evidenceHash=keccak256("independent source-bound review");r.dependencySnapshotHash=keccak256("dependencies");r.clausGeneration=1;
    }
    function setUp() public {
        vm.warp(1800000000);executor=new ClausManagedExecutor(vm.addr(CLAUS),address(this),1 days);first=new ManagedCounter();second=new CounterV2();
        ClausManagedExecutor.Registration memory r=registration(keccak256("first"));id=r.projectId;
        target=ClausManagedProject(payable(executor.registerProject(r,abi.encodeCall(first.set,(7)),sign(OWNER,executor.registrationDigest(r)),sign(CLAUS,executor.registrationDigest(r)))));
    }
    function approval(address module,bytes memory data) internal view returns(ClausManagedExecutor.Approval memory a){
        a=ClausManagedExecutor.Approval(id,block.chainid,address(executor),address(target),1,address(first).codehash,module,module.codehash,keccak256(data),keccak256("dependencies"),keccak256("review"),keccak256("policy"),1,1,1,keccak256("mandate"),1,uint64(block.timestamp),uint64(block.timestamp+1 days));
    }
    function testStatePersistsAcrossExactApprovedUpgrade() public {
        assertEq(ManagedCounter(address(target)).count(),7);ManagedCounter(address(target)).add();
        bytes memory data="";ClausManagedExecutor.Approval memory a=approval(address(second),data);bytes memory s=sign(CLAUS,executor.approvalDigest(a));executor.queue(a,s);executor.execute(a,data,s);
        CounterV2(address(target)).addTen();assertEq(ManagedCounter(address(target)).count(),18);assertEq(target.version(),2);assertEq(target.implementation(),address(second));
        vm.expectRevert();executor.execute(a,data,s);
    }
    function testModuleStorageCannotChangeUpgradeRegistry() public {
        ManagedCounter(address(target)).overwrite(address(second));assertEq(target.executor(),address(executor));assertEq(target.projectId(),id);assertEq(target.implementation(),address(first));assertEq(target.version(),1);
        vm.expectRevert(ClausManagedProject.ExecutorOnly.selector);target.initialize(abi.encodeCall(first.set,(1)));
        ClausManagedExecutor.Approval memory a=approval(address(second),"");bytes memory wrong=sign(OWNER,executor.approvalDigest(a));vm.expectRevert(ClausManagedExecutor.InvalidSignature.selector);executor.queue(a,wrong);
    }
    function testInitialCodeAlsoNeedsClausReviewSignature() public {
        ClausManagedExecutor.Registration memory r=registration(keccak256("second"));bytes memory s=sign(OWNER,executor.registrationDigest(r));
        vm.expectRevert(ClausManagedExecutor.InvalidSignature.selector);executor.registerProject(r,abi.encodeCall(first.set,(7)),s,s);
        bytes memory c=sign(CLAUS,executor.registrationDigest(r));r.evidenceHash=keccak256("different review");
        vm.expectRevert();executor.registerProject(r,abi.encodeCall(first.set,(7)),s,c);
    }
    function testRevocationStopsQueuedChangesAndReenableDoesNotReviveSignature() public {
        ClausManagedExecutor.Approval memory a=approval(address(second),"");bytes memory s=sign(CLAUS,executor.approvalDigest(a));executor.queue(a,s);
        vm.prank(vm.addr(OWNER));executor.setAuthority(id,keccak256("mandate"),false);
        vm.expectRevert();executor.execute(a,"",s);
        vm.prank(vm.addr(OWNER));executor.setAuthority(id,keccak256("mandate"),true);vm.expectRevert();executor.execute(a,"",s);
    }
    function testRevertingInitializationRollsBackRegistryAndNonce() public {
        RevertingModule bad=new RevertingModule();bytes memory data=hex"01";ClausManagedExecutor.Approval memory a=approval(address(bad),data);bytes memory s=sign(CLAUS,executor.approvalDigest(a));executor.queue(a,s);
        vm.expectRevert();executor.execute(a,data,s);assertEq(target.implementation(),address(first));assertEq(target.version(),1);assertFalse(executor.executionNonces(id,1));assertEq(ManagedCounter(address(target)).count(),7);
    }
}
