// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface ICapitalToken {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
    function receiveWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32) external;
}

/// One agreement per deployment. The counterparty deploys and relays it.
/// No owner upgrade, arbitrary call, allowance, fee, recipient change or rescue.
contract ClausCapitalEscrow {
    address public constant INVESTOR = 0xA46A89b5b3504C1c999696de8173ec9b2eB0a01a;
    address public constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    bytes32 private constant DOMAIN_TYPEHASH = keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant RELEASE_TYPEHASH = keccak256("Release(bytes32 termsHash,bytes32 deliveryHash)");
    uint256 private constant HALF_ORDER = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    address public counterparty;
    uint256 public amount;
    uint256 public expiresAt;
    bytes32 public termsHash;
    uint8 public mode; // 0: milestone; 1: atomic token allocation
    address public deliveryToken;
    uint256 public deliveryAmount;
    bytes32 public deliveryCodeHash;
    uint8 public state; // 0: unfunded; 1: escrowed; 2: released; 3: refunded
    bool private entered;

    event Funded(bytes32 indexed termsHash, uint256 amount);
    event Released(bytes32 indexed termsHash, bytes32 deliveryHash);
    event Refunded(bytes32 indexed termsHash);

    constructor(address party,uint256 value,uint256 deadline,bytes32 terms,uint8 instrument,
        address token,uint256 tokenAmount,bytes32 tokenHash) {
        require(block.chainid == 8453 && party == msg.sender && party != INVESTOR, "party");
        require(value > 0 && value <= 25_000_000 && deadline > block.timestamp && terms != bytes32(0), "terms");
        require(instrument <= 1, "instrument");
        if (instrument == 0) require(token == address(0) && tokenAmount == 0 && tokenHash == bytes32(0), "milestone");
        else require(token != address(0) && token != USDC && tokenAmount > 0 && tokenHash != bytes32(0), "token");
        counterparty=party; amount=value; expiresAt=deadline; termsHash=terms; mode=instrument;
        deliveryToken=token; deliveryAmount=tokenAmount; deliveryCodeHash=tokenHash;
    }

    modifier nonReentrant() { require(!entered,"reentry"); entered=true; _; entered=false; }

    function authorizationNonce() public view returns (bytes32) {
        return keccak256(abi.encode(block.chainid,address(this),termsHash));
    }

    function fund(uint8 v,bytes32 r,bytes32 s) external nonReentrant {
        require(state == 0 && block.timestamp < expiresAt,"state");
        state=1;
        uint256 beforeBalance=ICapitalToken(USDC).balanceOf(address(this));
        ICapitalToken(USDC).receiveWithAuthorization(INVESTOR,address(this),amount,0,expiresAt,authorizationNonce(),v,r,s);
        require(ICapitalToken(USDC).balanceOf(address(this)) == beforeBalance+amount,"receipt");
        emit Funded(termsHash,amount);
        if(mode == 1) {
            require(deliveryToken.codehash == deliveryCodeHash,"code");
            uint256 beforeTokens=ICapitalToken(deliveryToken).balanceOf(INVESTOR);
            require(ICapitalToken(deliveryToken).transferFrom(counterparty,INVESTOR,deliveryAmount),"delivery");
            require(ICapitalToken(deliveryToken).balanceOf(INVESTOR) == beforeTokens+deliveryAmount,"quantity");
            state=2;
            require(ICapitalToken(USDC).transfer(counterparty,amount),"payment");
            emit Released(termsHash,bytes32(0));
        }
    }

    function release(bytes32 deliveryHash,uint8 v,bytes32 r,bytes32 s) external nonReentrant {
        require(mode == 0 && state == 1 && block.timestamp < expiresAt && deliveryHash != bytes32(0),"state");
        bytes32 domain=keccak256(abi.encode(DOMAIN_TYPEHASH,keccak256("Claus Capital Escrow"),keccak256("1"),block.chainid,address(this)));
        bytes32 message=keccak256(abi.encode(RELEASE_TYPEHASH,termsHash,deliveryHash));
        require((v == 27 || v == 28) && uint256(s) <= HALF_ORDER && uint256(s) > 0,"signature");
        require(ecrecover(keccak256(abi.encodePacked("\x19\x01",domain,message)),v,r,s) == INVESTOR,"investor");
        state=2;
        require(ICapitalToken(USDC).transfer(counterparty,amount),"payment");
        emit Released(termsHash,deliveryHash);
    }

    function refund() external nonReentrant {
        require(mode == 0 && state == 1 && block.timestamp >= expiresAt,"state");
        state=3;
        require(ICapitalToken(USDC).transfer(INVESTOR,amount),"refund");
        emit Refunded(termsHash);
    }
}
