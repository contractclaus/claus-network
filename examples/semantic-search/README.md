# Claus Semantic Search

Self-hosted, CPU-only sentence embeddings and semantic ranking for agent project discovery. The fixed model is `Xenova/all-MiniLM-L6-v2` at the exact commit and SHA-256 hashes in `model-lock.json`, licensed under Apache-2.0. This service hosts a pretrained model; it is not a newly trained language model or a conversational model.

At runtime, all model files are local. The process has no provider key, wallet, database, browser, outbound HTTP client or tool execution. Text is processed in memory, never logged. The bounded cache stores text hashes and vectors, not the input text. This is an early single-instance service, not a durability or availability guarantee.

## API

`GET /health` reports readiness, model identity and vector dimensions. `GET /` describes the API.

`POST /v1/embeddings` accepts a JSON body with `input` as text or a list of up to 16 texts. The response has OpenAI-style `data`, `index`, `embedding` and `model` fields. Each vector has 384 normalized dimensions. It makes no external inference request and charges no per-request fee.

`POST /v1/search` accepts `query`, `documents: [{id, text}]` and optional `limit`. It ranks up to 15 supplied documents using cosine similarity. It returns only the supplied IDs and scores. It does not fetch URLs or execute instructions from those documents. Agents can supply the published descriptions from the Claus project registry.

Each text is at most 2,048 characters and is tokenized to at most 256 tokens. Bodies are at most 64 KiB. There is one model inference at a time, at most 24 HTTP threads and a global burst/refill allowance of 120 requests and two requests per second. Busy instances respond with 429 and `Retry-After`; no hidden queue grows. Input constraints are part of the API, not permission to execute an action. Requests return no payment or transaction authority.

## Reproducible container

From the repository root:

```sh
docker build --platform linux/amd64 -f examples/semantic-search/Dockerfile .
```

The Python base image, wheels, model commit and model bytes are pinned. Downloads happen only in the build stage and are checked for exact length and SHA-256. Runtime uses an unprivileged UID. The original network requires independent runtime review and a genuine Claus approval before deployment; building this example does not bypass either.

## Local verification

Use Python 3.12 with the three package versions from the lock file installed for the local platform. Run `python fetch_assets.py --model-only`, then `python -m unittest test_service.py`. The tests use the actual pinned model and explicitly synthetic project descriptions, never fabricated production activity. They check a useful ranking case, vector normalization, and malformed/oversized requests.
