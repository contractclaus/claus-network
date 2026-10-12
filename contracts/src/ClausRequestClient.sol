// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {ClausRequestInbox} from "./ClausRequestInbox.sol";

/// @notice Operator-owned reference client. Records decision receipts only;
/// a receipt never executes an upgrade or authorizes a payment.
contract ClausRequestClient {
    error Unauthorized();
    error InvalidReceipt();

    struct Receipt {
        bool requested;
        bool received;
        uint8 state;
        bytes32 resultHash;
        bytes32 evidenceHash;
    }

    ClausRequestInbox public immutable inbox;
    address public immutable controller;
    mapping(bytes32 => Receipt) public receipts;
    event ResultReceived(bytes32 indexed id, uint8 state, bytes32 resultHash, bytes32 evidenceHash);

    constructor(ClausRequestInbox inbox_, address controller_) {
        if (address(inbox_).code.length == 0 || controller_ == address(0)) revert Unauthorized();
        inbox = inbox_;
        controller = controller_;
    }

    function submit(bytes32 binding, bytes32 capability, uint64 deadline, bytes calldata input)
        external returns (bytes32 id)
    {
        if (msg.sender != controller) revert Unauthorized();
        id = inbox.request(binding, capability, deadline, 200_000, input);
        receipts[id].requested = true;
    }

    function cancel(bytes32 id) external {
        if (msg.sender != controller) revert Unauthorized();
        inbox.cancel(id);
    }

    function onClausResult(bytes32 id, uint8 state, bytes calldata result, bytes32 evidenceHash) external {
        if (msg.sender != address(inbox)) revert Unauthorized();
        Receipt storage receipt = receipts[id];
        if (!receipt.requested || receipt.received ||
            (state != uint8(ClausRequestInbox.State.Completed) && state != uint8(ClausRequestInbox.State.Failed)))
            revert InvalidReceipt();
        receipt.received = true;
        receipt.state = state;
        receipt.resultHash = keccak256(result);
        receipt.evidenceHash = evidenceHash;
        emit ResultReceived(id, state, receipt.resultHash, evidenceHash);
    }
}
