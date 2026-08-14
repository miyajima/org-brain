# Source notes

This file contains only reviewed aggregate provenance. It does not contain memory text, raw transcripts, credentials, PII, or model reasoning.

- Tenant audit execution: `2026-08-13T20:00:02.513Z`
- Tenant audit output SHA-256: `cce1e0203ac2ef22a971499e13ec844b3fad853b8689606d8a3eeb32eea136dd`
- Private corpus manifest generation: `2026-08-13T03:45:17.691Z`
- Private corpus manifest SHA-256: `9c7ee28aa7e999ffc38607f6bc01c7e961baae4dba875cd1d5c85c452c404497`
- Corpus aggregate: 39 session entries, 260 final answers, 22 projects, 27 unique session hashes, 3 cross-split hash violations, 39 pending annotations.
- Privacy flags: `raw_transcript_copied=false`, `reasoning_read=false`, `text_persisted=false`.
- The v2 certifier interprets unlabeled schema-v1 corpus entries as zero v2 certification cases.

The tenant audit source query is paged by `id` in batches of 250 and transformed by `scripts/memory-quality-audit.mjs`. The org-brain aggregate query reads counts only.
