// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {Test} from "forge-std/Test.sol";
import {ClausRequestInbox} from "../src/ClausRequestInbox.sol";

contract InboxReceiver {
    ClausRequestInbox public immutable inbox;
    bool public reject;
    bool public reenter;
    uint256 public deliveries;
    bytes public output;
    constructor(ClausRequestInbox i) { inbox = i; }
    function submit(uint32 gasLimit) external returns (bytes32) {
        return inbox.request(keccak256("binding"), keccak256("capability"), uint64(block.timestamp + 1 days), gasLimit, hex"1234");
    }
    function submitInput(bytes32 binding, bytes32 capability, bytes calldata input) external returns (bytes32) {
        return inbox.request(binding, capability, uint64(block.timestamp + 1 days), 500_000, input);
    }
    function setBehavior(bool shouldReject, bool shouldReenter) external { reject = shouldReject; reenter = shouldReenter; }
    function onClausResult(bytes32 id, uint8, bytes calldata result, bytes32) external {
        require(msg.sender == address(inbox), "inbox only");
        require(!reject, "retry later");
        deliveries++;
        output = result;
        if (reenter) {
            (bool ok,) = address(inbox).call(abi.encodeCall(inbox.deliverCallback, (id, result)));
            require(!ok, "duplicate callback");
        }
    }
}

contract ClausRequestInboxTest is Test {
    ClausRequestInbox inbox;
    InboxReceiver receiver;
    address dispatcher = address(0xD15);
    address alice = address(0xA11CE);

    function setUp() public {
        inbox = new ClausRequestInbox(dispatcher);
        receiver = new InboxReceiver(inbox);
    }
    function resolve(bytes32 id, bool ok, bytes memory result) internal {
        vm.prank(dispatcher); inbox.resolve(id, ok, keccak256("evidence"), result);
    }
    function state(bytes32 id) internal view returns (ClausRequestInbox.State s) {
        (,,,s,,,) = inbox.requests(id);
    }

    function testCallbackIsExactAndAtMostOnceAfterSuccess() public {
        bytes32 id = receiver.submit(200_000);
        resolve(id, true, hex"aabb");
        vm.expectRevert(ClausRequestInbox.InvalidResult.selector); inbox.deliverCallback(id, hex"aa");
        receiver.setBehavior(false, true);
        assertTrue(inbox.deliverCallback(id, hex"aabb"));
        assertEq(receiver.deliveries(), 1);
        assertEq(receiver.output(), hex"aabb");
        vm.expectRevert(ClausRequestInbox.InvalidResult.selector); inbox.deliverCallback(id, hex"aabb");
    }

    function testCallbackFailureKeepsOriginalResultAndCanRetry() public {
        bytes32 id = receiver.submit(200_000);
        resolve(id, false, hex"ff");
        receiver.setBehavior(true, false);
        assertFalse(inbox.deliverCallback(id, hex"ff"));
        assertEq(uint8(state(id)), uint8(ClausRequestInbox.State.Failed));
        receiver.setBehavior(false, false);
        assertTrue(inbox.deliverCallback(id, hex"ff"));
        assertEq(receiver.deliveries(), 1);
        vm.prank(dispatcher); vm.expectRevert(ClausRequestInbox.RequestClosed.selector);
        inbox.resolve(id, true, keccak256("replacement"), hex"12");
    }

    function testDispatcherCannotResolveCancelledExpiredOrUnknownRequests() public {
        vm.prank(alice);
        bytes32 cancelled = inbox.request(bytes32(uint256(1)), bytes32(uint256(2)), uint64(block.timestamp + 60), 0, hex"01");
        vm.prank(alice); inbox.cancel(cancelled);
        vm.prank(dispatcher); vm.expectRevert(ClausRequestInbox.RequestClosed.selector);
        inbox.resolve(cancelled, true, bytes32(uint256(1)), hex"01");
        bytes32 expired = receiver.submit(100_000);
        vm.warp(block.timestamp + 1 days);
        vm.prank(dispatcher); vm.expectRevert(ClausRequestInbox.RequestClosed.selector);
        inbox.resolve(expired, true, bytes32(uint256(1)), hex"01");
        inbox.expire(expired);
        assertEq(uint8(state(expired)), uint8(ClausRequestInbox.State.Expired));
        vm.prank(dispatcher); vm.expectRevert(ClausRequestInbox.RequestClosed.selector);
        inbox.resolve(bytes32(0), true, bytes32(uint256(1)), hex"01");
    }

    function testRequestIdentityBindsChainInboxRequesterAndNonce() public {
        vm.startPrank(alice);
        bytes32 first = inbox.request(bytes32(uint256(1)), bytes32(uint256(2)), uint64(block.timestamp + 60), 0, hex"01");
        bytes32 second = inbox.request(bytes32(uint256(1)), bytes32(uint256(2)), uint64(block.timestamp + 60), 0, hex"01");
        assertEq(first, keccak256(abi.encode(block.chainid, address(inbox), alice, uint256(0))));
        assertNotEq(first, second);
        vm.expectRevert(ClausRequestInbox.DispatcherOnly.selector); inbox.resolve(first, true, bytes32(uint256(1)), hex"01");
        vm.stopPrank();
        vm.expectRevert(ClausRequestInbox.RequesterOnly.selector); inbox.cancel(first);
    }

    function testInputDeadlineCallbackAndEvidenceBounds() public {
        vm.expectRevert(ClausRequestInbox.InvalidRequest.selector);
        inbox.request(bytes32(uint256(1)), bytes32(uint256(2)), uint64(block.timestamp), 0, hex"01");
        vm.prank(alice); vm.expectRevert(ClausRequestInbox.InvalidRequest.selector);
        inbox.request(bytes32(uint256(1)), bytes32(uint256(2)), uint64(block.timestamp + 60), 100_000, hex"01");
        vm.expectRevert(ClausRequestInbox.InvalidRequest.selector);
        inbox.request(bytes32(uint256(1)), bytes32(uint256(2)), uint64(block.timestamp + 60), 0, new bytes(8193));
        bytes32 id = receiver.submit(100_000);
        vm.prank(dispatcher); vm.expectRevert(ClausRequestInbox.InvalidResult.selector);
        inbox.resolve(id, true, bytes32(0), hex"01");
        vm.prank(dispatcher); vm.expectRevert(ClausRequestInbox.InvalidResult.selector);
        inbox.resolve(id, true, bytes32(uint256(1)), new bytes(8193));
    }

    function testLowGasDoesNotConsumeCallback() public {
        bytes32 id = receiver.submit(200_000);
        resolve(id, true, hex"01");
        vm.expectRevert(ClausRequestInbox.CallbackGasUnavailable.selector);
        inbox.deliverCallback{gas: 100_000}(id, hex"01");
        assertTrue(inbox.deliverCallback(id, hex"01"));
    }
}
