// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ClausManagedProject} from "./ClausManagedProject.sol";

/// @notice Candidate general-code profile. Not admitted or deployed.
/// Module state is separate from the upgrade registry. Review is not a safety guarantee.
contract ClausManagedExecutor is EIP712, ReentrancyGuard {
    error InvalidRegistration();
    error InvalidApproval();
    error InvalidSignature();
    error NotReady();
    error AlreadyExecuted();
    error OwnerOnly();
    error InvalidPolicy();
    error InvalidRecovery();

    /// Projects may execute as soon as Claus approves. A project can explicitly
    /// opt into a longer delay when it registers; accepted delays stay binding.
    uint64 public constant MIN_UPGRADE_DELAY = 0;
    uint64 public constant MAX_DELAY = 365 days;

    bytes32 public constant REGISTRATION_TYPEHASH = keccak256(
        "Registration(bytes32 projectId,address owner,bytes32 salt,address implementation,bytes32 codeHash,bytes32 initCallHash,bytes32 mandateHash,bytes32 policyVersion,uint64 minDelaySeconds,uint256 nonce,uint64 expiresAt)"
    );
    bytes32 public constant APPROVAL_TYPEHASH = keccak256(
        "Approval(bytes32 projectId,uint256 chainId,address executor,address target,uint64 fromVersion,bytes32 fromCodeHash,address implementation,bytes32 toCodeHash,bytes32 initCallHash,bytes32 dependencySnapshotHash,bytes32 evidenceHash,bytes32 policyVersion,uint64 policyGeneration,uint64 authorityGeneration,uint64 clausGeneration,bytes32 mandateHash,uint256 nonce,uint64 notBefore,uint64 expiresAt)"
    );

    struct Registration {
        bytes32 projectId;
        address owner;
        bytes32 salt;
        address implementation;
        bytes32 codeHash;
        bytes32 initCallHash;
        bytes32 mandateHash;
        bytes32 policyVersion;
        uint64 minDelaySeconds;
        uint256 nonce;
        uint64 expiresAt;
    }

    struct Approval {
        bytes32 projectId;
        uint256 chainId;
        address executor;
        address target;
        uint64 fromVersion;
        bytes32 fromCodeHash;
        address implementation;
        bytes32 toCodeHash;
        bytes32 initCallHash;
        bytes32 dependencySnapshotHash;
        bytes32 evidenceHash;
        bytes32 policyVersion;
        uint64 policyGeneration;
        uint64 authorityGeneration;
        uint64 clausGeneration;
        bytes32 mandateHash;
        uint256 nonce;
        uint64 notBefore;
        uint64 expiresAt;
    }

    struct Project {
        address owner;
        address target;
        bytes32 mandateHash;
        bytes32 policyVersion;
        uint64 minDelaySeconds;
        uint64 policyGeneration;
        uint64 authorityGeneration;
        bool enabled;
    }

    struct Module {
        address implementation;
        bytes32 codeHash;
        uint64 version;
        bytes configuration;
    }
    mapping(bytes32 => Module) private modules;

    // Registration reserves a dormant target. The first real implementation
    // needs the same independently reviewed Claus approval as every upgrade.
    struct InitialModule {
        address implementation;
        bytes32 codeHash;
        bytes32 initCallHash;
        uint256 createdAtBlock;
    }
    mapping(bytes32 => InitialModule) public initialModules;

    function moduleState(bytes32 id) external view returns (address, bytes32, uint64, bytes memory) {
        Module storage m = modules[id];
        return (m.implementation, m.codeHash, m.version, m.configuration);
    }

    function moduleCode(bytes32 id) external view returns (address, bytes32) {
        Module storage m = modules[id];
        return (m.implementation, m.codeHash);
    }

    address public clausSigner;
    uint64 public clausGeneration = 1;
    address public immutable recoveryOwner;
    uint64 public immutable recoveryDelay;
    address public pendingSigner;
    uint64 public recoveryReadyAt;
    mapping(bytes32 => Project) public projects;
    mapping(bytes32 => address) public pendingProjectOwners;
    mapping(address => mapping(uint256 => bool)) public registrationNonces;
    mapping(bytes32 => mapping(uint256 => bool)) public executionNonces;
    mapping(bytes32 => uint256) public readyAt;

    event ProjectRegistered(
        bytes32 indexed projectId, address indexed target, address indexed owner, bytes32 mandateHash
    );
    event ApprovalQueued(bytes32 indexed projectId, bytes32 indexed approvalHash, uint256 readyAt, uint256 nonce);
    event UpgradeExecuted(
        bytes32 indexed projectId, bytes32 indexed approvalHash, address implementation, uint64 version
    );
    event ProjectAuthorityChanged(bytes32 indexed projectId, uint64 generation, bytes32 mandateHash, bool enabled);
    event ProjectPolicyChanged(
        bytes32 indexed projectId, uint64 generation, bytes32 policyVersion, uint64 minDelaySeconds
    );
    event SignerRecoveryScheduled(address indexed signer, uint64 readyAt);
    event SignerRecovered(address indexed signer, uint64 generation);
    event SignerRecoveryCancelled();
    event RegistrationCancelled(address indexed owner, uint256 nonce);
    event ApprovalCancelled(bytes32 indexed projectId, uint256 nonce);
    event ProjectOwnerProposed(bytes32 indexed projectId, address indexed owner);
    event ProjectOwnerChanged(bytes32 indexed projectId, address indexed owner, uint64 generation);

    constructor(address signer, address recovery, uint64 delay) EIP712("Claus Managed Network", "1") {
        if (signer == address(0) || recovery == address(0) || delay < 1 days || delay > MAX_DELAY) {
            revert InvalidRecovery();
        }
        clausSigner = signer;
        recoveryOwner = recovery;
        recoveryDelay = delay;
    }

    function registrationDigest(Registration calldata r) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(REGISTRATION_TYPEHASH, r)));
    }

    function approvalDigest(Approval calldata a) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(APPROVAL_TYPEHASH, a)));
    }

    function projectKey(address owner, bytes32 salt) public pure returns (bytes32) {
        return keccak256(abi.encode(owner, salt));
    }

    function cancelRegistration(uint256 nonce) external {
        registrationNonces[msg.sender][nonce] = true;
        emit RegistrationCancelled(msg.sender, nonce);
    }

    function registerProject(Registration calldata r, bytes calldata configuration, bytes calldata ownerSignature)
        external
        nonReentrant
        returns (address target)
    {
        if (
            pendingSigner != address(0) || r.projectId != projectKey(r.owner, r.salt) || r.owner == address(0)
                || projects[r.projectId].target != address(0) || r.implementation == address(this)
                || r.implementation.code.length == 0 || r.implementation.codehash != r.codeHash
                || keccak256(configuration) != r.initCallHash || configuration.length > 8192
                || r.mandateHash == bytes32(0) || r.policyVersion == bytes32(0) || r.minDelaySeconds < MIN_UPGRADE_DELAY
                || r.minDelaySeconds > MAX_DELAY || r.expiresAt <= block.timestamp
                || registrationNonces[r.owner][r.nonce]
        ) revert InvalidRegistration();
        if (!SignatureChecker.isValidSignatureNow(r.owner, registrationDigest(r), ownerSignature)) {
            revert InvalidSignature();
        }
        registrationNonces[r.owner][r.nonce] = true;
        target = address(new ClausManagedProject(r.projectId));
        initialModules[r.projectId] = InitialModule(r.implementation, r.codeHash, r.initCallHash, block.number);
        projects[r.projectId] = Project(r.owner, target, r.mandateHash, r.policyVersion, r.minDelaySeconds, 1, 1, true);
        emit ProjectRegistered(r.projectId, target, r.owner, r.mandateHash);
    }

    function queue(Approval calldata a, bytes calldata clausSignature) external returns (bytes32 hash) {
        _validate(a);
        hash = approvalDigest(a);
        if (!SignatureChecker.isValidSignatureNow(clausSigner, hash, clausSignature)) revert InvalidSignature();
        if (readyAt[hash] == 0) {
            uint256 earliest = block.timestamp + projects[a.projectId].minDelaySeconds;
            uint256 ready = earliest > a.notBefore ? earliest : a.notBefore;
            if (ready >= a.expiresAt) revert InvalidApproval();
            readyAt[hash] = ready;
            emit ApprovalQueued(a.projectId, hash, readyAt[hash], a.nonce);
        }
    }

    function execute(Approval calldata a, bytes calldata configuration, bytes calldata clausSignature)
        external
        nonReentrant
    {
        _validate(a);
        // EIP-6780 permits SELFDESTRUCT to delete a target in its creation
        // transaction. No module code may execute in that creation block.
        if (block.number <= initialModules[a.projectId].createdAtBlock) revert NotReady();
        bytes32 hash = approvalDigest(a);
        if (readyAt[hash] == 0 || block.timestamp < readyAt[hash]) revert NotReady();
        if (keccak256(configuration) != a.initCallHash || configuration.length > 8192) revert InvalidApproval();
        if (!SignatureChecker.isValidSignatureNow(clausSigner, hash, clausSignature)) revert InvalidSignature();
        executionNonces[a.projectId][a.nonce] = true;
        delete readyAt[hash];
        Module storage m = modules[a.projectId];
        m.implementation = a.implementation;
        m.codeHash = a.toCodeHash;
        ++m.version;
        m.configuration = configuration;
        ClausManagedProject(payable(a.target)).initialize(configuration);
        emit UpgradeExecuted(a.projectId, hash, a.implementation, m.version);
    }

    function setAuthority(bytes32 id, bytes32 mandateHash, bool enabled) external {
        Project storage p = projects[id];
        if (msg.sender != p.owner) revert OwnerOnly();
        if (mandateHash == bytes32(0)) revert InvalidPolicy();
        p.mandateHash = mandateHash;
        p.enabled = enabled;
        ++p.authorityGeneration;
        emit ProjectAuthorityChanged(id, p.authorityGeneration, mandateHash, enabled);
    }

    function cancelApproval(bytes32 id, uint256 nonce) external {
        Project storage p = projects[id];
        if (
            p.target == address(0)
                || (msg.sender != p.owner && (msg.sender != clausSigner || pendingSigner != address(0)))
        ) revert OwnerOnly();
        executionNonces[id][nonce] = true;
        emit ApprovalCancelled(id, nonce);
    }

    /// A pending owner transfer suspends upgrades. A zero address cancels it.
    function proposeProjectOwner(bytes32 id, address nextOwner) external {
        Project storage p = projects[id];
        if (msg.sender != p.owner) revert OwnerOnly();
        pendingProjectOwners[id] = nextOwner;
        ++p.authorityGeneration;
        emit ProjectOwnerProposed(id, nextOwner);
    }

    /// The new owner must explicitly set a fresh mandate before upgrades resume.
    function acceptProjectOwner(bytes32 id) external {
        if (msg.sender != pendingProjectOwners[id]) revert OwnerOnly();
        Project storage p = projects[id];
        p.owner = msg.sender;
        p.enabled = false;
        p.mandateHash = bytes32(0);
        ++p.authorityGeneration;
        delete pendingProjectOwners[id];
        emit ProjectOwnerChanged(id, msg.sender, p.authorityGeneration);
    }

    function setPolicy(bytes32 id, bytes32 policyVersion, uint64 delay) external {
        Project storage p = projects[id];
        if (msg.sender != p.owner) revert OwnerOnly();
        // Accepted delay protection can only become stronger for this instance.
        if (policyVersion == bytes32(0) || delay < p.minDelaySeconds || delay > MAX_DELAY) revert InvalidPolicy();
        p.policyVersion = policyVersion;
        p.minDelaySeconds = delay;
        ++p.policyGeneration;
        emit ProjectPolicyChanged(id, p.policyGeneration, policyVersion, delay);
    }

    function scheduleSignerRecovery(address signer) external {
        if (msg.sender != recoveryOwner) revert OwnerOnly();
        if (signer == address(0)) revert InvalidRecovery();
        pendingSigner = signer;
        recoveryReadyAt = uint64(block.timestamp) + recoveryDelay;
        ++clausGeneration;
        emit SignerRecoveryScheduled(signer, recoveryReadyAt);
    }

    function cancelSignerRecovery() external {
        if (msg.sender != recoveryOwner) revert OwnerOnly();
        ++clausGeneration;
        pendingSigner = address(0);
        recoveryReadyAt = 0;
        emit SignerRecoveryCancelled();
    }

    function finishSignerRecovery() external {
        if (pendingSigner == address(0) || block.timestamp < recoveryReadyAt) revert NotReady();
        clausSigner = pendingSigner;
        ++clausGeneration;
        pendingSigner = address(0);
        recoveryReadyAt = 0;
        emit SignerRecovered(clausSigner, clausGeneration);
    }

    function _validate(Approval calldata a) private view {
        Project memory p = projects[a.projectId];
        if (
            !p.enabled || pendingSigner != address(0) || pendingProjectOwners[a.projectId] != address(0)
                || a.chainId != block.chainid || a.executor != address(this) || a.target != p.target
                || a.target == address(0) || a.policyVersion != p.policyVersion
                || a.policyGeneration != p.policyGeneration || a.authorityGeneration != p.authorityGeneration
                || a.clausGeneration != clausGeneration || a.mandateHash != p.mandateHash
                || a.evidenceHash == bytes32(0) || a.dependencySnapshotHash == bytes32(0)
                || a.expiresAt <= block.timestamp || a.notBefore >= a.expiresAt || a.implementation.code.length == 0
                || a.implementation == a.target || a.implementation == address(this)
                || a.implementation.codehash != a.toCodeHash || modules[a.projectId].version != a.fromVersion
                || modules[a.projectId].codeHash != a.fromCodeHash
        ) revert InvalidApproval();
        if (a.fromVersion == 0) {
            InitialModule memory first = initialModules[a.projectId];
            if (
                a.implementation != first.implementation || a.toCodeHash != first.codeHash
                    || a.initCallHash != first.initCallHash
            ) revert InvalidApproval();
        }
        if (executionNonces[a.projectId][a.nonce]) revert AlreadyExecuted();
    }
}
