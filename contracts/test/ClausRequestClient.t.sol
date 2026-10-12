// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {Test} from "forge-std/Test.sol";
import {ClausRequestInbox} from "../src/ClausRequestInbox.sol";
import {ClausRequestClient} from "../src/ClausRequestClient.sol";

contract ClausRequestClientTest is Test {
    ClausRequestInbox inbox;
    ClausRequestClient client;
    address controller = address(0xA11CE);
    address dispatcher = address(0xD15);

    function setUp() public {
        inbox = new ClausRequestInbox(dispatcher);
        client = new ClausRequestClient(inbox, controller);
    }

    function submit() internal returns (bytes32 id) {
        vm.prank(controller);
        return client.submit(bytes32(uint256(1)), bytes32(uint256(2)), uint64(block.timestamp + 1 days), hex"1234");
    }

    function testOnlyControllerCanUseTheSponsoredBindingOrCancel() public {
        vm.expectRevert(ClausRequestClient.Unauthorized.selector);
        client.submit(bytes32(uint256(1)), bytes32(uint256(2)), uint64(block.timestamp + 1 days), hex"1234");
        bytes32 id = submit();
        vm.expectRevert(ClausRequestClient.Unauthorized.selector); client.cancel(id);
        vm.prank(controller); client.cancel(id);
        (,,,ClausRequestInbox.State state,,,) = inbox.requests(id);
        assertEq(uint8(state), uint8(ClausRequestInbox.State.Cancelled));
    }

    function testOnlyTheInboxCanDeliverOneExactDecisionReceipt() public {
        bytes32 id = submit();
        bytes memory result = bytes('{"kind":"proposal-decision","decision":"reject"}');
        bytes32 evidence = keccak256("local-fixture");
        vm.expectRevert(ClausRequestClient.Unauthorized.selector);
        client.onClausResult(id, 3, result, evidence);
        vm.prank(dispatcher); inbox.resolve(id, false, evidence, result);
        assertTrue(inbox.deliverCallback(id, result));
        (bool requested, bool received, uint8 state, bytes32 resultHash, bytes32 evidenceHash) = client.receipts(id);
        assertTrue(requested && received); assertEq(state, 3);
        assertEq(resultHash, keccak256(result)); assertEq(evidenceHash, evidence);
        vm.expectRevert(ClausRequestInbox.InvalidResult.selector); inbox.deliverCallback(id, result);
    }
}
