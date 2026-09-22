#!/usr/bin/env python3
"""Matched, sequential Codex Pro research tasks with isolated OrgBrain context.

The experiment measures complete CLI tasks, not subscription-bill savings.
No external API keys, production memories, hooks, or persistent config are used.
"""
import argparse
import hashlib
import itertools
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import tempfile
import time
import tomllib

ROOT = Path(__file__).resolve().parents[1]
SOURCE_DIRS = ("packages/orgbrain-cli/src", "packages/shared/src", "scripts", "docs", "migrations")


def digest(value):
    if isinstance(value, str):
        value = value.encode()
    return hashlib.sha256(value).hexdigest()


def save(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def lesson(content, rationale, rule, path):
    return dict(content=content, summary=content, rationale=rationale, reuse_rule=rule,
                source_references=[dict(type="file", ref=path)])


TASKS = [
    dict(id="workspace", title="Git worktreeでのOrgBrain設定解決",
         query="Git worktree",
         question="Git worktreeでOrgBrainが別プロジェクト扱いになる問題を調査してください。現在のCLIが作業ディレクトリからworkspace設定を解決する優先順位、同名の別リポジトリを誤認しない仕組み、Git照会が失敗した場合の動作を、現在のソースで確認して説明してください。修正は不要です。",
         criteria=["Exact cwd entry has priority", "Repository root then common Git repository mapping is used",
                   "Same basename alone is not sufficient", "Failed Git lookup returns unmapped without guessing"],
         lessons=[
             lesson("For workspace mapping in a Git worktree, inspect resolveWorkspaceMapping in packages/orgbrain-cli/src/lib/workspace-config.mjs.",
                    "The worktree path may differ from the configured canonical repository.",
                    "Use this location for CLI workspace resolution; verify current precedence in the function.",
                    "packages/orgbrain-cli/src/lib/workspace-config.mjs"),
             lesson("Workspace mapping for a Git worktree uses the common Git repository rather than matching a directory basename.",
                    "Different repositories can have the same final directory name.",
                    "Confirm the git-common-repository branch and exact workspace entries before diagnosing an unmapped worktree.",
                    "packages/orgbrain-cli/src/lib/workspace-config.mjs")]),
    dict(id="usage", title="検索返却と検証済み利用履歴の違い",
         query="usage history",
         question="OrgBrainで検索結果が返り、usage itemをusedにしても、usage historyの検証済み利用件数が増えない状況を調査してください。検索返却・手動のused・行動での利用・効果評価を区別し、実利用記録に必要な証拠、証拠不足時の扱い、次に確認すべき実装をソースに基づいて説明してください。修正は不要です。",
         criteria=["Retrieval/manual used are not verified action use", "Collector requires retrieval, action, outcome and observation evidence",
                   "Scope/version/hash evidence is validated", "Unknown or incomplete proof cannot imply a positive outcome"],
         lessons=[
             lesson("For memory usage history, scripts/memory-use-history.test.mjs and packages/orgbrain-cli/src/lib/memory-use-collector.mjs distinguish retrieved items from verified action use.",
                    "Search return and a manual used-state update do not prove that a memory contributed to an action.",
                    "When a usage count appears empty, inspect the collector and its paired execution evidence before concluding that no search happened.",
                    "scripts/memory-use-history.test.mjs"),
             lesson("Verified memory usage history evaluates scoped action and outcome proofs; local-memory-use.mjs implements the local service.",
                    "A forged verified flag or a positive statement without valid evidence must not become measured benefit.",
                    "Check source version, task scope, content hashes and unknown outcomes when diagnosing usage-history gaps.",
                    "packages/orgbrain-cli/src/lib/local-memory-use.mjs")]),
    dict(id="capture", title="eager自動保存とexecの実行証拠",
         query="eager capture",
         question="eager設定で、functions.execの内部からOrgBrain検索と確認コマンドを呼んだ後も自動保存されない状況を調査してください。現在の実装はこの形式から検索失敗や実行成功を証明できるか、専用の診断理由、保存を認めるために必要な証拠、競合や予算不足の検索結果の扱いをソースで説明してください。修正は不要です。",
         criteria=["Opaque exec wrappers are counted, not treated as verified nested calls",
                   "eager-native-tool-evidence-unavailable is distinguished from ordinary no-miss",
                   "A genuine miss plus verified subsequent work and a safe durable candidate are needed",
                   "Conflict/budget/source shortage clears a pending capture gap"],
         lessons=[
             lesson("Eager capture with opaque tool wrappers is diagnosed in coverage-review-signals.mjs and hook-memory-bridge.mjs.",
                    "An outer exec call does not establish the identity and successful result of every nested tool.",
                    "When the transcript exposes only the wrapper, check opaque_tool_wrappers and the eager reason code; do not fabricate a successful action.",
                    "packages/orgbrain-cli/src/lib/coverage-review-signals.mjs"),
             lesson("Eager capture requires a retrieval miss, verified subsequent action and a safe durable candidate; blocked retrieval is not a learning gap.",
                    "Conflicts and token budget exhaustion may withhold existing knowledge rather than prove missing knowledge.",
                    "Inspect the latest retrieval state and Stop skip reason before treating abstention as a new memory opportunity.",
                    "packages/orgbrain-cli/src/hook-memory-bridge.mjs")])
]

SCHEMA = {"type": "object", "properties": {
    "answer": {"type": "string"}, "citations": {"type": "array", "items": {
        "type": "object", "properties": {"path": {"type": "string"}, "quote": {"type": "string"}},
        "required": ["path", "quote"], "additionalProperties": False}}},
    "required": ["answer", "citations"], "additionalProperties": False}


def prepare(output, baseline):
    if output.exists():
        raise RuntimeError("experiment_output_already_exists")
    output.mkdir(parents=True)
    config = tomllib.loads((Path.home() / ".codex/config.toml").read_text())
    runtime = Path(tempfile.mkdtemp(prefix="orgbrain-live-efficiency-"))
    snapshot = runtime / "source"
    snapshot.mkdir()
    sources = {}
    for directory in SOURCE_DIRS:
        for source in (ROOT / directory).rglob("*"):
            if not source.is_file() or source.suffix not in (".mjs", ".js", ".ts", ".md", ".sql"):
                continue
            relative = source.relative_to(ROOT)
            destination = snapshot / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, destination)
            sources[str(relative)] = digest(source.read_bytes())
    shutil.copyfile(ROOT / "package.json", snapshot / "package.json")
    sources["package.json"] = digest((ROOT / "package.json").read_bytes())
    save(output / "answer.schema.json", SCHEMA)
    manifest = dict(schema="orgbrain-live-efficiency/v1", created_at=time.time(),
        baseline_root=str(baseline.resolve()), candidate_root=str(ROOT), runtime_root=str(runtime),
        snapshot=str(snapshot), snapshot_hash=digest(json.dumps(sources, sort_keys=True)), source_hashes=sources,
        model=config["model"], effort=config["model_reasoning_effort"], service_tier=config.get("service_tier"),
        repetitions=2, tasks=TASKS, variants=["none", "full", "compact"],
        scope="Live read-only repository maintenance tasks; curated source-verified memories; isolated CLI configuration",
        billing_basis="ChatGPT Pro subscription; task-level actual USD unavailable",
        controls=["Same model, effort, source, question, acceptance criteria", "Sequential runs with balanced order",
                  "No persistent user config, MCP plugins, automatic hooks or Codex memory injection",
                  "No live OrgBrain memory reads/writes and no external paid tools",
                  "Pre-existing curated memory condition; automatic extraction cost is outside scope",
                  "Failures retained; no automatic retries; no provider price estimates"],
        stopping_rules=["Stop on CLI infrastructure failure or 240 second task timeout",
                        "Run exactly three tasks times three variants times two repetitions",
                        "Do not tune implementation or tasks after observing a result"],
        subscription_bill_savings=None)
    save(output / "manifest.json", manifest)
    print(json.dumps({"prepared": str(output / "manifest.json"), "model": manifest["model"],
                      "effort": manifest["effort"], "runs": 18, "snapshot_files": len(sources)}), flush=True)


