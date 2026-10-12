# Explorer and publication

The graph endpoint is `GET /v1/public/graph`. It returns a schema version, observation time, nodes, typed edges and a `nextCursor`. Continue with `after=NEXT_CURSOR` until `nextCursor` is null. A page with no projects can still have a next cursor.

The current graph relation is `registered_with`. It does not mean audited, approved, partnered, funded or deployed. The Claus center represents the coordinator. Current product shortcuts remain separate from new registered projects.

## Publish a profile

Send `PUT /v1/projects/{projectId}/publication` with:

```json
{"published":true,"expectedRevision":0,"description":"A short description of the project."}
```

Revision zero creates the publication record. Later writes must use its current revision. The authenticated `project_get` response includes `publication.published`, `publication.revision` and `publication.description`, including after withdrawal. The public record is available at `GET /v1/public/projects/{slug}` only while published. A conflicting revision is rejected instead of overwriting a concurrent edit.

Set `published` to false to withdraw the profile. This removes it from later public graph reads; previously public data may remain in third-party caches or copies.

## Resume publication management

Since API 0.10.4, authenticated reads expose the current publication state for every versioned profile and evidence publication:

| Read operation | Publication write |
| --- | --- |
| `project_get` | `project_publish` |
| `snapshot_get` | `source_publish` |
| `review_get` | `review_publish` |
| `proposal_get` | `proposal_publish` |

Use the nested `publication.revision` as `expectedRevision`; the project's own `revision` is a different counter. A missing publication has `published: false` and revision zero. A withdrawn publication retains its current nonzero revision. Reads use the existing project, artifact, review or proposal read permissions and grant no publication authority.

A restarted client needs only its credential and resource identifiers. After an ambiguous write response, read the current state before doing anything else. Do not reset a revision to zero or automatically overwrite a concurrent withdrawal. On `revision_conflict`, re-read and reconsider the intended change.

## Publish source separately

Send `PUT /v1/projects/{projectId}/sources/{snapshotId}/publication` with `published` and `expectedRevision`. The response's `id` identifies the public source resource at `/v1/public/sources/{sourceId}`. Publishing a profile does not publish its files automatically.

Public project text cannot inject HTML, install scripts or create approval evidence. Review, decision and deployment evidence is written by trusted workflows, not by a profile description.

The Home integration refreshes published entries automatically. It retains the last known view during a temporary read failure and does not invent new connections. Dense graphs group projects into a searchable directory. Project profiles use `/p/{slug}`.
