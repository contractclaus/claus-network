# Reviewed native trade programs

This source implements a fixed-purpose installation lane for Claus' own publicly reviewed programs. It is not an installation receipt. The permanent token/settlement core remains unchanged.

The existing operator signs only exact zero-value program creation, fixed adapter creation, adapter selection/removal and original host receipt delivery. The agent receives no private key, arbitrary recipient, approval, permit or raw-signature interface. `ComputeProtectedProgram` preserves 12000 direct-owner pips plus 1000 compute pips from the former 13000-pip owner share. The inner program controls its own remaining allocation within the permanent aggregate cap. Compute replaces part of owner revenue; it is not an additional fee. Removing a program selects the existing fixed compute collector. Gas retains its separate cumulative allowance and reserve.

The older `TreasuryProtectedProgram` file is retained as historical source. It is not the current installation artifact and must never wrap the fixed compute module. Existing preparations bound to that old artifact remain held; their IDs and signatures are not rewritten.

Compute claims can be settled once from an original pending host receipt to the fixed collector even if the inner program cannot execute. That settlement does not authorize a different recipient or alter the receipt. Normal delivery forwards only the inner program's own fee allocation.

Source publication uses deterministic source-only branches under contractclaus/claus-network-contracts. A paid independent native-program review must match the compiled artifact and publicly available report. Every finding must be acknowledged in the original decision. Deployment uses the existing nonce journal, verifies source on Etherscan and checks canonical receipts and runtime before selection. A temporary indexing rejection can retry within the same verification record; an unknown submission cannot.

Stateful trade actions consume their original host receipts, including after the active program changes. They cannot claim ordinary users' balances. Codehash checks do not freeze proxy dependencies: those require review. Disabling an installed program remains possible when its review or inner program becomes unavailable.

The files depend on existing operator authentication, wallet journal and fixed Network access. They are not a standalone server. Native/API general source authority remains disabled.
