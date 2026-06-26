# Battlefield report 2026-06-25T10-41-31-333Z

- embedding model: granite-embedding-311M (dim 768)
- vector db: lancedb
- FIM model: not run
- NES model: sweep-small
- files indexed: 6 (index 93 ms)
- invariants passed: 10/10

## Invariants
- [x] index ready
- [x] files indexed > 0 — filesIndexed=6
- [x] retrieval returns neighbors
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
  "nes_no_rag_edit": "        return user ? user.displayName : 'unknown';\n    }\n\n    listEmails(): string[] {\n        return this.repository.all().map(user => user.email);\n    }\n}\n\n\nInline diagnostics near the cursor:\nerror: Property 'displayName' does not exist on type 'User'.",
  "nes_no_rag_edits_count": 1,
  "nes_with_rag_edit": "        return user ? user.displayName : 'unknown';\n    }\n\n    listEmails(): string[] {\n        return this.repository.all().map(user => user.email);\n    }\n}\n\n\nInline diagnostics near the cursor:\nerror: Property 'displayName' does not exist on type 'User'.",
  "nes_with_rag_edits_count": 1
}
```