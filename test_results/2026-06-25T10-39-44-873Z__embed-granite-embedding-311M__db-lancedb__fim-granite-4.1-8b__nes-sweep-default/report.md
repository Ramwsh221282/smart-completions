# Battlefield report 2026-06-25T10-39-44-873Z

- embedding model: granite-embedding-311M (dim 768)
- vector db: lancedb
- FIM model: granite-4.1-8b
- NES model: sweep-default
- files indexed: 6 (index 176 ms)
- invariants passed: 15/15

## Invariants
- [x] index ready
- [x] files indexed > 0 — filesIndexed=6
- [x] retrieval returns neighbors
- [x] FIM no_rag: no token leak — "\n        total * factor;\n}\n\nexport function formatCurrency(amount: number, currency: Currency): string {\n    switch (currency) {\n        case Currency.EUR:\n            return `€ ${amount.toFixed(2)}`;\n        case Currency.USD:\n            return `$ ${amount.toFixed(2)}`;\n        case Currency.GBP:\n            return `£ ${amount.toFixed(2)}`;\n        default:\n            return `? ${amount.toFixed(2)}`;\n    }"
- [x] FIM no_rag: no code fence
- [x] FIM with_rag: no token leak — "\n\ntotal * factor;\n}\n\nexport function formatPrice(amount: number, currency: Currency): string {\n    return `${currency} ${amount.toFixed(2)}`;"
- [x] FIM with_rag: no code fence
- [x] FIM with_rag: neighbors fed
- [x] NES no_rag: prompt not overflow
- [x] NES no_rag: edit ranges inside window
- [x] NES no_rag: no marker leak
- [x] NES with_rag: diff-query found cross-file dependency — types.ts,types.ts,user-service.ts,user-repository.ts,user-service.ts
- [x] NES with_rag: prompt not overflow
- [x] NES with_rag: edit ranges inside window
- [x] NES with_rag: no marker leak

## Quality notes (model side)
```json
{
  "fim_no_rag_completion": "\n        total * factor;\n}\n\nexport function formatCurrency(amount: number, currency: Currency): string {\n    switch (currency) {\n        case Currency.EUR:\n            return `€ ${amount.toFixed(2)}`;\n        case Currency.USD:\n            return `$ ${amount.toFixed(2)}`;\n        case Currency.GBP:\n            return `£ ${amount.toFixed(2)}`;\n        default:\n            return `? ${amount.toFixed(2)}`;\n    }",
  "fim_with_rag_completion": "\n\ntotal * factor;\n}\n\nexport function formatPrice(amount: number, currency: Currency): string {\n    return `${currency} ${amount.toFixed(2)}`;",
  "nes_no_rag_edit": "        return user ? user.displayName : 'unknown';\n    }\n\n    listEmails(): string[] {\n        return this.repository.all().map(user => user.email);\n    }\n}",
  "nes_no_rag_edits_count": 1,
  "nes_with_rag_edit": "        return user ? user.displayName : 'unknown';\n    }\n\n    listEmails(): string[] {\n        return this.repository.all().map(user => user.email);\n    }\n}",
  "nes_with_rag_edits_count": 1
}
```