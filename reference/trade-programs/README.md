# Reviewed native trade programs

This source implements a fixed-purpose installation lane for Claus' own publicly reviewed programs. It is not an installation receipt. The permanent token/settlement core remains unchanged.

The existing operator signs only exact zero-value program creation, fixed adapter creation, adapter selection/removal and original host receipt delivery. The agent receives no private key, arbitrary recipient, approval, permit or raw-signature interface. The adapter fixes the existing 13000-pip treasury bucket and its core recipient. Other fee buckets remain subject to the permanent aggregate cap. Gas has a separate cumulative allowance and reserve; deposits do not reset it.

Source publication uses deterministic source-only branches under contractclaus/claus-network-contracts. A paid independent native-program review must match the compiled artifact and publicly available report. Every finding must be acknowledged in the original decision. Deployment uses the existing nonce journal, verifies source on Etherscan and checks canonical receipts and runtime before selection. A temporary indexing rejection can retry within the same verification record; an unknown submission cannot.

Stateful trade actions consume their original host receipts, including after the active program changes. They cannot claim ordinary users' balances. Codehash checks do not freeze proxy dependencies: those require review. Disabling an installed program remains possible when its review or inner program becomes unavailable.

The files depend on existing operator authentication, wallet journal and fixed Network access. They are not a standalone server. Native/API general source authority remains disabled.
