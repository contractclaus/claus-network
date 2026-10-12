# Protected testnet changes

This interface is restricted to sponsored pilot projects and the `claus-readonly-v1` profile on Sepolia (chain ID `11155111`). Check `testnetExecution` in `/health` before use. Registration, compilation or an IMD report does not itself authorize a change. Mainnet execution is not enabled by these operations.

## Register a contract

1. Complete an IMD review through the review API. Keep the reviewed source published.
2. Call `module_deploy` with the review `caseId`. The worker deploys the exact compiled module, verifies its runtime and requests public source verification. Poll `module_get` until its state is `verified`.
3. The project owner calls `registration_prepare` with the verified `moduleId`, the module-specific ABI-encoded `configuration`, an active agent `mandateId`, and `minDelaySeconds`. The active replacement accepts zero through five days and reads the pinned executor’s actual minimum before preparing a signature. Use zero for execution without a mandatory upgrade wait after approval. Existing projects keep their original executor and accepted delay; a zero-delay request against the legacy executor fails with `executor_delay_required`.
4. The owner signs exactly the returned EIP-712 `domain`, `types`, `primaryType` and `message` with their own wallet. This signature authorizes an on-chain project registration and is different from the API login signature. The private key stays with the owner.
5. Call `registration_submit` with the returned `registrationId` and signature. Poll `registration_get` until `verified`; `chain_binding` then returns the project's target, owner, executor and verification evidence.

The owner chooses the initial module and configuration. Later protected changes require Claus. The initial module interface must expose `evaluate(bytes,bytes)` as a read-only function, have no constructor arguments, no payable entry point, and no mutable function interface. Modules with immutables or externally linked libraries are outside this initial deployment profile.

## Request a change

Call `proposal_create` with the desired verified `moduleId`, ABI-encoded `configuration`, and a stable `idempotencyKey`. The credential needs both `proposal.create` and `proposal.execute`. This operation requests the complete review-and-execution workflow; there is no second wallet confirmation for each routine step.

Claus receives the exact source, build identity, independent report and proposed on-chain change. An approval is bound to those inputs. The isolated controller then signs only that approval; a separate executor queues it and submits the exact change when the contract permits it. The new source has no mandatory waiting period; any explicitly accepted project delay or future approval start time still applies. Poll `proposal_get` for progress. A rejection is terminal and causes no upgrade.

The state sequence is `reviewing` → `approved` → `queueing` → `queued` → `executing` → `executed`. `rejected`, `blocked`, `cancelled` and `failed` are terminal outcomes. A job can be cancelled through `job_cancel` only before its effect starts. Provider or network uncertainty retains the existing request and transaction identities. Do not create a fresh request merely because a response is slow.

The source and existing contract state must still match when Claus signs and when the executor sends. Any owner or policy change can make an old proposal stale. A new proposal must use the new bindings; an old signature cannot be relabelled with new evidence.

## Revoke and publish

Revoking a credential, agent mandate or sponsorship stops new stoppable worker actions. A queued internal Claus inference request is cancelled without buying inference. A possibly paid request is reconciled using its original identity. A blockchain transaction that has already been broadcast cannot be recalled by an API update.

Once an approval signature has been published on chain, anyone can submit it within its permitted window. The owner can use the executor's `cancelApproval(projectKey, nonce)` for a targeted on-chain cancellation, or `setAuthority(projectKey, mandateHash, false)` to invalidate the project's current authority. These are owner-signed contract calls and work from a CLI or wallet library without the website. The `ApprovalQueued` event exposes the nonce. Revoking upgrade authority does not disable public reads from the already installed module.

Use `proposal_publish` to add a completed decision and, when executed, its deployment receipt to the public project profile. Publication requires `project.publish`, an expected revision and still-published source. Internal inference payment material is not included in that projection.

A decision can be published while its approved change is still queued. When execution completes, the worker adds the deployment receipt to that existing publication automatically. It does not require another publication request or change its publication revision. Withdrawing the publication before completion prevents that receipt from being added; execution never publishes a private decision by itself.

Source verification, independent review, Claus approval and confirmed execution remain separate evidence. This profile has no custody of customer funds and establishes no safety guarantee for future token, lending or trading products.

## Retained trust boundaries

The module call forwards at most 200,000 gas. This is not a bound on the caller's total gas: the current kernel copies return data after the call. The initial balance lens returns a fixed 224 bytes. A broader module profile must account for output size as well as computation.

The network controller produces short-lived approvals and registrations. The underlying executor does not impose a universal maximum signature lifetime; its signer must maintain the documented expiry policy. Directly registered owner modules do not thereby receive a Claus approval. A code hash identifies code, not the current state of external contracts it reads.

The recovery owner can pause all protected upgrades immediately and invalidate outstanding signatures by scheduling signer recovery. Cancelling recovery does not restore those old signatures. Project reads continue during upgrade suspension. None of these controls should be described as a guarantee against every malicious module or dependency.
