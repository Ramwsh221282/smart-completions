# Battlefield report 2026-06-27T09-46-09-409Z

- embedding model: granite (dim 896)
- vector db: lancedb
- FIM model: qwen2.5-coder
- NES model: sweep-small
- files indexed: 6 (index 2005 ms)
- invariants passed: 25/25

## Invariants
- [x] index ready
- [x] files indexed > 0 — filesIndexed=6
- [x] retrieval returns neighbors
- [x] FIM no_rag: no token leak — "total * factor;"
- [x] FIM no_rag: no code fence
- [x] FIM with_rag: no token leak — "total * factor;"
- [x] FIM with_rag: no code fence
- [x] FIM with_rag: neighbors fed
- [x] NES no_rag: prompt not overflow
- [x] NES no_rag: original/current/updated triad is last — original/user-service.ts:1:20 | current/user-service.ts:1:20 | updated/user-service.ts:1:20
- [x] NES no_rag: no legacy sweep sections
- [x] NES no_rag: outline pseudo-file present
- [x] NES no_rag: related file block present
- [x] NES no_rag: zone B sits before the triad
- [x] NES no_rag: edit ranges inside window
- [x] NES no_rag: no marker leak
- [x] NES with_rag: diff-query found cross-file dependency — types.ts,user-service.ts,docs/guide.md,order-service.ts,user-repository.ts
- [x] NES with_rag: prompt not overflow
- [x] NES with_rag: original/current/updated triad is last — original/user-service.ts:1:20 | current/user-service.ts:1:20 | updated/user-service.ts:1:20
- [x] NES with_rag: no legacy sweep sections
- [x] NES with_rag: outline pseudo-file present
- [x] NES with_rag: related file block present
- [x] NES with_rag: zone B sits before the triad
- [x] NES with_rag: edit ranges inside window
- [x] NES with_rag: no marker leak

## Quality notes (model side)
```json
{
  "fim_no_rag_completion": "total * factor;",
  "fim_with_rag_completion": "total * factor;",
  "nes_no_rag_edit": "        return user ? user.displayName : 'unknown';\n    }\n\n    listEmails(): string[] {\n        return this.repository.all().map(user => user.email);\n    }\n}",
  "nes_no_rag_edits_count": 1,
  "nes_with_rag_edit": "        return user ? user.displayName : 'unknown';\n    }\n\n    listEmails(): string[] {\n        return this.repository.all().map(user => user.email);\n    }\n}",
  "nes_with_rag_edits_count": 1
}
```