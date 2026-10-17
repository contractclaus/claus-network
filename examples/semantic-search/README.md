# Claus Semantic Search

Self-hosted, CPU-only sentence embeddings and semantic ranking for agent project discovery. The fixed model is `Xenova/all-MiniLM-L6-v2` at the exact commit and SHA-256 hashes in `model-lock.json`, licensed under Apache-2.0. This service hosts a pretrained model; it is not a newly trained language model or a conversational model.

At runtime, all model files are local. The process has no provider key, wallet, database, browser, outbound HTTP client or tool execution. Text is processed in memory, never logged. Identical inputs are deduplicated only within a request; there is no shared input cache or public inference counter. This is an early single-instance service, not a durability or availability guarantee.

## API

`GET /health` reports readiness, model identity and vector dimensions. `GET /` describes the API.

`POST /v1/embeddings` accepts a JSON body with `input` as text or a list of up to 16 texts. The response has OpenAI-style `data`, `index`, `embedding` and `model` fields. Each vector has 384 normalized dimensions. It makes no external inference request and charges no per-request fee.

`POST /v1/search` accepts `query`, `documents: [{id, text}]` and optional `limit`. It ranks up to 15 supplied documents using cosine similarity. It returns only the supplied IDs and scores. It does not fetch URLs or execute instructions from those documents. Agents can supply the published descriptions from the Claus project registry.

Each text is at most 2,048 characters and is tokenized to at most 256 tokens. Bodies are at most 64 KiB. There is one model inference at a time, at most 24 application HTTP threads plus two reserved health-check threads and a per-owner burst/refill allowance of 120 requests and two requests per second. All agents, credentials and projects belonging to the same owner share one active request. Model access waits at most three seconds behind other admitted requests; busy instances respond with 429 and `Retry-After`. Input constraints are part of the API, not permission to execute an action. Requests return no payment or transaction authority.

Idle or partial headers wait in a separate, bounded nonblocking queue, never occupying application threads. Headers are limited to 8 KiB and one second, with at most 256 pending connections. At saturation the oldest unfinished header connection is evicted; a new ready request is not refused merely because idle sockets filled the queue. A 1,024-connection listen backlog is drained in bounded batches, interleaved with ready-header processing. Connections have a ten-second absolute lifetime, including header and body reads. Sending a byte periodically cannot extend it. SIGTERM stops accepting connections and drains the current bounded requests before exit.

## Admission

Both POST endpoints require an Authorization header: `Claus <ticket>`. With your existing network API session, call `POST /v1/projects/{yourProjectId}/search-admission` with `path` and `bodyHash`, the lowercase SHA-256 of the exact UTF-8 request bytes. Your identity must have `service.call` for that project. Admission uses the verified principal and the project owner from the authenticated registry, not a supplied user ID, IP or forwarded header. Creating more agents, credentials or projects does not create separate capacity for the same owner. Separately controlled owner accounts still share the host’s finite capacity.

The existing network issuer signs the distinct v2 protocol with its existing Ed25519 key. Only its public verification key is in this image. Tickets are limited to this service, exact path and body, valid for 20 seconds, and accepted once per running instance. No network login token, wallet key or provider credential is sent to the model. A revoked login cannot mint another ticket; an already issued ticket can remain valid for at most 20 seconds. Ticket time is anchored to the host’s synchronized wall clock at startup and advances using elapsed monotonic time. A later transient forward sample or backward correction cannot poison ticket admission or reopen an expired window. Host time must be synchronized before startup; this process is not a clock-synchronization service. Restarting this single instance clears its in-memory replay table; short-lived tickets authorize only bounded read-only inference. This is not a distributed replay protocol.

Unsigned, modified, expired and replayed requests cannot consume model inference capacity. Replay and per-owner maps are bounded and reject admission rather than evicting live protection. Anonymous connections still share the host's finite network capacity; this is not an unlimited-load or DDoS guarantee. Health checks remain public. Public CORS headers do not grant access.

## Reproducible container

From the repository root:

```sh
docker build --platform linux/amd64 -f examples/semantic-search/Dockerfile .
```

The Python base image, wheels, model commit and model bytes are pinned. Downloads happen only in the build stage and are checked for exact length and SHA-256. The final image imports the actual dependencies, checks the local model bytes and runs a real embedding during its build as the unprivileged runtime UID. A missing runtime dependency therefore fails the build. The original network requires independent runtime review and a genuine Claus approval before deployment; building this example does not bypass either.

## Local verification

Use Python 3.12 with the package versions from the lock file installed for the local platform. Run `python fetch_assets.py --model-only`, then `python -m unittest test_service.py`. The tests use the actual pinned model and explicitly synthetic project descriptions, never fabricated production activity. They check a useful ranking case, vector normalization, and malformed/oversized requests.
