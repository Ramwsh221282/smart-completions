# Battlefield report 2026-06-25T10-46-28-792Z

- embedding model: jina-code-embeddings-1.5b (dim 1536)
- vector db: lancedb
- FIM model: deepseek-coder
- NES model: not run
- files indexed: 6 (index 140 ms)
- invariants passed: 8/8

## Invariants
- [x] index ready
- [x] files indexed > 0 — filesIndexed=6
- [x] retrieval returns neighbors
- [x] FIM no_rag: no token leak — "Math.round(total  * factor);\n}\n\nexport function convertCurrencyToUSD(price: number, currency: Currency): number  {\n    switch (currency) {\n        case 'EUR':\n            return Math.round(price  * 0.85);\n        case 'GBP':\n            return Math.round(price  * 0.76);\n        case 'JPY':\n            return Math.round(price  * 110.87);\n        case 'KRW':\n            return Math.round(price  * 1214.0);\n        case 'VND':\n            return Math.round(price  * 2332"
- [x] FIM no_rag: no code fence
- [x] FIM with_rag: no token leak — "Math.round(total  * factor);\n}\n\nexport function convertCurrencyToUSD(price: number, currency: Currency): number  {\n    switch (currency) {\n        case 'EUR':\n            return Math.round(price  * 0.85);\n        case 'GBP':\n            return Math.round(price  * 0.76);\n        case 'JPY':\n            return Math.round(price  * 110.87);\n        case 'KRW':\n            return Math.round(price  * 1214.0);\n        case 'VND':\n            return Math.round(price  * 2332"
- [x] FIM with_rag: no code fence
- [x] FIM with_rag: neighbors fed

## Quality notes (model side)
```json
{
  "fim_no_rag_completion": "Math.round(total  * factor);\n}\n\nexport function convertCurrencyToUSD(price: number, currency: Currency): number  {\n    switch (currency) {\n        case 'EUR':\n            return Math.round(price  * 0.85);\n        case 'GBP':\n            return Math.round(price  * 0.76);\n        case 'JPY':\n            return Math.round(price  * 110.87);\n        case 'KRW':\n            return Math.round(price  * 1214.0);\n        case 'VND':\n            return Math.round(price  * 2332",
  "fim_with_rag_completion": "Math.round(total  * factor);\n}\n\nexport function convertCurrencyToUSD(price: number, currency: Currency): number  {\n    switch (currency) {\n        case 'EUR':\n            return Math.round(price  * 0.85);\n        case 'GBP':\n            return Math.round(price  * 0.76);\n        case 'JPY':\n            return Math.round(price  * 110.87);\n        case 'KRW':\n            return Math.round(price  * 1214.0);\n        case 'VND':\n            return Math.round(price  * 2332"
}
```