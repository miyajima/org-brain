# Frozen benchmark artifacts — 2026-07-30

Retrieval code was frozen at commit `d9f9844` before the independent LoCoMo
holdout was opened. Dataset files and credentials are intentionally excluded.

| Artifact | Rows / scope | SHA-256 |
| --- | ---: | --- |
| `orgbrain-longmemeval-500-repeat5.jsonl` | 2,500 rows | `bc12556fe25c95c7c9ecbc24ce0f7c74c456c3965ae4625c336a1811832e0c34` |
| `orgbrain-locomo-unseen-100.jsonl` | 100 rows | `aaf22f23fdeaf5e7866b032abef75fab9088f5f8f049b0f15c321ebe62b67762` |
| `competitive-memory-all-repeat5.json` | 200 tasks × 5 for two runnable adapters | `3bda2e98a3ec82f88801f12a3cf5065125814c6ca1ad22248df0d54f941d314d` |

LongMemEval-S used dataset SHA-256
`35961662da991bec512124586e2e399a335e9e7c94272403e820eccc9946589e`.
Every repeat scored 499/500 R@5 with zero errors.

LoCoMo used dataset SHA-256
`79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4`
and selected-ID SHA-256
`6dcba8eb25b20db3052f5c5aca1cafe7b7dd52b6a964ac5edb231b203be32af5`.
The first and only run scored 92/100 R@5 with zero errors. No tuning followed.

The LongMemEval JSONL retains the runner's historical `sealed_holdout` split
label. It is not a valid sealed-holdout claim because the full dataset had
already been inspected during development.
