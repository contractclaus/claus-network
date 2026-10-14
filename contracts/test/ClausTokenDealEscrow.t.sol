// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;
import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ClausTokenDealEscrow} from "../src/ClausTokenDealEscrow.sol";

contract JobToken is ERC20 {
    bool public tax;
    bool public callback;
    bool public nestedBlocked;
    address public escrow;
    constructor() ERC20("Job token", "JOB") {}
    function mint(address to, uint256 n) external { _mint(to,n); }
    function configure(address e, bool t, bool c) external { escrow=e; tax=t; callback=c; }
    function _update(address from,address to,uint256 n) internal override {
        if (callback && from!=address(0)) {
            (bool ok,bytes memory result)=escrow.call(abi.encodeCall(ClausTokenDealEscrow.setFundingEnabled,(false)));
            nestedBlocked=!ok&&result.length==4&&bytes4(result)==ClausTokenDealEscrow.ReentrantCall.selector;
        }
        if (tax && from!=address(0) && to!=address(0) && n>1) {
            super._update(from,to,n-1); super._update(from,address(0),1);
        } else super._update(from,to,n);
    }
}
contract ClausTokenDealEscrowTest is Test {
    ClausTokenDealEscrow escrow;
    JobToken token;
    address buyer=address(0xA11CE);
    address worker=address(0xB0B);
    uint256 signerKey=0x12345;
    bytes32 project=keccak256("project");
    bytes32 terms=keccak256("terms");
    function setUp() public {
        token=new JobToken();
        escrow=new ClausTokenDealEscrow(address(token),address(this),vm.addr(signerKey),1 ether,5 ether);
        escrow.setFundingEnabled(true); token.mint(buyer,20 ether);
        vm.prank(buyer);token.approve(address(escrow),20 ether);
    }
    function funded(uint256 salt) internal returns(bytes32) {
        vm.prank(buyer);return escrow.createDeal(bytes32(salt),project,terms,worker,1 ether,uint64(block.timestamp+2 days));
    }
    function delivered(bytes32 id) internal {
        vm.startPrank(worker);escrow.claim(id);escrow.deliver(id,keccak256("output"));vm.stopPrank();
    }
    function sign(bytes32 id,uint256 n,bytes32 evidence,uint64 expires,address target) internal view returns(bytes memory) {
        bytes32 domain=keccak256(abi.encode(keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),keccak256("ClausDealEscrow"),keccak256("1"),block.chainid,target));
        bytes32 h=keccak256(abi.encodePacked(hex"1901",domain,keccak256(abi.encode(escrow.RESOLUTION_TYPEHASH(),id,n,evidence,expires))));
        (uint8 v,bytes32 r,bytes32 s)=vm.sign(signerKey,h);return abi.encodePacked(r,s,v);
    }
    function testExactFundingAndWithdrawalRemainAvailableWhilePaused() public {
        bytes32 id=funded(1);delivered(id);escrow.setFundingEnabled(false);
        vm.expectRevert(ClausTokenDealEscrow.FundingPaused.selector);funded(2);
        vm.prank(worker);vm.expectRevert(ClausTokenDealEscrow.Unauthorized.selector);escrow.accept(id);
        vm.prank(buyer);escrow.accept(id);
        assertEq(escrow.credits(worker),1 ether);assertEq(escrow.totalLocked(),0);
        vm.prank(worker);escrow.withdraw(1 ether,payable(worker));
        assertEq(token.balanceOf(worker),1 ether);assertEq(token.balanceOf(address(escrow)),0);assertEq(escrow.totalCredits(),0);
        vm.prank(worker);vm.expectRevert(ClausTokenDealEscrow.InvalidTerms.selector);escrow.withdraw(1,payable(worker));
    }
    function testDepositsAndPayoutsRejectTransferTaxWithoutLosingCredit() public {
        token.configure(address(escrow),true,false);
        vm.expectRevert(ClausTokenDealEscrow.TransferFailed.selector);funded(1);
        assertEq(token.balanceOf(buyer),20 ether);assertEq(escrow.totalLocked(),0);
        token.configure(address(escrow),false,false);bytes32 id=funded(1);delivered(id);vm.prank(buyer);escrow.accept(id);
        token.configure(address(escrow),true,false);
        vm.prank(worker);vm.expectRevert(ClausTokenDealEscrow.TransferFailed.selector);escrow.withdraw(1 ether,payable(worker));
        assertEq(escrow.credits(worker),1 ether);assertEq(token.balanceOf(address(escrow)),1 ether);
        token.configure(address(escrow),false,false);vm.prank(worker);escrow.withdraw(1 ether,payable(worker));assertEq(token.balanceOf(worker),1 ether);
    }
    function testTokenCallbacksCannotReenterFundingOrWithdrawal() public {
        token.configure(address(escrow),false,true);bytes32 id=funded(1);assertTrue(token.nestedBlocked());
        delivered(id);vm.prank(buyer);escrow.accept(id);vm.prank(worker);escrow.withdraw(1 ether,payable(worker));assertTrue(token.nestedBlocked());assertTrue(escrow.fundingEnabled());
    }
    function testIndependentSignatureAndTimeoutExitsBindTokenEscrow() public {
        bytes32 id=funded(1);delivered(id);vm.prank(buyer);escrow.dispute(id,keccak256("reason"));
        uint64 expiry=uint64(block.timestamp+1 days);bytes32 evidence=keccak256("review");
        bytes memory sig=sign(id,0.4 ether,evidence,expiry,address(escrow));
        bytes memory other=sign(id,0.4 ether,evidence,expiry,address(0x123));
        vm.expectRevert(ClausTokenDealEscrow.Unauthorized.selector);escrow.resolve(id,0.4 ether,evidence,expiry,other);
        vm.expectRevert(ClausTokenDealEscrow.Unauthorized.selector);escrow.resolve(id,0.5 ether,evidence,expiry,sig);
        escrow.resolve(id,0.4 ether,evidence,expiry,sig);assertEq(escrow.credits(worker),0.4 ether);assertEq(escrow.credits(buyer),0.6 ether);
        bytes32 second=funded(2);delivered(second);vm.prank(buyer);escrow.dispute(second,keccak256("reason"));vm.warp(block.timestamp+3 days+1);escrow.settleExpired(second);
        bytes32 third=funded(3);delivered(third);vm.warp(block.timestamp+1 days+1);escrow.settleExpired(third);
        assertEq(escrow.credits(buyer),1.6 ether);assertEq(escrow.credits(worker),1.4 ether);assertEq(token.balanceOf(address(escrow)),escrow.totalLocked()+escrow.totalCredits());
    }
    function testFinitePlansAndCreditsCountTowardCapacity() public {
        vm.prank(buyer);bytes32 p=escrow.createPlan(bytes32(uint256(1)),project,terms,worker,1 ether,3,60,1 days,uint64(block.timestamp+7 days));
        vm.prank(buyer);bytes32 id=escrow.runPlan(p,0);
        vm.prank(buyer);vm.expectRevert(ClausTokenDealEscrow.WrongState.selector);escrow.runPlan(p,0);
        delivered(id);vm.prank(buyer);escrow.accept(id);vm.prank(buyer);escrow.cancelPlan(p);
        assertEq(escrow.credits(buyer),2 ether);assertEq(escrow.credits(worker),1 ether);
        funded(2);funded(3);vm.expectRevert(ClausTokenDealEscrow.CapacityReached.selector);funded(4);
        vm.prank(buyer);escrow.withdraw(2 ether,payable(buyer));funded(4);
        assertEq(token.balanceOf(address(escrow)),escrow.totalLocked()+escrow.totalCredits());
    }
    function testMissingApprovalAndInvalidPartiesCannotMoveTokens() public {
        vm.prank(buyer);token.approve(address(escrow),0);vm.expectRevert();funded(1);assertEq(escrow.totalLocked(),0);
        vm.prank(buyer);token.approve(address(escrow),1 ether);
        vm.prank(buyer);vm.expectRevert(ClausTokenDealEscrow.InvalidTerms.selector);
        escrow.createDeal(bytes32(uint256(2)),project,terms,vm.addr(signerKey),1 ether,uint64(block.timestamp+1 days));
        assertEq(token.balanceOf(buyer),20 ether);assertEq(escrow.totalLocked(),0);
    }
}
