// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

/// @notice Non-custodial reference. Anyone may increment this public counter.
contract Counter {
    bool private initialized;
    uint256 public count;

    function initializeCounter(uint256 initialCount) external {
        require(!initialized, "already initialized");
        initialized = true;
        count = initialCount;
    }

    function increment() external { ++count; }
}

/// @notice Same storage, additional public operation; no new initializer.
contract CounterV2 is Counter {
    function incrementTwo() external { count += 2; }
}
