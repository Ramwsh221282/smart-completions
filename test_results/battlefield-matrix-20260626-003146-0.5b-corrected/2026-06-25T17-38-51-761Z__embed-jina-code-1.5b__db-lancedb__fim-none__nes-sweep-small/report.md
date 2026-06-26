# Battlefield report 2026-06-25T17-38-51-761Z

- embedding model: jina-code-1.5b (dim 1536)
- vector db: lancedb
- FIM model: not run
- NES model: sweep-small
- files indexed: 6 (index 740 ms)
- invariants passed: 22/22

## Invariants
- [x] index ready
- [x] files indexed > 0 — filesIndexed=6
- [x] retrieval returns neighbors
- [x] NES no_rag: prompt not overflow
- [x] NES no_rag: original/current/updated triad is last — original/user-service.ts:1:20 | current/user-service.ts:1:20 | updated/user-service.ts:1:20
- [x] NES no_rag: no legacy sweep sections
- [x] NES no_rag: outline pseudo-file present
- [x] NES no_rag: related file block present
- [x] NES no_rag: output pseudo-file present and sanitized
- [x] NES no_rag: zone B sits before the triad
- [x] NES no_rag: edit ranges inside window
- [x] NES no_rag: no marker leak
- [x] NES with_rag: diff-query found cross-file dependency — types.ts,user-service.ts,user-repository.ts,docs/guide.md,types.ts
- [x] NES with_rag: prompt not overflow
- [x] NES with_rag: original/current/updated triad is last — original/user-service.ts:1:20 | current/user-service.ts:1:20 | updated/user-service.ts:1:20
- [x] NES with_rag: no legacy sweep sections
- [x] NES with_rag: outline pseudo-file present
- [x] NES with_rag: related file block present
- [x] NES with_rag: output pseudo-file present and sanitized
- [x] NES with_rag: zone B sits before the triad
- [x] NES with_rag: edit ranges inside window
- [x] NES with_rag: no marker leak

## Quality notes (model side)
```json
{
  "nes_no_rag_edit": "        return user ? user.displayName : 'unknown';\n    }\n\n    listEmails(): string[] {\n        return this.repository.all().map(user => user.email);\n    }\n}",
  "nes_no_rag_edits_count": 1,
  "nes_with_rag_edit": "        return user ? user.displayName : 'unknown';\n    }\n\n    listEmails(): string[] {\n        return this.repository.all().map(user => user.email);\n    }\n}",
  "nes_with_rag_edits_count": 1
}
```