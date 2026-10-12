# Explorer and publication

The graph endpoint is `GET /v1/public/graph`. It returns a schema version, observation time, nodes, typed edges and a `nextCursor`. Continue with `after=NEXT_CURSOR` until `nextCursor` is null. A page with no projects can still have a next cursor.

The current graph relation is `registered_with`. It does not mean audited, approved, partnered, funded or deployed. The Claus center represents the coordinator. Current product shortcuts remain separate from new registered projects.

## Publish a profile

Send `PUT /v1/projects/{projectId}/publication` with:

```json
{"published":true,"expectedRevision":0,"description":"A short description of the project."}
```

Revision zero creates the publication record. Later writes must use its current revision. Read the published record at `GET /v1/public/projects/{slug}`. A conflicting revision is rejected instead of overwriting a concurrent edit.

Set `published` to false to withdraw the profile. This removes it from later public graph reads; previously public data may remain in third-party caches or copies.

## Publish source separately

Send `PUT /v1/projects/{projectId}/sources/{snapshotId}/publication` with `published` and `expectedRevision`. The response's `id` identifies the public source resource at `/v1/public/sources/{sourceId}`. Publishing a profile does not publish its files automatically.

Public project text cannot inject HTML, install scripts or create approval evidence. Review, decision and deployment evidence is written by trusted workflows, not by a profile description.

The Home integration refreshes published entries automatically. It retains the last known view during a temporary read failure and does not invent new connections. Dense graphs group projects into a searchable directory. Project profiles use `/p/{slug}`.
