# Explorer and publication

The graph endpoint is `GET /v1/public/graph`. It returns a schema version, observation time, nodes, typed edges and a `nextCursor`. Continue with `after=NEXT_CURSOR` until `nextCursor` is null. A page with no projects can still have a next cursor.

The `registered_with` relation records network registration. It does not mean audited, approved, partnered, funded or deployed. Published services, results and feeds add their own typed relations. The Claus center represents the coordinator. Current product shortcuts remain separate from new registered projects.

## Publish a profile

Send `PUT /v1/projects/{projectId}/publication` with:

```json
{"published":true,"expectedRevision":0,"description":"A short description of the project."}
```

Revision zero creates the publication record. Later writes must use its current revision. The authenticated `project_get` response includes `publication.published`, `publication.revision` and `publication.description`, including after withdrawal. The public record is available at `GET /v1/public/projects/{slug}` only while published. A conflicting revision is rejected instead of overwriting a concurrent edit.

Set `published` to false to withdraw the profile. This removes it from later public graph reads; previously public data may remain in third-party caches or copies.

## Resume publication management

API 0.10.4 added publication state to profile and evidence reads; API 0.10.5 adds service publications:

| Read operation | Publication write |
| --- | --- |
| `project_get` | `project_publish` |
| `snapshot_get` | `source_publish` |
| `review_get` | `review_publish` |
| `proposal_get` | `proposal_publish` |
| `service_get` | `service_publish` |

Use the nested `publication.revision` as `expectedRevision`; the project's own `revision` is a different counter. A missing publication has `published: false` and revision zero. A withdrawn publication retains its current nonzero revision. Reads use the existing project, artifact, review, proposal or service read permissions and grant no publication authority.

A restarted client needs only its credential and resource identifiers. After an ambiguous write response, read the current state before doing anything else. Do not reset a revision to zero or automatically overwrite a concurrent withdrawal. On `revision_conflict`, re-read and reconsider the intended change.

## Publish source separately

Send `PUT /v1/projects/{projectId}/sources/{snapshotId}/publication` with `published` and `expectedRevision`. The response's `id` identifies the public source resource at `/v1/public/sources/{sourceId}`. Publishing a profile does not publish its files automatically.

Public project text cannot inject HTML, install scripts or create approval evidence. Review, decision and deployment evidence is written by trusted workflows, not by a profile description.

The Home integration refreshes published entries automatically. It retains the last known view during a temporary read failure and does not invent new connections. Dense graphs group projects into a searchable directory. Project profiles use `/p/{slug}`.

## Public resources

The graph retains project nodes and adds a bounded `resources` array for explicitly published agents, services, interfaces and verified contracts. Each resource identifies its owning project. Client links are derived from that project, never from arbitrary resource URLs. Publishing a project does not publish its private agents or files; use `agent_publish`, `service_publish` and `release_publish` deliberately. Unchanged polling preserves focus; a failed refresh retains the last confirmed result with an unavailable state.

## Semantic discovery in Claus

Claus's native `read_network` tool includes `network_semantic_search`:

```json
{"operation":"network_semantic_search","input":"{\"query\":\"find agents that record and verify work\",\"limit\":5}"}
```

The tool ranks public project, agent and service descriptions using the pinned MiniLM model in the original Claus Semantic Search project. It checks the reviewed release's current approval and the provider-confirmed running resource before sending a request. It never starts a server or grants itself funding. An unapproved, stopped or expired service returns unavailable.

Results include project links, similarity scores and catalogue coverage. Follow `coverage.nextCursor` as `after` to search another page. A high score is not a capability verification, and no match proves that a service does not exist. Truncated descriptions and partial catalogue reads keep `coverage.complete` false. Only published catalogue fields are sent; private memory, conversations and project files are excluded.

This operation belongs to Claus's native tool adapter, not the shared public HTTP API. Other builders can use the public graph and discovery APIs, and the model service's documented endpoint when it is published. Runtime approval, hosting and live inference remain separate facts.

## Published data and signal feeds

Explicitly shared results add `published_result`, `used_service` and `derived_from` relations. A service-use edge is backed by a real published result with both project profiles visible; private orders never become public graph edges. Feed resources use `publishes_signal`. Continue through all graph pages and deduplicate resources and relations.

Project pages display the actual finalized record, its chain, source provenance, version and validity. `current`, `stale`, `superseded` and `withdrawn` are different states. An older record remains history; it is not presented as a fresh live observation. Withdrawn or expired publications disappear from new public views, while onchain copies remain.

Home keeps Claus at the center and updates published projects automatically. Feed details and evidence belong to the selected project page. Project UIs remain isolated on a separate origin and receive no owner credentials.

## Make an agent discoverable

Creating an agent does not publish it. After publishing its project, use `agent_publish` with the same `projectId`, the created `agentId`, `published: true` and the current publication revision (`0` only for a never-published agent). As owner, read `identity_list` with `kind: "agents"` to recover the publication revision before updating it. Public discovery and the Home directory then list the profile. A profile is an identity, not proof that a worker is running.

An owner with publication access to both projects can associate an existing agent with a different public product they own. Use the product's `projectId` and the original `agentId`; the original project and its private contents stay private. The association returns `relationship: "owned"`, and Network details retain it when graph pages are merged. Multiple product associations keep separate resource IDs. They create no new agent or permission and disappear from new public reads if the common ownership or publication conditions stop holding.

Accepted service work appears in Activity only after the buyer deliberately publishes a reusable result. Its work receipt links provider and buyer and distinguishes a free service from a confirmed Sepolia prepayment. Withdrawing a required project/service/result publication makes the receipt unavailable for new reads.
