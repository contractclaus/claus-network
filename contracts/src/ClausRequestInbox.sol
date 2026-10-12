// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

/// @notice Sponsored asynchronous requests. An inbox receipt is an operator's
/// result attestation, never an upgrade approval or an authorization to spend.
/// No deposits, fees, proxy, arbitrary execution or signer replacement.
contract ClausRequestInbox {
    error InvalidRequest();
    error DispatcherOnly();
    error RequesterOnly();
    error RequestClosed();
    error InvalidResult();
    error CallbackGasUnavailable();

    enum State { Missing, Pending, Completed, Failed, Cancelled, Expired }
    struct Request {
        address requester;
        uint64 deadline;
        uint32 callbackGas;
        State state;
        bool callbackDelivered;
        bytes32 resultHash;
        bytes32 evidenceHash;
    }

    uint256 public constant MAX_BYTES = 8192;
    uint256 public constant MAX_LIFETIME = 30 days;
    uint32 public constant MAX_CALLBACK_GAS = 1_000_000;
    bytes4 public constant CALLBACK_SELECTOR =
        bytes4(keccak256("onClausResult(bytes32,uint8,bytes,bytes32)"));
    address public immutable dispatcher;
    mapping(address => uint256) public nextNonce;
    mapping(bytes32 => Request) public requests;

    event Requested(bytes32 indexed id, address indexed requester, bytes32 indexed binding,
        bytes32 capability, uint64 deadline, uint32 callbackGas, bytes input);
    event Resolved(bytes32 indexed id, State state, bytes32 evidenceHash, bytes result);
    event Closed(bytes32 indexed id, State state);
    event CallbackAttempted(bytes32 indexed id, bool delivered);

    constructor(address dispatcher_) {
        if (dispatcher_ == address(0)) revert InvalidRequest();
        dispatcher = dispatcher_;
    }

    function request(bytes32 binding, bytes32 capability, uint64 deadline, uint32 callbackGas,
        bytes calldata input) external returns (bytes32 id)
    {
        if (binding == bytes32(0) || capability == bytes32(0) || input.length == 0 || input.length > MAX_BYTES
            || deadline <= block.timestamp || deadline > block.timestamp + MAX_LIFETIME
            || callbackGas > MAX_CALLBACK_GAS
            || (callbackGas != 0 && (callbackGas < 25_000 || msg.sender.code.length == 0))) revert InvalidRequest();
        id = keccak256(abi.encode(block.chainid, address(this), msg.sender, nextNonce[msg.sender]++));
        requests[id] = Request(msg.sender, deadline, callbackGas, State.Pending, false, bytes32(0), bytes32(0));
        emit Requested(id, msg.sender, binding, capability, deadline, callbackGas, input);
    }

    function resolve(bytes32 id, bool success, bytes32 evidenceHash, bytes calldata result) external {
        if (msg.sender != dispatcher) revert DispatcherOnly();
        Request storage r = requests[id];
        if (r.state != State.Pending || block.timestamp >= r.deadline) revert RequestClosed();
        if (evidenceHash == bytes32(0) || result.length > MAX_BYTES) revert InvalidResult();
        r.state = success ? State.Completed : State.Failed;
        r.resultHash = keccak256(result);
        r.evidenceHash = evidenceHash;
        emit Resolved(id, r.state, evidenceHash, result);
    }

    function cancel(bytes32 id) external {
        Request storage r = requests[id];
        if (msg.sender != r.requester) revert RequesterOnly();
        if (r.state != State.Pending) revert RequestClosed();
        r.state = State.Cancelled;
        emit Closed(id, r.state);
    }

    function expire(bytes32 id) external {
        Request storage r = requests[id];
        if (r.state != State.Pending || block.timestamp < r.deadline) revert RequestClosed();
        r.state = State.Expired;
        emit Closed(id, r.state);
    }

    /// Anyone can deliver the exact saved result. A reverting callback cannot
    /// erase it; retry never buys or executes the underlying job a second time.
    function deliverCallback(bytes32 id, bytes calldata result) external returns (bool delivered) {
        Request storage r = requests[id];
        if ((r.state != State.Completed && r.state != State.Failed) || r.callbackDelivered
            || r.callbackGas == 0 || r.requester.code.length == 0
            || result.length > MAX_BYTES || keccak256(result) != r.resultHash) revert InvalidResult();
        bytes memory data = abi.encodeWithSelector(CALLBACK_SELECTOR, id, uint8(r.state), result, r.evidenceHash);
        address target = r.requester;
        uint256 limit = r.callbackGas;
        // Leave room for storage/event work and EIP-150's retained 1/64.
        if (gasleft() < limit * 64 / 63 + 50_000) revert CallbackGasUnavailable();
        r.callbackDelivered = true;
        assembly ("memory-safe") {
            // Ignore return data, including maliciously oversized return data.
            delivered := call(limit, target, 0, add(data, 32), mload(data), 0, 0)
        }
        if (!delivered) r.callbackDelivered = false;
        emit CallbackAttempted(id, delivered);
    }
}
