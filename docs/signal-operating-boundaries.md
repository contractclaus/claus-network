# Signal operating boundaries

The independent review of runtime `e2f7c02664b111159e4e4b63d8d5a2146558e144` completed as IMD job `817fa54d-443f-4f62-8557-9eade7ffa612`. It retained two low-severity findings and three informational findings. The boundaries below remain in this source version. Release availability is listed separately in [release status](release-status.md).

| Condition | Behavior and operating rule |
| --- | --- |
| An owner or operation actor attaches a different transaction hash before the hosted publisher reports its real hash | The reference lane can remain blocked even after its transaction is final. Give one process ownership of submission for a hosted operation; do not attach another hash. If a conflict happens, stop that lane and retain both records for operator reconciliation. There is no automatic conflict repair. Do not erase the original hash or create a replacement payment. |
| A signed grant is revoked directly onchain before registration, but that revocation is not final yet | Registration preparation can still succeed and consume registration gas and the owner's nonce. The grant remains revoked and cannot publish. Use the API revocation route as well as its owner-signed onchain call; otherwise wait for finalized revocation before preparing further work. |
| A write is confirmed in both the engine and API, then a later read fails after the run deadline | The job can report failure although its write succeeded. Read the original operation and finalized record before drawing conclusions from job health or attempting new work. |
| Host time and RPC chain time disagree near an observation boundary | Preparation can reject the observation as expired. Use a finalized observation and leave a substantial validity margin. Network Pulse uses two RPCs, finalized observations and a two-hour validity window. |
| A transaction is replaced outside the isolated publisher engine while the API is unreachable | The engine can record cancellation and release the lane without attaching the original hash to the API operation. Keep the engine's original hash and exact finalized replacement evidence. The supported hosted process has exclusive use of its signer and does not send replacements outside that engine. |

These are not permission to change transaction history, bypass revocation or reset a budget. Unknown broadcasts continue to reserve their original funds. The finite hosted reference uses separate role keys and a single submitting process; arbitrary hot configuration or signer rotation while work is unresolved is unsupported.
