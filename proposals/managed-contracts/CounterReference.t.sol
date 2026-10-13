// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;
import {ClausManagedExecutorTest} from "./ClausManagedExecutor.t.sol";
import {ClausManagedExecutor} from "./ClausManagedExecutor.sol";
import {Counter} from "managed-reference/Counter.sol";

contract CounterReferenceTest is ClausManagedExecutorTest {
    function testReferenceInitializationRequiresExecutorEvenWhenActivationIsEmpty() public {
        Counter implementation = new Counter();
        uint256 initialBlock = block.number;
        for (uint256 i; i < 2; ++i) {
            bytes memory data = i == 0 ? abi.encodeCall(implementation.initializeCounter, (7)) : bytes("");
            ClausManagedExecutor.Registration memory r = registration(keccak256(abi.encode("reference", i)));
            r.implementation = address(implementation);
            r.codeHash = address(implementation).codehash;
            r.initCallHash = keccak256(data);
            address at = executor.registerProject(r, data, sign(OWNER, executor.registrationDigest(r)));
            ClausManagedExecutor.Approval memory a = initialApproval(r, at);
            bytes memory signature = sign(CLAUS, executor.approvalDigest(a));
            executor.queue(a, signature);
            vm.roll(initialBlock + i + 1);
            executor.execute(a, data, signature);
            vm.expectRevert(bytes("executor only"));
            Counter(at).initializeCounter(type(uint256).max);
            assertEq(Counter(at).count(), i == 0 ? 7 : 0);
            Counter(at).increment();
            assertEq(Counter(at).count(), i == 0 ? 8 : 1);
        }
    }
}
