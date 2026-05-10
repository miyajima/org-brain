# Global Codex Harness Bridge

Use the shared harness at:
- `/Users/miya/.agents/AGENTS.md`
- `/Users/miya/.agents/harness/rules/00-core.md`
- `/Users/miya/.agents/harness/rules/10-execution.md`
- `/Users/miya/.agents/harness/rules/12-ui-design.md`
- `/Users/miya/.agents/harness/rules/15-model-routing.md`
- `/Users/miya/.agents/harness/rules/20-quality-gates.md`
- `/Users/miya/.agents/harness/rules/30-prompt-injection.md`
- `/Users/miya/.agents/harness/rules/40-learning-loop.md`
- `/Users/miya/.agents/harness/skills/INDEX.md`

Also read:
- `/Users/miya/.codex/RTK.md`

If instructions conflict, use this priority:
1. Direct user request
2. Safety or platform policy
3. Tool adapter file in this workspace
4. Shared harness rules
5. Project notes below

Dispatcher contract:
- `claude -p` は使わない。
- 軽量実装は `inline_current_agent` を既定とする。
- 非自明な実装は `/Users/miya/.agents/harness/bin/run-quality-workflow.sh` で `codex_cli_roles` として役割分担する。
- Codex App の組み込み sub-agent は `codex_app_subagents` と呼び、明示的に delegate できる並列/補助作業に限る。
- 最終報告の route 表示は、別エージェントや外部 runtime に委譲した場合だけ明記する。

## Project Notes

- Context Engine と harness preflight の変更は、共有ハーネス側の bootstrap 影響も確認してください。
- `ORGBRAIN_API_URL` が canonical env 名です。`ORGBRAIN_API_BASE` は互換 alias として扱ってください。
- Cloudflare deploy を頼まれた場合は、ローカル確認だけでなく live API smoke まで実行してください。