def evidence_check(answer, workspace):
    failures = []
    if not isinstance(answer, dict) or not isinstance(answer.get("answer"), str):
        return ["answer_missing"]
    citations = answer.get("citations", [])
    if not citations:
        return ["citations_missing"]
    for citation in citations:
        path = (workspace / citation.get("path", "")).resolve()
        if not path.is_relative_to(workspace.resolve()) or not path.is_file():
            failures.append("citation_outside_snapshot")
            continue
        quote = citation.get("quote", "")
        if len(quote) < 16 or " ".join(quote.split()) not in " ".join(path.read_text().split()):
            failures.append("citation_quote_not_in_source")
    return failures


def run(output, resume=False):
    manifest = json.loads((output / "manifest.json").read_text())
    if (output / "attempts.json").exists() and not resume:
        raise RuntimeError("experiment_already_attempted")
    runtime = Path(manifest["runtime_root"])
    attempts = json.loads((output / "attempts.json").read_text()) if resume else []
    if resume and any(r["status"] == "started" or r.get("returncode") is None for r in attempts):
        raise RuntimeError("prior_attempt_not_quiescent")
    completed_ids = {r["id"] for r in attempts}
    orders = [("none", "full", "compact"), ("full", "compact", "none"), ("compact", "none", "full"),
              ("compact", "full", "none"), ("none", "compact", "full"), ("full", "none", "compact")]
    # Only authentication/native Codex runtime inherits the host environment.
    # Other provider credentials cannot be used by the measured tasks.
    env = {k: v for k, v in os.environ.items() if not any(marker in k.upper() for marker in
           ("API_KEY", "ACCESS_TOKEN", "SECRET", "PASSWORD", "ORGBRAIN_"))}
    for block, (repeat, task) in enumerate(itertools.product(range(2), manifest["tasks"])):
        for variant in orders[block]:
            run_id = f"{task['id']}-{repeat + 1}-{variant}"
            if run_id in completed_ids:
                continue
            directory = output / "runs" / run_id
            directory.mkdir(parents=True)
            workspace = runtime / run_id
            shutil.copytree(manifest["snapshot"], workspace)
            record = dict(id=run_id, task=task["id"], repetition=repeat + 1, variant=variant,
                          order=len(attempts) + 1, status="started", model=manifest["model"],
                          effort=manifest["effort"], workspace=str(workspace), actual_usd=None,
                          paid_tool_calls=0, repair_attempts=0)
            attempts.append(record)
            save(output / "attempts.json", attempts)
            memory = ""
            context = None
            context_total_ms = 0
            if variant != "none":
                started = time.monotonic()
                context_run = subprocess.run(["node", str(ROOT / "scripts/memory-efficiency-live-context.mjs"),
                    str(output / "manifest.json"), task["id"], variant, str(directory / "memory.sqlite")],
                    capture_output=True, text=True, timeout=40, env=env, cwd=ROOT)
                context_total_ms = (time.monotonic() - started) * 1000
                (directory / "context.stderr.txt").write_text(context_run.stderr)
                if context_run.returncode:
                    record.update(status="inconclusive", reason="retrieval_process_failed")
                    save(output / "attempts.json", attempts)
                    return
                context = json.loads(context_run.stdout)
                save(directory / "context.json", context)
                memory = "\n過去の作業から得たOrgBrainの参考情報です。現在のソースと適用条件を確認してから使ってください。\n" + context["context"]
            prompt = ("これは許可済みの、独立したリポジトリ保守調査です。この作業ディレクトリのソースだけを確認してください。"
                      "ファイル変更、外部通信、別のエージェント起動、他のセッションや個人の記憶ファイルの参照は不要です。"
                      "現在のソースで必要な事実を確認し、回答は日本語で簡潔にまとめてください。"
                      "citationsには実際に確認した根拠のリポジトリ相対pathと短い正確なソース引用quoteを2件以上含めてください。\n"
                      + task["question"] + memory)
            (directory / "prompt.txt").write_text(prompt)
            argv = ["codex", "-a", "never", "exec", "--ignore-user-config", "--ephemeral", "--json",
                    "--skip-git-repo-check", "-s", "read-only", "-C", str(workspace),
                    "-m", manifest["model"], "-c", 'model_reasoning_effort=' + json.dumps(manifest["effort"]),
                    "-c", "features.memories=false", "--output-schema", str(output / "answer.schema.json"),
                    "-o", str(directory / "answer.json"), "-"]
            if manifest.get("service_tier"):
                argv[1:1] = ["-c", "service_tier=" + json.dumps(manifest["service_tier"])]
            record.update(prompt_sha256=digest(prompt), question_sha256=digest(task["question"]),
                          context_process_ms=context_total_ms, context_retrieval_ms=(context or {}).get("retrieval_ms", 0),
                          context_setup_ms=(context or {}).get("setup_ms", 0),
                          context_returned=(context or {}).get("returned", 0), prompt_bytes=len(prompt.encode()),
                          command=argv, started_at=time.time())
            save(output / "attempts.json", attempts)
            print(json.dumps({"starting": run_id, "order": record["order"], "memories": record["context_returned"]}), flush=True)
            started = time.monotonic()
            process = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                       stderr=subprocess.PIPE, text=True, env=env, start_new_session=True)
            timed_out = False
            try:
                stdout, stderr = process.communicate(input=prompt, timeout=240)
            except subprocess.TimeoutExpired:
                timed_out = True
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    stdout, stderr = process.communicate(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    stdout, stderr = process.communicate()
            elapsed_ms = (time.monotonic() - started) * 1000
            (directory / "events.jsonl").write_text(stdout)
            (directory / "stderr.txt").write_text(stderr)
            events = []
            for line in stdout.splitlines():
                try:
                    events.append(json.loads(line))
                except ValueError:
                    pass
            completed = [row for row in events if row.get("type") == "turn.completed"]
            usage = completed[-1].get("usage") if completed else None
            commands = [row["item"] for row in events if row.get("type") == "item.completed"
                        and row.get("item", {}).get("type") == "command_execution"]
            try:
                answer = json.loads((directory / "answer.json").read_text())
            except (OSError, ValueError):
                answer = None
            citation_failures = evidence_check(answer, workspace)
            record.update(status="observed" if process.returncode == 0 and usage else "inconclusive",
                returncode=process.returncode, timeout=timed_out, cli_elapsed_ms=elapsed_ms,
                elapsed_ms=elapsed_ms + context_total_ms - record["context_setup_ms"],
                elapsed_with_fixture_setup_ms=elapsed_ms + context_total_ms,
                usage=usage, command_calls=len(commands), failed_commands=sum(x.get("exit_code") not in (0, None) for x in commands),
                thread_id=next((x.get("thread_id") for x in events if x.get("type") == "thread.started"), None),
                citation_failures=citation_failures, answer_sha256=digest(json.dumps(answer, ensure_ascii=False)),
                events_sha256=digest(stdout), finished_at=time.time(), acceptance="pending_semantic_review")
            save(output / "attempts.json", attempts)
            print(json.dumps({k: record[k] for k in ("id", "status", "elapsed_ms", "usage", "command_calls", "citation_failures")}), flush=True)
            if record["status"] != "observed" and not (resume and timed_out):
                print(json.dumps({"stopped": run_id, "reason": "cli_infrastructure_or_usage_unavailable"}), flush=True)
                return


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("prepare", "run"))
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--baseline-root", type=Path)
    parser.add_argument("--resume-unattempted", action="store_true")
    args = parser.parse_args()
    if args.operation == "prepare":
        if not args.baseline_root:
            parser.error("prepare requires --baseline-root")
        prepare(args.output.resolve(), args.baseline_root)
    else:
        run(args.output.resolve(), resume=args.resume_unattempted)
