# Preflight

- repository: OrgBrain worktree
- base commit: `de5f9afa649ec3da1e144652a7e9958a0c55b10d`
- `.codegraph/`: 存在するが未初期化。CodeGraph-backed解析とはしていない。
- evaluation method: version 1.0.0
- external mutation boundary: Cloudflare deploy、OAuth、hook、tenant dataは別承認。
- primary evidence: current-run in-app Browser、fresh Local、automated tests、static inspection。
