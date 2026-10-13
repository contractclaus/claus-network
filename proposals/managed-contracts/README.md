# Managed project contracts — candidate, not released

This proposal adds stateful project logic behind a separate, immutable Claus-controlled upgrade registry. It does not modify existing readonly instances, activate customer deposits or grant arbitrary transaction signing to agents. It is not available through the current API, and has not completed independent review.

The proxy keeps the registry and project identity in bytecode. An implementation can write project storage, but cannot change the implementation address by overwriting a proxy storage slot. The registry records the implementation, bytecode hash, version and exact initialization data. Initial registration requires both the owner and Claus to sign the same source-bound registration. Later upgrades retain the exact approval bindings, nonce, owner mandate, revocation, policy generation, signer recovery and optional owner-selected delay of the existing executor. Upgrade and initialization either succeed together or revert together.

The proposal intentionally preserves a fixed set of proxy selectors: `executor`, `projectId`, `implementation`, `implementationCodeHash`, `version`, `configuration`, and `initialize`. Those and the registry cannot be rewritten by project logic. Storage compatibility and initialization effects must be reviewed for each change. Existing readonly modules cannot silently become managed instances.

This provides upgrade control, not proof of harmless code. Approved delegatecalled code can transfer assets, call other contracts, change balances and depend on external systems. Reviews can miss defects. Financial products require their own enforceable asset and permission boundaries before admission. A general proxy is not a guarantee against loss or arbitrary economic changes.

Five focused local EVM cases cover persistent state across upgrades, registry isolation from project storage, owner/Claus initial signatures, revocation without signature revival, and atomic rollback of failed initialization. These checks do not replace independent review, integration or onchain release evidence.
