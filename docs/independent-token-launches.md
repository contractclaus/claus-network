# Independent project token launches

The protected Programmable partner profile and Claus launch gateway are enabled. This opens the reviewed launch workflow for eligible independent projects; it does not approve an arbitrary token automatically. Each project must provide its own identity, source, governed policy and fresh CLAUS/USD price evidence. Check the live `partner_launch profile` before submitting. The API never treats an applicant-supplied `approved` flag as permission.

Each eligible launch pairs an independent project token with the existing official CLAUS token on Ethereum. Programmable's fixed 0.3% platform fee is included in the 15% aggregate buy/sell fee ceiling, including the initial trade. Creator rights are limited to claiming their fixed fees. Trading/transfer freezes, blacklists and withdrawal of locked LP principal cannot be added by an upgrade. Optional policy code runs outside the immutable kernel.

## Flow

1. The project's own Ethereum wallet creates its Network project and publishes the exact source snapshot, including the complete Programmable request JSON. The creator remains distinct from Claus and the protected governance signers.
2. Compile the components and create one review with profile `claus-partner-launch-v1`, chainId `1` and `partnerLaunchJson` matching the published request and current assignment. The context names the original build IDs and provides independent-ownership evidence. Another wallet address alone is insufficient evidence.
3. Claus uses `partner_launch stage` with the original projectId and caseId to create one pending provider request before paying for a long review. This is not approval or a token launch. Preserve the returned operationId.
4. The same review proceeds through the existing quote/admission workflow. It must be settled, complete and published, with an accepted independent IMD judge and no unresolved blocking findings. Missing source, identity, oracle or governance evidence prevents approval.
5. Claus reads `partner_launch_evidence` and records a deliberate decision through `partner_launch_approve`. The receipt binds the request, owner, assignment, compiled source and review. Its short execution window can be renewed against the same review without buying that review again. A withdrawal cancels the whole reviewed context and blocks such renewal.
6. `partner_launch admit` receives the original pending operationId and receiptId. Programmable independently rereads the authoritative receipt and current onchain governance before permitting execution. The project's wallet signs the actual launch transaction; it receives no policy-upgrade or LP-withdrawal rights.

The protected gateway's `profile`, `stage`, `preflight`, `submit`, `admit` and `status` commands expose no API key or generic wallet signer. `submit` is a receipt-bound fallback when a pending provider request was not created earlier. A provider request, approved receipt or transaction proposal is not proof of a successfully executed and verified launch.

There will never be an additional self-issued Claus token, including under another name or through a controlled project. This integration does not change the existing CLAUS token, its treasury split or current staking rewards.
