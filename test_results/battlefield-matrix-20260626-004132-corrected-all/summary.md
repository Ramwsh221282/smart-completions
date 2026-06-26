# Battlefield Matrix Summary

Corrected validated run: `test_results/battlefield-matrix-20260626-004132-corrected-all`.

Earlier roots from this session contain mislabeled runs caused by too-narrow process matching during server restarts. They are not used for this summary. The corrected run hard-failed unless `/v1/models` matched the expected Sweep GGUF and expected embedding GGUF before each test.

## Endpoint Validation

| Endpoint | Model | Runtime context | Embedding dim |
|---|---:|---:|---:|
| NES 7B | `sweep2-7B-Q5_K_M.gguf` | 32000 | 3584 |
| NES 1.5B | `sweep-1.5B-Q8_0.gguf` | 8192 | 1536 |
| NES 0.5B | `sweep-0.5B-Q8_0.gguf` | 8192 | 896 |
| Embedding granite | `granite-embedding-311M-multilingual-r2-Q8_0.gguf` | 8192 | 768 |
| Embedding jina-code-0.5b | `jina-code-embeddings-0.5b-Q8_0.gguf` | 32768 | 896 |
| Embedding jina-code-1.5b | `jina-code-embeddings-1.5b-Q8_0.gguf` | 32768 | 1536 |
| Embedding embeddinggemma-300m | `embeddinggemma-300M-Q8_0.gguf` | 2048 | 768 |

Small Sweep was launched with `--ctx-size 8000`; llama.cpp exposed `n_ctx=8192` in `/v1/models`. The prompt builder still used `SC_NES_CTX=8000` for the small-model tests.

## Matrix Results

| Sweep model | Prompt model id | NES ctx | Embedding | Vector DB | Invariants | NES quality |
|---|---|---:|---|---|---:|---|
| 7B | `sweep-default` | 32000 | granite | LanceDB | 22/22 | correct `displayName`, no artifacts |
| 7B | `sweep-default` | 32000 | jina-code-0.5b | LanceDB | 22/22 | correct `displayName`, no artifacts |
| 7B | `sweep-default` | 32000 | jina-code-1.5b | LanceDB | 22/22 | correct `displayName`, no artifacts |
| 7B | `sweep-default` | 32000 | embeddinggemma-300m | LanceDB | 22/22 | correct `displayName`, no artifacts |
| 1.5B | `sweep-small` | 8000 | granite | LanceDB | 22/22 | correct `displayName`, no artifacts |
| 1.5B | `sweep-small` | 8000 | jina-code-0.5b | LanceDB | 22/22 | correct `displayName`, no artifacts |
| 1.5B | `sweep-small` | 8000 | jina-code-1.5b | LanceDB | 22/22 | correct `displayName`, no artifacts |
| 1.5B | `sweep-small` | 8000 | embeddinggemma-300m | LanceDB | 22/22 | correct `displayName`, no artifacts |
| 0.5B | `sweep-small` | 8000 | granite | LanceDB | 22/22 | correct `displayName`, no artifacts |
| 0.5B | `sweep-small` | 8000 | jina-code-0.5b | LanceDB | 22/22 | correct `displayName`, no artifacts |
| 0.5B | `sweep-small` | 8000 | jina-code-1.5b | LanceDB | 22/22 | correct `displayName`, no artifacts |
| 0.5B | `sweep-small` | 8000 | embeddinggemma-300m | LanceDB | 22/22 | correct `displayName`, no artifacts |

## Quality Notes

All runs produced exactly one parsed NES edit in both no-RAG and with-RAG modes.

The generated edit consistently fixed the battlefield bug by replacing the stale `user.fullName` usage with `user.displayName` and preserving the surrounding method body:

```ts
return user ? user.displayName : 'unknown';
```

No run leaked Sweep markers, code fences, conflict markers, or legacy prompt sections. RAG mode also passed the cross-file dependency invariant: retrieval found related `types.ts`/user-service context before prompt construction.

## Artifacts

Per-run reports, prompts, raw responses, parsed NES results, retrieval results, endpoint snapshots, and logs are under:

`test_results/battlefield-matrix-20260626-004132-corrected-all`
