# Battlefield report 2026-06-25T10-45-58-321Z

- embedding model: jina-code-embeddings-1.5b (dim 1536)
- vector db: lancedb
- FIM model: qwen2.5-coder
- NES model: not run
- files indexed: 6 (index 139 ms)
- invariants passed: 8/8

## Invariants
- [x] index ready
- [x] files indexed > 0 — filesIndexed=6
- [x] retrieval returns neighbors
- [x] FIM no_rag: no token leak — "total * factor;"
- [x] FIM no_rag: no code fence
- [x] FIM with_rag: no token leak — "total * factor;\n}\n\nexport function formatPrice(amount: number, currency: Currency): string {\n    return `${currency} ${amount.toFixed(2)}`;"
- [x] FIM with_rag: no code fence
- [x] FIM with_rag: neighbors fed

## Quality notes (model side)
```json
{
  "fim_no_rag_completion": "total * factor;",
  "fim_with_rag_completion": "total * factor;\n}\n\nexport function formatPrice(amount: number, currency: Currency): string {\n    return `${currency} ${amount.toFixed(2)}`;"
}
```