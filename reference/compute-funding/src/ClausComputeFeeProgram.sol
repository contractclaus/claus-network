// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IProgram, ProgramTypes} from "./IClausTradeProgram.sol";

interface IComputeClaims {
    function balanceOf(address owner, uint256 id) external view returns (uint256);
    function unlock(bytes calldata data) external returns (bytes memory);
    function burn(address from, uint256 id, uint256 amount) external;
    function take(address currency, address to, uint256 amount) external;
}

/// @notice Allocates 0.1 percentage point FROM the existing 1.3% owner share.
/// @dev Installed as a fixed module, the sealed hook mints the module's claims
/// directly here. The fixed 2.3% aggregate rate and other allocations do not rise.
/// The public claim interface matches the prepared funding runner. Every claim
/// goes to the existing fixed operator wallet; there is no caller-set recipient.
contract ClausComputeFeeProgram is IProgram {
    address public constant MANAGER = 0x000000000004444c5dc75cB358380D2e3dE08A90;
    address public constant active = 0xBb145cA83272c3806D4dDc75cA1D5514789cF1C5;
    uint256 public constant COMPUTE_PIPS = 1_000;
    uint256 public constant DIRECT_OWNER_PIPS = 12_000;
    uint256 public constant TOTAL_OWNER_PIPS = DIRECT_OWNER_PIPS + COMPUTE_PIPS;
    uint256 public constant TOTAL_PIPS = 23_000;

    uint256 public totalClaimed;
    uint256 private claiming;
    uint256 private constant CALLBACK_CONSUMED = type(uint256).max;

    error InvalidClaim();
    error InvalidCallback();
    event ComputeFundingClaimed(address indexed recipient, uint256 amount);

    function quote(address, bool, int256, uint160, uint128, bytes calldata)
        external pure returns (uint256[6] memory)
    {
        // Treasury, platform, buyback, staked LP, staked NFT, compute.
        return [DIRECT_OWNER_PIPS, 3_000, 1_500, 2_000, 3_500, COMPUTE_PIPS];
    }

    /// @dev The fixed host authenticates and consumes its receipts. This
    /// callback is deliberately side-effect-free: receipt delivery cannot depend
    /// on a provider, bridge, oracle, ETH recipient or funding worker being up.
    function onTrade(ProgramTypes.Trade calldata, bytes calldata)
        external pure returns (bytes4)
    {
        return IProgram.onTrade.selector;
    }

    function balances() external view returns (uint256 activeAmount, uint256 treasuryAmount) {
        return (IComputeClaims(MANAGER).balanceOf(address(this), 0), 0);
    }

    /// @notice Redeem only this program's already received ETH claims.
    /// Anyone may trigger a batch, always to the same fixed operator account.
    function claimActive(uint256 amount) external {
        if (claiming != 0 || amount == 0 || amount == CALLBACK_CONSUMED
            || amount > IComputeClaims(MANAGER).balanceOf(address(this), 0)) revert InvalidClaim();
        claiming = amount;
        IComputeClaims(MANAGER).unlock(abi.encode(amount));
        claiming = 0;
        totalClaimed += amount;
        emit ComputeFundingClaimed(active, amount);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != MANAGER || claiming == 0 || claiming == CALLBACK_CONSUMED || data.length != 32) revert InvalidCallback();
        uint256 amount = abi.decode(data, (uint256));
        if (amount != claiming) revert InvalidCallback();
        // Retain the outer lock while preventing a second callback.
        claiming = CALLBACK_CONSUMED;
        IComputeClaims(MANAGER).burn(address(this), 0, amount);
        IComputeClaims(MANAGER).take(address(0), active, amount);
        return "";
    }
}

