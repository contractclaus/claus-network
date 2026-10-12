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
    uint32 public constant CALLBACK_GAS = 1_000_000;
    mapping(bytes32 => Receipt) public receipts;
    event ResultReceived(bytes32 indexed id, uint8 state, bytes32 resultHash, bytes32 evidenceHash);
    event ResultRecovered(bytes32 indexed id, address indexed originalRequester);

    constructor(ClausRequestInbox inbox_, address controller_) {
        if (address(inbox_).code.length == 0 || controller_ == address(0)) revert Unauthorized();
        inbox = inbox_;
        controller = controller_;
    }

    function submit(bytes32 binding, bytes32 capability, uint64 deadline, bytes calldata input)
        external returns (bytes32 id)
    {
        if (msg.sender != controller) revert Unauthorized();
        id = inbox.request(binding, capability, deadline, CALLBACK_GAS, input);
        receipts[id].requested = true;
    }

    function cancel(bytes32 id) external {
        if (msg.sender != controller) revert Unauthorized();
        inbox.cancel(id);
    }

    function onClausResult(bytes32 id, uint8 state, bytes calldata result, bytes32 evidenceHash) external {
        if (msg.sender != address(inbox)) revert Unauthorized();
        _record(id, state, result, evidenceHash);
    }

    /// Pull the exact stored result when automatic callback delivery failed.
    function syncResult(bytes32 id, bytes calldata result) external {
        (address requester,,, ClausRequestInbox.State state,, bytes32 resultHash, bytes32 evidenceHash) = inbox.requests(id);
        if (requester != address(this) || keccak256(result) != resultHash) revert InvalidReceipt();
        _record(id, uint8(state), result, evidenceHash);
    }

    /// The same controller can recover its earlier client's result without
    /// resubmitting the request, buying another review or changing its origin.
    function recoverResult(bytes32 id, bytes calldata result) external {
        if (msg.sender != controller) revert Unauthorized();
        (address requester,,, ClausRequestInbox.State state,, bytes32 resultHash, bytes32 evidenceHash) = inbox.requests(id);
        if (requester == address(this) || requester.code.length == 0 || keccak256(result) != resultHash)
            revert InvalidReceipt();
        ClausRequestClient previous = ClausRequestClient(requester);
        if (previous.controller() != controller || address(previous.inbox()) != address(inbox)) revert Unauthorized();
        (bool requested,,,,) = previous.receipts(id);
        if (!requested) revert InvalidReceipt();
        receipts[id].requested = true;
        if (_record(id, uint8(state), result, evidenceHash)) emit ResultRecovered(id, requester);
    }

    function _record(bytes32 id, uint8 state, bytes calldata result, bytes32 evidenceHash) private returns (bool fresh) {
        Receipt storage receipt = receipts[id];
        if (!receipt.requested ||
            (state != uint8(ClausRequestInbox.State.Completed) && state != uint8(ClausRequestInbox.State.Failed)))
            revert InvalidReceipt();
        bytes32 resultHash = keccak256(result);
        if (receipt.received) {
            if (receipt.state != state || receipt.resultHash != resultHash || receipt.evidenceHash != evidenceHash)
                revert InvalidReceipt();
            return false;
        }
        receipt.received = true;
        receipt.state = state;
        receipt.resultHash = resultHash;
        receipt.evidenceHash = evidenceHash;
        emit ResultReceived(id, state, receipt.resultHash, evidenceHash);
        return true;
    }
}
