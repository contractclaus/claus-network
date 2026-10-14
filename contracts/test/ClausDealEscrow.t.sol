// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;
import {Test} from "forge-std/Test.sol";
import {ClausDealEscrow} from "../src/ClausDealEscrow.sol";

contract RefusingDealRecipient { receive() external payable { revert(); } }
contract NestedDealRecipient {
    ClausDealEscrow public target;
    bool public nestedFailed;
    constructor(ClausDealEscrow e) { target = e; }
    function take(uint256 amount) external { target.withdraw(amount, payable(address(this))); }
    receive() external payable { (bool ok,) = address(target).call(abi.encodeCall(target.withdraw,(1,payable(address(this))))); nestedFailed = !ok; }
}
contract ClausDealEscrowTest is Test {
    ClausDealEscrow escrow;
    address buyer = address(0xA11CE);
    address worker = address(0xB0B);
    uint256 signerKey = 0x12345;
    bytes32 project = keccak256("owned-project");
    bytes32 terms = keccak256("fixed agreement with disclosed deadlines");
    function setUp() public {
        escrow = new ClausDealEscrow(address(this),vm.addr(signerKey),1 ether,5 ether);
        escrow.setFundingEnabled(true);
        vm.deal(buyer,20 ether);
    }
    function funded(uint256 salt) internal returns(bytes32 id) {
        vm.prank(buyer);return escrow.createDeal{value:1 ether}(bytes32(salt),project,terms,worker,uint64(block.timestamp+2 days));
    }
    function delivered(bytes32 id) internal {
        vm.startPrank(worker);escrow.claim(id);escrow.deliver(id,keccak256("delivered output"));vm.stopPrank();
    }
    function signed(bytes32 id,uint256 value,bytes32 evidence,uint64 expiry,ClausDealEscrow target) internal view returns(bytes memory) {
        bytes32 domain=keccak256(abi.encode(keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),keccak256("ClausDealEscrow"),keccak256("1"),block.chainid,address(target)));
        bytes32 hash=keccak256(abi.encodePacked(hex"1901",domain,keccak256(abi.encode(target.RESOLUTION_TYPEHASH(),id,value,evidence,expiry))));
        (uint8 v,bytes32 r,bytes32 s)=vm.sign(signerKey,hash);return abi.encodePacked(r,s,v);
    }
    function testAcceptanceWithdrawalsAndAdmissionNeverRewriteExistingAgreements() public {
        bytes32 id=funded(1);delivered(id);
        escrow.setFundingEnabled(false);
        vm.prank(buyer);vm.expectRevert(ClausDealEscrow.FundingPaused.selector);escrow.createDeal{value:1 ether}(bytes32(uint256(2)),project,terms,worker,uint64(block.timestamp+1 days));
        vm.prank(worker);vm.expectRevert(ClausDealEscrow.Unauthorized.selector);escrow.accept(id);
        vm.prank(buyer);escrow.accept(id);
        assertEq(escrow.credits(worker),1 ether);assertEq(escrow.totalLocked(),0);assertEq(escrow.totalCredits(),1 ether);
        RefusingDealRecipient refusing=new RefusingDealRecipient();
        vm.prank(worker);vm.expectRevert(ClausDealEscrow.TransferFailed.selector);escrow.withdraw(1 ether,payable(address(refusing)));
        assertEq(escrow.credits(worker),1 ether);
        vm.prank(worker);escrow.withdraw(1 ether,payable(worker));assertEq(worker.balance,1 ether);assertEq(escrow.totalCredits(),0);
        vm.expectRevert(ClausDealEscrow.WrongState.selector);escrow.settleExpired(id);
        vm.prank(buyer);vm.expectRevert(ClausDealEscrow.WrongState.selector);escrow.accept(id);
    }
    function testDisputesBindExactDomainAndAmountsAndAlwaysHaveTimeoutExit() public {
        bytes32 id=funded(1);delivered(id);vm.prank(buyer);escrow.dispute(id,keccak256("dispute evidence"));
        uint64 expiry=uint64(block.timestamp+1 days);bytes32 evidence=keccak256("decision evidence");
        bytes memory sig=signed(id,0.4 ether,evidence,expiry,escrow);
        ClausDealEscrow other=new ClausDealEscrow(address(this),vm.addr(signerKey),1 ether,5 ether);
        bytes memory wrongDomain=signed(id,0.4 ether,evidence,expiry,other);
        vm.expectRevert(ClausDealEscrow.Unauthorized.selector);escrow.resolve(id,0.4 ether,evidence,expiry,wrongDomain);
        vm.expectRevert(ClausDealEscrow.Unauthorized.selector);escrow.resolve(id,0.5 ether,evidence,expiry,sig);
        escrow.resolve(id,0.4 ether,evidence,expiry,sig);assertEq(escrow.credits(worker),0.4 ether);assertEq(escrow.credits(buyer),0.6 ether);
        vm.expectRevert(ClausDealEscrow.WrongState.selector);escrow.resolve(id,0.4 ether,evidence,expiry,sig);
        bytes32 second=funded(2);delivered(second);vm.prank(buyer);escrow.dispute(second,keccak256("second dispute"));
        vm.expectRevert(ClausDealEscrow.Unauthorized.selector);escrow.resolve(second,0.4 ether,evidence,expiry,sig);
        vm.warp(block.timestamp+3 days+1);escrow.settleExpired(second);assertEq(escrow.credits(buyer),1.6 ether);
        bytes32 third=funded(3);delivered(third);vm.warp(block.timestamp+1 days+1);escrow.settleExpired(third);assertEq(escrow.credits(worker),1.4 ether);
        bytes32 fourth=funded(4);vm.warp(block.timestamp+2 days+1);escrow.settleExpired(fourth);assertEq(escrow.credits(buyer),2.6 ether);
        assertEq(escrow.totalLocked()+escrow.totalCredits(),address(escrow).balance);
    }
    function testRecurringCancellationFiniteRunsAndStableIdentities() public {
        vm.prank(buyer);bytes32 plan=escrow.createPlan{value:3 ether}(bytes32(uint256(1)),project,terms,worker,1 ether,3,60,1 days,uint64(block.timestamp+7 days));
        bytes32 first=escrow.runPlan(plan,0);
        vm.expectRevert(ClausDealEscrow.WrongState.selector);escrow.runPlan(plan,0);
        delivered(first);vm.prank(buyer);escrow.accept(first);vm.warp(block.timestamp+61);
        vm.expectRevert(ClausDealEscrow.WrongState.selector);escrow.runPlan(plan,0);
        bytes32 second=escrow.runPlan(plan,1);assertTrue(second!=first);delivered(second);
        vm.prank(buyer);escrow.cancelPlan(plan);assertEq(escrow.credits(buyer),1 ether);assertEq(escrow.getPlan(plan).remaining,0);
        vm.prank(buyer);escrow.accept(second);assertEq(escrow.credits(worker),2 ether);
        vm.expectRevert(ClausDealEscrow.WrongState.selector);escrow.runPlan(plan,2);
        vm.prank(buyer);vm.expectRevert(ClausDealEscrow.WrongState.selector);escrow.createPlan{value:1 ether}(bytes32(uint256(1)),project,terms,worker,1 ether,1,60,1 days,uint64(block.timestamp+7 days));
        vm.prank(buyer);bytes32 other=escrow.createPlan{value:1 ether}(bytes32(uint256(2)),project,terms,worker,1 ether,1,60,1 days,uint64(block.timestamp+7 days));
        bytes32 last=escrow.runPlan(other,0);delivered(last);vm.prank(buyer);escrow.accept(last);vm.warp(block.timestamp+61);
        vm.expectRevert(ClausDealEscrow.WrongState.selector);escrow.runPlan(other,1);assertEq(escrow.totalLocked(),0);assertEq(escrow.totalCredits(),4 ether);
    }
    function testRefundsBudgetsAndReentrancyCannotInventOrTrapPrincipal() public {
        NestedDealRecipient receiver=new NestedDealRecipient(escrow);
        vm.prank(buyer);bytes32 id=escrow.createDeal{value:1 ether}(bytes32(uint256(1)),project,terms,address(receiver),uint64(block.timestamp+1 days));
        vm.startPrank(address(receiver));escrow.claim(id);escrow.deliver(id,keccak256("result"));vm.stopPrank();vm.prank(buyer);escrow.accept(id);
        receiver.take(1 ether);assertTrue(receiver.nestedFailed());assertEq(address(receiver).balance,1 ether);
        bytes32 refunded=funded(2);delivered(refunded);vm.prank(buyer);escrow.dispute(refunded,keccak256("issue"));vm.prank(worker);escrow.refund(refunded);assertEq(escrow.credits(buyer),1 ether);
        vm.prank(buyer);bytes32 plan=escrow.createPlan{value:4 ether}(bytes32(uint256(3)),project,terms,worker,1 ether,4,60,1 days,uint64(block.timestamp+1 days));
        vm.prank(buyer);vm.expectRevert(ClausDealEscrow.CapacityReached.selector);escrow.createDeal{value:1 ether}(bytes32(uint256(4)),project,terms,worker,uint64(block.timestamp+1 days));
        vm.warp(block.timestamp+1 days);escrow.expirePlan(plan);assertEq(escrow.credits(buyer),5 ether);
        vm.prank(buyer);escrow.withdraw(5 ether,payable(buyer));assertEq(escrow.totalLocked()+escrow.totalCredits(),0);assertEq(address(escrow).balance,0);
    }
}
