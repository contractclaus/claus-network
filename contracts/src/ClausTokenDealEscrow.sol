// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

/// @notice Fixed-term agreements in one immutable ERC-20 with 18 decimals. Project/terms/result hashes are
/// commitments, not certification. No proxy, administrator sweep or fees.
contract ClausTokenDealEscrow is EIP712 {
    using SafeERC20 for IERC20;
    IERC20 public immutable token;
    error InvalidTerms();
    error WrongState();
    error Unauthorized();
    error FundingPaused();
    error CapacityReached();
    error TransferFailed();
    error ReentrantCall();

    uint64 public constant REVIEW_WINDOW = 1 days;
    uint64 public constant DISPUTE_WINDOW = 3 days;
    uint64 public constant MAX_DURATION = 30 days;
    bytes32 public constant RESOLUTION_TYPEHASH = keccak256(
        "Resolution(bytes32 dealId,uint256 workerAmount,bytes32 evidenceHash,uint64 expiresAt)"
    );
    enum State { Missing, Funded, Working, Submitted, Disputed, Settled }
    struct Deal {
        address buyer;
        address worker;
        uint256 amount;
        bytes32 projectId;
        bytes32 termsHash;
        bytes32 resultHash;
        bytes32 disputeHash;
        bytes32 evidenceHash;
        uint64 deliveryDue;
        uint64 reviewDue;
        uint64 resolutionDue;
        State state;
        uint256 workerPaid;
    }
    struct Plan {
        address buyer;
        address worker;
        bytes32 projectId;
        bytes32 termsHash;
        uint256 price;
        uint256 remaining;
        uint32 maximumRuns;
        uint32 runs;
        uint64 interval;
        uint64 deliverySeconds;
        uint64 expiresAt;
        uint64 nextAt;
        bytes32 lastDeal;
        bool cancelled;
    }

    address public immutable admissionController;
    address public immutable arbiter;
    uint256 public immutable maximumDeal;
    uint256 public immutable maximumPrincipal;
    uint256 public totalLocked;
    uint256 public totalCredits;
    bool public fundingEnabled;
    bool private entered;
    mapping(bytes32 => Deal) public deals;
    mapping(bytes32 => Plan) public plans;
    mapping(address => uint256) public credits;

    event Funded(bytes32 indexed dealId, address indexed buyer, address indexed worker, uint256 amount, bytes32 projectId, bytes32 termsHash, uint64 deliveryDue);
    event Claimed(bytes32 indexed dealId);
    event Delivered(bytes32 indexed dealId, bytes32 resultHash, uint64 reviewDue);
    event Disputed(bytes32 indexed dealId, bytes32 disputeHash, uint64 resolutionDue);
    event Settled(bytes32 indexed dealId, uint256 workerAmount, uint256 buyerAmount, bytes32 evidenceHash);
    event Withdrawn(address indexed account, address indexed recipient, uint256 amount);
    event FundingChanged(bool enabled);
    event PlanCreated(bytes32 indexed planId, address indexed buyer, address indexed worker, uint256 budget);
    event PlanRun(bytes32 indexed planId, uint32 run, bytes32 indexed dealId);
    event PlanCancelled(bytes32 indexed planId, uint256 unspent);

    constructor(address tokenAddress, address controller, address disputeSigner, uint256 dealCeiling, uint256 principalCeiling)
        EIP712("ClausDealEscrow", "1")
    {
        if (controller == address(0) || disputeSigner == address(0) || dealCeiling == 0 || principalCeiling < dealCeiling) revert InvalidTerms();
        if (tokenAddress.code.length == 0 || IERC20Metadata(tokenAddress).decimals() != 18) revert InvalidTerms();
        token = IERC20(tokenAddress);
        admissionController = controller;
        arbiter = disputeSigner;
        maximumDeal = dealCeiling;
        maximumPrincipal = principalCeiling;
        // A verified deployment is not by itself permission to accept deposits.
    }
    modifier nonReentrant() {
        if (entered) revert ReentrantCall();
        entered = true;
        _;
        entered = false;
    }
    function setFundingEnabled(bool enabled) external nonReentrant {
        if (msg.sender != admissionController) revert Unauthorized();
        fundingEnabled = enabled;
        emit FundingChanged(enabled);
    }
    function getDeal(bytes32 id) external view returns (Deal memory) { return deals[id]; }
    function getPlan(bytes32 id) external view returns (Plan memory) { return plans[id]; }
    function dealId(address buyer, bytes32 salt) public view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), "deal", buyer, salt));
    }
    function planId(address buyer, bytes32 salt) public view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), "plan", buyer, salt));
    }
    function createDeal(bytes32 salt, bytes32 projectId, bytes32 termsHash, address worker, uint256 amount, uint64 deliveryDue)
        external nonReentrant returns (bytes32 id)
    {
        _fund(amount);
        if (deliveryDue <= block.timestamp || deliveryDue > block.timestamp + MAX_DURATION) revert InvalidTerms();
        id = dealId(msg.sender, salt);
        _deal(id, msg.sender, worker, amount, projectId, termsHash, deliveryDue);
    }
    function claim(bytes32 id) external nonReentrant {
        Deal storage d = deals[id];
        if (msg.sender != d.worker) revert Unauthorized();
        if (d.state != State.Funded || block.timestamp > d.deliveryDue) revert WrongState();
        d.state = State.Working;
        emit Claimed(id);
    }
    function deliver(bytes32 id, bytes32 resultHash) external nonReentrant {
        Deal storage d = deals[id];
        if (msg.sender != d.worker) revert Unauthorized();
        if (d.state != State.Working || block.timestamp > d.deliveryDue || resultHash == 0) revert WrongState();
        d.resultHash = resultHash;
        d.reviewDue = uint64(block.timestamp + REVIEW_WINDOW);
        d.state = State.Submitted;
        emit Delivered(id, resultHash, d.reviewDue);
    }
    function accept(bytes32 id) external nonReentrant {
        Deal storage d = deals[id];
        if (msg.sender != d.buyer) revert Unauthorized();
        if (d.state != State.Submitted && d.state != State.Disputed) revert WrongState();
        _settle(id, d.amount, 0);
    }
    function refund(bytes32 id) external nonReentrant {
        Deal storage d = deals[id];
        if (msg.sender != d.worker) revert Unauthorized();
        if (d.state == State.Missing || d.state == State.Settled) revert WrongState();
        _settle(id, 0, 0);
    }
    function dispute(bytes32 id, bytes32 reasonHash) external nonReentrant {
        Deal storage d = deals[id];
        if (msg.sender != d.buyer) revert Unauthorized();
        if (d.state != State.Submitted || block.timestamp > d.reviewDue || reasonHash == 0) revert WrongState();
        d.disputeHash = reasonHash;
        d.resolutionDue = uint64(block.timestamp + DISPUTE_WINDOW);
        d.state = State.Disputed;
        emit Disputed(id, reasonHash, d.resolutionDue);
    }
    function resolve(bytes32 id, uint256 workerAmount, bytes32 evidenceHash, uint64 expiresAt, bytes calldata signature) external nonReentrant {
        Deal storage d = deals[id];
        if (d.state != State.Disputed || block.timestamp > d.resolutionDue || block.timestamp > expiresAt) revert WrongState();
        if (workerAmount > d.amount || evidenceHash == 0 || !SignatureChecker.isValidSignatureNow(arbiter,
            _hashTypedDataV4(keccak256(abi.encode(RESOLUTION_TYPEHASH, id, workerAmount, evidenceHash, expiresAt))), signature)) revert Unauthorized();
        _settle(id, workerAmount, evidenceHash);
    }
    function cancelUnclaimed(bytes32 id) external nonReentrant {
        Deal storage d = deals[id];
        if (msg.sender != d.buyer) revert Unauthorized();
        if (d.state != State.Funded) revert WrongState();
        _settle(id, 0, 0);
    }
    function settleExpired(bytes32 id) external nonReentrant {
        Deal storage d = deals[id];
        if ((d.state == State.Funded || d.state == State.Working) && block.timestamp > d.deliveryDue) _settle(id, 0, 0);
        else if (d.state == State.Submitted && block.timestamp > d.reviewDue) _settle(id, d.amount, 0);
        else if (d.state == State.Disputed && block.timestamp > d.resolutionDue) _settle(id, 0, 0);
        else revert WrongState();
    }
    function createPlan(bytes32 salt, bytes32 projectId, bytes32 termsHash, address worker, uint256 price,
        uint32 maximumRuns, uint64 interval, uint64 deliverySeconds, uint64 expiresAt) external nonReentrant returns (bytes32 id)
    {
        uint256 budget = price * maximumRuns;
        _fund(budget);
        if (worker == address(0) || worker == msg.sender || worker == arbiter || msg.sender == arbiter || projectId == 0 || termsHash == 0 || price == 0 || price > maximumDeal
            || maximumRuns == 0 || maximumRuns > 100 || interval < 60
            || interval > MAX_DURATION || deliverySeconds == 0 || deliverySeconds > MAX_DURATION
            || expiresAt <= block.timestamp || expiresAt > block.timestamp + MAX_DURATION) revert InvalidTerms();
        id = planId(msg.sender, salt);
        if (plans[id].buyer != address(0)) revert WrongState();
        plans[id] = Plan(msg.sender, worker, projectId, termsHash, price, budget, maximumRuns, 0,
            interval, deliverySeconds, expiresAt, uint64(block.timestamp), bytes32(0), false);
        emit PlanCreated(id, msg.sender, worker, budget);
    }
    function runPlan(bytes32 id, uint32 expectedRun) external nonReentrant returns (bytes32 nextDeal) {
        Plan storage p = plans[id];
        if (msg.sender != p.buyer) revert Unauthorized();
        if (p.buyer == address(0) || p.cancelled || p.runs != expectedRun || p.runs >= p.maximumRuns || block.timestamp < p.nextAt || block.timestamp >= p.expiresAt) revert WrongState();
        if (p.lastDeal != 0 && (deals[p.lastDeal].state != State.Settled || deals[p.lastDeal].workerPaid != p.price)) revert WrongState();
        nextDeal = keccak256(abi.encode(block.chainid, address(this), "run", id, p.runs));
        p.runs++;
        p.remaining -= p.price;
        p.nextAt = uint64(block.timestamp + p.interval);
        p.lastDeal = nextDeal;
        _deal(nextDeal, p.buyer, p.worker, p.price, p.projectId, p.termsHash, uint64(block.timestamp + p.deliverySeconds));
        emit PlanRun(id, expectedRun, nextDeal);
    }
    function cancelPlan(bytes32 id) external nonReentrant {
        Plan storage p = plans[id];
        if (msg.sender != p.buyer) revert Unauthorized();
        _cancelPlan(id, p);
    }
    function expirePlan(bytes32 id) external nonReentrant {
        Plan storage p = plans[id];
        if (p.buyer == address(0) || block.timestamp < p.expiresAt) revert WrongState();
        _cancelPlan(id, p);
    }
    function withdraw(uint256 amount, address payable recipient) external nonReentrant {
        if (amount == 0 || amount > credits[msg.sender] || recipient == address(0) || recipient == address(this)) revert InvalidTerms();
        credits[msg.sender] -= amount;
        totalCredits -= amount;
        uint256 held = token.balanceOf(address(this));
        uint256 received = token.balanceOf(recipient);
        token.safeTransfer(recipient, amount);
        if (token.balanceOf(address(this)) != held - amount || token.balanceOf(recipient) != received + amount) revert TransferFailed();
        emit Withdrawn(msg.sender, recipient, amount);
    }
    function _fund(uint256 amount) private {
        if (!fundingEnabled) revert FundingPaused();
        if (amount == 0) revert InvalidTerms();
        // Accounted custody includes withdrawable credits; idle credits can block new admission.
        // Existing withdrawals and settlement remain available even at this ceiling.
        if (totalLocked + totalCredits + amount > maximumPrincipal) revert CapacityReached();
        totalLocked += amount;
        uint256 held = token.balanceOf(address(this));
        uint256 payerBalance = token.balanceOf(msg.sender);
        token.safeTransferFrom(msg.sender, address(this), amount);
        if (token.balanceOf(address(this)) != held + amount || token.balanceOf(msg.sender) != payerBalance - amount) revert TransferFailed();
    }
    function _deal(bytes32 id, address buyer, address worker, uint256 amount, bytes32 projectId, bytes32 termsHash, uint64 due) private {
        if (worker == address(0) || worker == buyer || worker == arbiter || buyer == arbiter || amount == 0 || amount > maximumDeal || projectId == 0 || termsHash == 0) revert InvalidTerms();
        if (deals[id].state != State.Missing) revert WrongState();
        Deal storage d = deals[id];
        d.buyer = buyer; d.worker = worker; d.amount = amount; d.projectId = projectId; d.termsHash = termsHash; d.deliveryDue = due; d.state = State.Funded;
        emit Funded(id, buyer, worker, amount, projectId, termsHash, due);
    }
    function _settle(bytes32 id, uint256 workerAmount, bytes32 evidenceHash) private {
        Deal storage d = deals[id];
        d.state = State.Settled; d.workerPaid = workerAmount; d.evidenceHash = evidenceHash;
        totalLocked -= d.amount;
        totalCredits += d.amount;
        credits[d.worker] += workerAmount;
        credits[d.buyer] += d.amount - workerAmount;
        emit Settled(id, workerAmount, d.amount - workerAmount, evidenceHash);
    }
    function _cancelPlan(bytes32 id, Plan storage p) private {
        if (p.cancelled) revert WrongState();
        uint256 unspent = p.remaining;
        p.cancelled = true; p.remaining = 0;
        totalLocked -= unspent; totalCredits += unspent; credits[p.buyer] += unspent;
        emit PlanCancelled(id, unspent);
    }
}
